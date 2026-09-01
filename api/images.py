"""Generate listing stills via OpenAI-compatible /images/generations.

Returns data URLs only. Does not call yidooo unified-image-generation
and does not upload to company R2 / OSS.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import os
import httpx

from media_errors import MediaError

logger = logging.getLogger("listing.images")


# Seam for tests: overridden to inject an httpx.MockTransport.
def _make_client(timeout: float = 180.0) -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=timeout)


def _image_base() -> str:
    return os.environ.get("LISTING_IMAGE_BASE_URL", "https://work.poloapi.com/v1").rstrip("/")


def _image_key() -> str:
    return (
        os.environ.get("LISTING_IMAGE_API_KEY")
        or os.environ.get("GPT_IMAGE_2_API_KEY")
        or ""
    ).strip()


def _image_model() -> str:
    return os.environ.get("LISTING_IMAGE_MODEL", "gpt-image-2-c")


def _white_prompt(product_name: str, points: str) -> str:
    return (
        f"E-commerce Amazon main image of {product_name or 'a collapsible silicone travel cup'}. "
        f"Selling points: {points or '350ml, leak-proof lid, food-grade silicone'}. "
        "Pure white RGB 255,255,255 background, product centered, about 85 percent of the frame, "
        "no text, no logo, no watermark, no people, studio lighting, photorealistic, sharp edges."
    )


def _lifestyle_prompt(product_name: str, points: str) -> str:
    return (
        f"Lifestyle photo of {product_name or 'a collapsible silicone travel cup'} "
        "on a wooden desk beside a laptop, natural daylight, brand-site mood. "
        f"Details: {points or 'folds flat, leak-proof, 350ml'}. "
        "No promotional text, no logo overlay, photorealistic."
    )


def _as_data_url(raw_b64: str) -> str:
    blob = raw_b64.strip()
    if blob.startswith("data:image/"):
        return blob
    return f"data:image/png;base64,{blob}"


async def _bytes_to_data_url(client: httpx.AsyncClient, url: str) -> str:
    resp = await client.get(url)
    resp.raise_for_status()
    mime = resp.headers.get("content-type", "image/png").split(";")[0] or "image/png"
    return f"data:{mime};base64,{base64.b64encode(resp.content).decode('ascii')}"


async def _generate_one(kind: str, prompt: str, size: str) -> tuple[str, str]:
    key = _image_key()
    if not key:
        raise MediaError("unconfigured", kind="image")
    try:
        async with _make_client(180.0) as client:
            resp = await client.post(
                f"{_image_base()}/images/generations",
                headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
                json={"model": _image_model(), "prompt": prompt, "n": 1, "size": size},
            )
            if resp.status_code != 200:
                # Never surface the provider body; log the status only.
                logger.warning(
                    "image provider http error kind=%s status=%s category=provider_failure",
                    kind, resp.status_code,
                )
                raise MediaError("provider_failure", kind="image", detail=f"status={resp.status_code}")
            try:
                items = (resp.json() or {}).get("data") or []
            except ValueError:
                raise MediaError("bad_response", kind="image", detail="body not json") from None
            if not items:
                raise MediaError("bad_response", kind="image", detail="empty data")
            item = items[0] if isinstance(items[0], dict) else {}
            if item.get("b64_json"):
                return kind, _as_data_url(str(item["b64_json"]))
            remote = item.get("url") or ""
            if remote:
                return kind, await _bytes_to_data_url(client, str(remote))
            raise MediaError("bad_response", kind="image", detail="missing b64_json/url")
    except httpx.TimeoutException:
        logger.warning("image provider timeout kind=%s category=timeout", kind)
        raise MediaError("timeout", kind="image") from None
    except (httpx.RequestError, httpx.HTTPStatusError):
        logger.warning("image provider transport error kind=%s category=provider_failure", kind)
        raise MediaError("provider_failure", kind="image", detail="transport") from None


def size_for_aspect(aspect_ratio: str) -> str:
    return {
        "1:1": "1024x1024",
        "16:9": "1792x1024",
        "9:16": "1024x1792",
        "4:3": "1024x1024",
        "3:4": "1024x1024",
        "3:2": "1536x1024",
        "2:3": "1024x1536",
        "21:9": "1792x1024",
    }.get(aspect_ratio, "1024x1024")


def _is_company_r2(url: str) -> bool:
    return url.startswith("https://r.klinko.") or url.startswith("https://r.yidooo.")


async def generate_prompt_image(prompt: str, aspect_ratio: str = "1:1") -> str:
    text = (prompt or "").strip()
    if not text:
        raise MediaError("invalid_input", kind="image", detail="prompt empty")
    if not _image_key():
        raise MediaError("unconfigured", kind="image")
    size = size_for_aspect(aspect_ratio)
    try:
        _, url = await _generate_one("custom", text, size)
    except MediaError as exc:
        # Only retry a transient failure at a different size; never retry an
        # unconfigured / invalid-input error.
        if size == "1024x1024" or exc.category in ("unconfigured", "invalid_input"):
            raise
        _, url = await _generate_one("custom", text, "1024x1024")
    if _is_company_r2(url):
        logger.warning("image provider returned a company R2 url; dropped category=provider_failure")
        raise MediaError("provider_failure", kind="image", detail="r2 url dropped")
    return url


async def generate_station_images(
    product_name: str,
    points: str,
    uploads: list[str],
) -> dict[str, str]:
    del uploads
    if not _image_key():
        print("[listing] image skipped: LISTING_IMAGE_API_KEY not set", flush=True)
        return {}
    jobs = [
        ("white", _white_prompt(product_name, points), "1024x1024"),
        ("lifestyle", _lifestyle_prompt(product_name, points), "1024x1024"),
    ]
    results = await asyncio.gather(
        *(_generate_one(kind, prompt, size) for kind, prompt, size in jobs),
        return_exceptions=True,
    )
    out: dict[str, str] = {}
    for item in results:
        if isinstance(item, Exception):
            print(f"[listing] image skipped: {type(item).__name__}: {item!r}", flush=True)
            continue
        kind, url = item
        if url.startswith("https://r.klinko.") or url.startswith("https://r.yidooo."):
            print(f"[listing] image dropped R2 url for {kind}", flush=True)
            continue
        out[kind] = url
        print(f"[listing] image {kind} ready data-url {len(url)} chars", flush=True)
    return out
