"""Standalone image/video generation for tldraw media nodes.

Two protocols, both kept reachable (see ``token_plan.select_media_provider``):

* legacy     - PoloAPI-style ``POST /videos`` (+ ``/videos/generations``).
* token_plan - Token Plan async ``POST /api/v1/services/aigc/video-generation/
               video-synthesis`` then ``GET /api/v1/tasks/{task_id}`` polling.

Returns data URLs or provider CDN URLs. Does not call yidooo and does not
upload to company R2 / AWS.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import os
import re
from typing import Any

import httpx

from images import generate_prompt_image
from media_errors import MediaError
from token_plan import select_media_provider, token_plan_media_base_url

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
    # TOKEN_PLAN_API_KEY is the production-injected fallback shared with chat and
    # image generation when no video-specific key is configured.
    return (
        os.environ.get("LISTING_VIDEO_API_KEY")
        or os.environ.get("LISTING_IMAGE_API_KEY")
        or os.environ.get("GPT_IMAGE_2_API_KEY")
        or os.environ.get("TOKEN_PLAN_API_KEY")
        or ""
    ).strip()


def _video_provider() -> str:
    """``"token_plan"`` or ``"legacy"`` for the video protocol."""
    return select_media_provider(
        os.environ.get("LISTING_VIDEO_PROVIDER", ""),
        (
            os.environ.get("LISTING_VIDEO_BASE_URL", ""),
            os.environ.get("LISTING_IMAGE_BASE_URL", ""),
        ),
    )


def _video_model() -> str:
    explicit = (os.environ.get("LISTING_VIDEO_MODEL") or "").strip()
    if explicit:
        return explicit
    return "happyhorse-1.1-t2v" if _video_provider() == "token_plan" else "sora-2"


def _video_image_model() -> str:
    """Model for an image-to-video request (a first frame was supplied).

    The text-to-video override (``LISTING_VIDEO_MODEL``) is deliberately not
    consulted here: a t2v model cannot accept a first frame.
    """
    return (os.environ.get("LISTING_VIDEO_IMAGE_MODEL") or "").strip() or "happyhorse-1.1-i2v"


def normalize_first_frame(url: str | None) -> str:
    """The official API accepts HTTP(S) URLs and image data URLs; drop the rest.

    Anything else (a site-relative path, a ``file://`` URL, a non-image data
    URL) is ignored, so the request safely falls back to text-to-video instead
    of sending the provider something it cannot fetch.
    """
    value = (url or "").strip()
    if not value:
        return ""
    lowered = value.lower()
    if lowered.startswith(("http://", "https://")):
        return value
    if lowered.startswith("data:image/"):
        return value
    return ""


def _pos_float_env(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def _token_plan_ratio(aspect_ratio: str) -> str:
    return aspect_ratio if aspect_ratio in {"16:9", "9:16", "1:1"} else "16:9"


def _token_plan_resolution(aspect_ratio: str) -> str:
    override = (os.environ.get("LISTING_VIDEO_RESOLUTION") or "").strip()
    if override:
        return override.upper()
    dims = [int(d) for d in re.findall(r"\d+", _video_size(aspect_ratio))]
    short_side = min(dims) if dims else 720
    return "1080P" if short_side >= 1080 else "720P"


def _token_plan_duration(duration: str) -> int:
    digits = "".join(ch for ch in (duration or "") if ch.isdigit())
    try:
        seconds = int(digits)
    except ValueError:
        seconds = 0
    return seconds if seconds > 0 else 5


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


async def generate_media_video(
    prompt: str,
    aspect_ratio: str,
    duration: str,
    first_frame_url: str | None = None,
) -> str:
    text = (prompt or "").strip()
    if not text:
        raise MediaError("invalid_input", kind="video", detail="prompt empty")
    first_frame = normalize_first_frame(first_frame_url)
    if _video_provider() == "token_plan":
        return await _generate_video_token_plan(text, aspect_ratio, duration, first_frame)
    # The legacy protocol has no image input; behaviour is unchanged.
    return await _generate_video_legacy(text, aspect_ratio, duration)


def _extract_task_id(payload: Any) -> str:
    output = payload.get("output") if isinstance(payload, dict) else None
    task_id = output.get("task_id") if isinstance(output, dict) else None
    return task_id if isinstance(task_id, str) else ""


async def _generate_video_token_plan(
    text: str, aspect_ratio: str, duration: str, first_frame_url: str = ""
) -> str:
    """Token Plan async video-synthesis protocol: submit, then poll the task.

    With a first frame this is an image-to-video request: the i2v model, the
    frame in ``input.media``, and **no** ``parameters.ratio`` — i2v follows the
    source image's ratio, so sending a requested ratio would fight it.
    """
    key = _video_key()
    if not key:
        raise MediaError("unconfigured", kind="video")
    base = token_plan_media_base_url(
        os.environ.get("LISTING_VIDEO_BASE_URL", ""),
        os.environ.get("LISTING_IMAGE_BASE_URL", ""),
    )
    auth = {"Content-Type": "application/json", "Authorization": f"Bearer {key}"}
    parameters: dict[str, Any] = {
        "resolution": _token_plan_resolution(aspect_ratio),
        "duration": _token_plan_duration(duration),
    }
    model_input: dict[str, Any] = {"prompt": text}
    if first_frame_url:
        model_input["media"] = [{"type": "first_frame", "url": first_frame_url}]
    else:
        parameters["ratio"] = _token_plan_ratio(aspect_ratio)
    body = {
        "model": _video_image_model() if first_frame_url else _video_model(),
        "input": model_input,
        "parameters": parameters,
    }
    interval = _pos_float_env("LISTING_VIDEO_POLL_INTERVAL_S", 15.0)
    budget = _pos_float_env("LISTING_VIDEO_POLL_TIMEOUT_S", 600.0)
    attempts = max(1, int(budget / interval)) if interval > 0 else 1
    try:
        async with _make_client(180.0) as client:
            created = await client.post(
                f"{base}/api/v1/services/aigc/video-generation/video-synthesis",
                headers={**auth, "X-DashScope-Async": "enable"},
                json=body,
            )
            if created.status_code != 200:
                logger.warning(
                    "token plan video submit http error status=%s category=provider_failure",
                    created.status_code,
                )
                raise MediaError("provider_failure", kind="video", detail=f"status={created.status_code}")
            try:
                task_id = _extract_task_id(created.json() or {})
            except ValueError:
                raise MediaError("bad_response", kind="video", detail="submit body not json") from None
            if not task_id:
                raise MediaError("bad_response", kind="video", detail="missing task_id")

            for _ in range(attempts):
                await asyncio.sleep(interval)
                polled = await client.get(f"{base}/api/v1/tasks/{task_id}", headers=auth)
                if polled.status_code != 200:
                    logger.warning(
                        "token plan video poll http error status=%s category=provider_failure",
                        polled.status_code,
                    )
                    raise MediaError("provider_failure", kind="video", detail=f"poll status={polled.status_code}")
                try:
                    output = (polled.json() or {}).get("output") or {}
                except ValueError:
                    raise MediaError("bad_response", kind="video", detail="poll body not json") from None
                state = str(output.get("task_status") or "").upper()
                if state == "SUCCEEDED":
                    video_url = output.get("video_url")
                    if not isinstance(video_url, str) or not video_url:
                        raise MediaError("bad_response", kind="video", detail="succeeded without video_url")
                    return await _as_playable(client, video_url)
                if state == "FAILED":
                    logger.warning("token plan video task reported FAILED category=provider_failure")
                    raise MediaError("provider_failure", kind="video", detail="task status=FAILED")
                # PENDING / RUNNING / UNKNOWN / anything else -> keep polling.
            logger.warning("token plan video generation timed out category=timeout")
            raise MediaError("timeout", kind="video", detail="poll exhausted")
    except httpx.TimeoutException:
        logger.warning("token plan video provider timeout category=timeout")
        raise MediaError("timeout", kind="video") from None
    except (httpx.RequestError, httpx.HTTPStatusError):
        logger.warning("token plan video transport error category=provider_failure")
        raise MediaError("provider_failure", kind="video", detail="transport") from None


async def _generate_video_legacy(text: str, aspect_ratio: str, duration: str) -> str:
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
