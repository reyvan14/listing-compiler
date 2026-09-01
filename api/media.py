"""Standalone image/video generation for tldraw media nodes.

Uses OpenAI-compatible poloapi endpoints. Returns data URLs or provider
CDN URLs. Does not call yidooo and does not upload to company R2 / AWS.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import os
from typing import Any

import httpx

from images import generate_prompt_image
from media_errors import MediaError

logger = logging.getLogger("listing.media")


# Seam for tests: overridden to inject an httpx.MockTransport.
def _make_client(timeout: float = 180.0) -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=timeout)


def _video_base() -> str:
    return (
        os.environ.get("LISTING_VIDEO_BASE_URL")
        or os.environ.get("LISTING_IMAGE_BASE_URL")
        or "https://work.poloapi.com/v1"
    ).rstrip("/")


def _video_key() -> str:
    return (
        os.environ.get("LISTING_VIDEO_API_KEY")
        or os.environ.get("LISTING_IMAGE_API_KEY")
        or os.environ.get("GPT_IMAGE_2_API_KEY")
        or ""
    ).strip()


def _video_model() -> str:
    return os.environ.get("LISTING_VIDEO_MODEL", "sora-2")


def _is_company_r2(url: str) -> bool:
    return url.startswith("https://r.klinko.") or url.startswith("https://r.yidooo.")


def _video_size(aspect_ratio: str) -> str:
    return {
        "9:16": "720x1280",
        "16:9": "1280x720",
        "1:1": "720x720",
    }.get(aspect_ratio, "720x1280")


def _duration_seconds(duration: str) -> str:
    digits = "".join(ch for ch in (duration or "") if ch.isdigit())
    return digits or "4"


async def generate_media_image(prompt: str, aspect_ratio: str) -> str:
    return await generate_prompt_image(prompt, aspect_ratio)


def _pick_url(payload: Any) -> str:
    if not isinstance(payload, dict):
        return ""
    for key in ("url", "video_url", "content_url"):
        value = payload.get(key)
        if isinstance(value, str) and value.startswith(("http://", "https://", "data:")):
            return value
    data = payload.get("data")
    if isinstance(data, list) and data:
        return _pick_url(data[0])
    if isinstance(data, dict):
        return _pick_url(data)
    return ""


async def _as_playable(client: httpx.AsyncClient, url: str) -> str:
    if url.startswith("data:"):
        return url
    if _is_company_r2(url):
        logger.warning("video provider returned a company R2 url; dropped category=provider_failure")
        raise MediaError("provider_failure", kind="video", detail="r2 url dropped")
    # Keep provider CDN URLs as-is; only inline small-ish mp4s.
    resp = await client.get(url)
    resp.raise_for_status()
    blob = resp.content
    mime = resp.headers.get("content-type", "video/mp4").split(";")[0] or "video/mp4"
    if len(blob) > 12_000_000:
        return url
    return f"data:{mime};base64,{base64.b64encode(blob).decode('ascii')}"


async def generate_media_video(prompt: str, aspect_ratio: str, duration: str) -> str:
    text = (prompt or "").strip()
    if not text:
        raise MediaError("invalid_input", kind="video", detail="prompt empty")
    key = _video_key()
    if not key:
        raise MediaError("unconfigured", kind="video")
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {key}"}
    body = {
        "model": _video_model(),
        "prompt": text,
        "seconds": _duration_seconds(duration),
        "size": _video_size(aspect_ratio),
    }
    try:
        async with _make_client(180.0) as client:
            created = await client.post(f"{_video_base()}/videos", headers=headers, json=body)
            if created.status_code == 404:
                created = await client.post(f"{_video_base()}/videos/generations", headers=headers, json=body)
            if created.status_code != 200:
                logger.warning(
                    "video provider http error status=%s category=provider_failure", created.status_code
                )
                raise MediaError("provider_failure", kind="video", detail=f"status={created.status_code}")
            payload = created.json() or {}
            direct = _pick_url(payload)
            if direct:
                return await _as_playable(client, direct)

            video_id = payload.get("id") or (payload.get("data") or {}).get("id") if isinstance(payload.get("data"), dict) else payload.get("id")
            if not video_id:
                raise MediaError("bad_response", kind="video", detail="missing id/url")

            for _ in range(36):
                await asyncio.sleep(5)
                status = await client.get(f"{_video_base()}/videos/{video_id}", headers=headers)
                if status.status_code != 200:
                    logger.warning(
                        "video poll http error status=%s category=provider_failure", status.status_code
                    )
                    raise MediaError("provider_failure", kind="video", detail=f"poll status={status.status_code}")
                item = status.json() or {}
                state = str(item.get("status") or "")
                if state in {"failed", "error"}:
                    logger.warning("video provider reported failure category=provider_failure")
                    raise MediaError("provider_failure", kind="video", detail="provider reported failure")
                ready = _pick_url(item)
                if ready or state in {"completed", "succeeded", "success"}:
                    if ready:
                        return await _as_playable(client, ready)
                    content = await client.get(f"{_video_base()}/videos/{video_id}/content", headers=headers)
                    if content.status_code == 200 and content.content:
                        mime = content.headers.get("content-type", "video/mp4").split(";")[0] or "video/mp4"
                        if _is_company_r2(str(content.headers.get("location") or "")):
                            raise MediaError("provider_failure", kind="video", detail="r2 url dropped")
                        if len(content.content) > 12_000_000:
                            raise MediaError("bad_response", kind="video", detail="too large to inline")
                        return f"data:{mime};base64,{base64.b64encode(content.content).decode('ascii')}"
                    raise MediaError("bad_response", kind="video", detail="completed without url")
            logger.warning("video generation timed out category=timeout")
            raise MediaError("timeout", kind="video", detail="poll exhausted")
    except httpx.TimeoutException:
        logger.warning("video provider timeout category=timeout")
        raise MediaError("timeout", kind="video") from None
    except (httpx.RequestError, httpx.HTTPStatusError):
        logger.warning("video provider transport error category=provider_failure")
        raise MediaError("provider_failure", kind="video", detail="transport") from None
