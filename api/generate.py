"""Try upstream chat, then the Token Plan OpenAI-compatible LLM, then fallback drafts."""

from __future__ import annotations

import asyncio
import json
import re
from typing import Any

import httpx

import token_plan
from checker import apply_checks
from drafts import fallback_drafts
from envutil import upstream, upstream_user
from images import generate_station_images


def listing_prompt(product_name: str, points: str, platforms: list[str]) -> str:
    return f"""You write cross-border listing drafts. Return ONLY JSON, no markdown.
Product: {product_name}
Selling points:
{points}
Platforms: {", ".join(platforms)}
Schema:
{{"drafts":[{{"id":"amazon|tiktok|shopify","title":"string","fields":[{{"label":"string","value":"string"}}]}}]}}
Rules:
- amazon fields: 五点 1..5, 搜索词, 详情规划
- tiktok fields: 描述, 标题长度, 商品视频位, 社交文案
- shopify fields: 长描述, 媒体
- English copy for US. Do not claim certificates. Do not say published.
- Amazon title <= 200 chars. TikTok title 25-200 chars.

TikTok Shop product titles are PRODUCT titles, not social captions. The title must:
- Lead with brand and/or product type, then key factual attributes, then size/capacity.
  Example: "AeroFold Collapsible Silicone Travel Cup, Leak-Proof Lid, Folds to 4.5cm, 350ml"
- Contain NO emoji or pictographs of any kind.
- Contain NO hashtags. Put every hashtag in the separate "社交文案" field instead,
  space separated (leave that field's value empty if there are none).
- Contain NO marketing, promotional or subjective language, and no clickbait opening
  such as "Stop carrying...", "You won't believe...", "Must-have", "Best ever",
  "Meet the...", "Best Seller", "TikTok Exclusive", "20% off", "free shipping".
- Contain none of these symbols: ~ ! * $ ? _ {{ }} < > | ; ^ ¬ ¦
Write the hook copy in the 描述 field if you want one; never in the title.
"""


def _extract_json(text: str) -> Any:
    text = text.strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if fence:
        text = fence.group(1).strip()
    return json.loads(text)


def _normalize_drafts(
    payload: Any,
    *,
    product_name: str,
    points: str,
    asset_mode: str,
    platforms: list[str],
) -> list[dict[str, Any]]:
    drafts = payload.get("drafts") if isinstance(payload, dict) else payload
    if not isinstance(drafts, list):
        raise ValueError("no drafts array")
    out: list[dict[str, Any]] = []
    for item in drafts:
        if not isinstance(item, dict) or item.get("id") not in platforms:
            continue
        if not item.get("title"):
            raise ValueError("draft missing title")
        if not isinstance(item.get("fields"), list):
            item["fields"] = []
        out.append(apply_checks(item, product_name=product_name, points=points, asset_mode=asset_mode))
    if not out:
        raise ValueError("empty drafts after filter")
    return out


async def _chat_completions(url: str, headers: dict[str, str], body: dict[str, Any], timeout: float) -> str:
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(url, headers=headers, json=body)
        resp.raise_for_status()
        data = resp.json()
    content = data.get("choices", [{}])[0].get("message", {}).get("content")
    if not content:
        raise ValueError(f"empty chat content: {str(data)[:200]}")
    if isinstance(content, list):
        content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
    return str(content)


async def try_upstream(product_name: str, points: str, platforms: list[str], asset_mode: str) -> list[dict[str, Any]]:
    content = await _chat_completions(
        f"{upstream()}/api/llm-gateway/v1/chat/completions",
        {"Content-Type": "application/json", "x-user-id": upstream_user()},
        {
            "stream": False,
            "messages": [{"role": "user", "content": listing_prompt(product_name, points, platforms)}],
        },
        90.0,
    )
    return _normalize_drafts(
        _extract_json(content),
        product_name=product_name,
        points=points,
        asset_mode=asset_mode,
        platforms=platforms,
    )


async def try_llm(product_name: str, points: str, platforms: list[str], asset_mode: str) -> list[dict[str, Any]]:
    """Second tier: the Token Plan OpenAI-compatible chat-completions API.

    Config (key / base url / model) is resolved inside ``token_plan``. Raises on
    a missing key, transport failure, HTTP error, or an unparseable response;
    the caller catches it and drops to ``fallback_drafts``.
    """
    content = await token_plan.chat_completion(
        [{"role": "user", "content": listing_prompt(product_name, points, platforms)}],
        model=token_plan.text_model(),
    )
    try:
        payload = _extract_json(content)
        return _normalize_drafts(
            payload,
            product_name=product_name,
            points=points,
            asset_mode=asset_mode,
            platforms=platforms,
        )
    except Exception as exc:
        # Never let raw model output reach logs via a chained exception repr
        # (e.g. json.JSONDecodeError carries the full document in .args).
        raise RuntimeError(
            f"token plan response could not be parsed into drafts ({type(exc).__name__})"
        ) from None


async def _text_drafts(
    product_name: str,
    points: str,
    platforms: list[str],
    asset_mode: str,
) -> tuple[list[dict[str, Any]], str]:
    if upstream():
        try:
            return await try_upstream(product_name, points, platforms, asset_mode), "upstream"
        except Exception as exc:
            print(f"[listing] upstream skipped: {type(exc).__name__}: {exc!r}", flush=True)
    else:
        print("[listing] upstream skipped: LISTING_UPSTREAM_URL not set", flush=True)
    try:
        return await try_llm(product_name, points, platforms, asset_mode), "llm"
    except Exception as exc:
        print(f"[listing] token-plan skipped: {type(exc).__name__}: {exc!r}", flush=True)
    return fallback_drafts(product_name, points, asset_mode, platforms), "fallback"


def _attach_images(drafts: list[dict[str, Any]], images: dict[str, str]) -> list[dict[str, Any]]:
    white = images.get("white") or ""
    lifestyle = images.get("lifestyle") or ""
    for draft in drafts:
        url = lifestyle if draft.get("id") == "shopify" else white
        if url:
            draft["imageUrl"] = url
    return drafts


async def generate_drafts(
    product_name: str,
    points: str,
    platforms: list[str],
    asset_mode: str,
    uploads: list[str] | None = None,
) -> tuple[list[dict[str, Any]], str]:
    text_job = _text_drafts(product_name, points, platforms, asset_mode)
    image_job = generate_station_images(product_name, points, uploads or [])
    text_result, images = await asyncio.gather(text_job, image_job, return_exceptions=True)
    if isinstance(text_result, Exception):
        print(f"[listing] text failed: {text_result!r}", flush=True)
        drafts, source = fallback_drafts(product_name, points, asset_mode, platforms), "fallback"
    else:
        drafts, source = text_result
    if isinstance(images, Exception):
        print(f"[listing] images failed: {images!r}", flush=True)
        images = {}
    if images:
        print(f"[listing] images ready: {list(images)}", flush=True)
    return _attach_images(drafts, images if isinstance(images, dict) else {}), source
