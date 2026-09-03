"""Token Plan provider — designated competition model access.

This module owns the OpenAI-compatible **chat-completions** client plus the
shared helpers that let ``images.py`` / ``media.py`` choose between the legacy
OpenAI-compatible providers and the Token Plan native image / video protocols
(``select_media_provider`` / ``token_plan_media_base_url``). The media request
and response handling itself lives in those two modules.

Security / logging rules enforced by this module:

* The API key is read from the environment at call time and is never stored in
  logs, exceptions, return values, or module-level state.
* On failure we log only: a generated request id, the HTTP status code, and an
  error category.
* Authorization headers, API keys, prompts, request bodies, and model responses
  are never logged.
* Callers receive a :class:`TokenPlanError` whose ``str()`` is safe to log and
  safe to turn into a generic user-facing message.
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from typing import Any
from urllib.parse import urlsplit

import httpx

logger = logging.getLogger("listing.token_plan")

# Dedicated Token Plan endpoint. The dedicated key MUST be used with this base
# URL; requests to the general ``dashscope.aliyuncs.com`` host do not consume
# Token Plan quota.
DEFAULT_BASE_URL = "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
# Dedicated Token Plan MaaS host for the native image / video (DashScope-style)
# protocols. The chat integration above uses ``/compatible-mode/v1``; media uses
# the native ``/api/v1/services/aigc/...`` paths on this same host.
TOKEN_PLAN_MEDIA_HOST = "token-plan.cn-beijing.maas.aliyuncs.com"
TOKEN_PLAN_MEDIA_BASE_URL = f"https://{TOKEN_PLAN_MEDIA_HOST}"
DEFAULT_TEXT_MODEL = "qwen3.7-plus"
DEFAULT_AGENT_MODEL = "qwen3.7-plus"
DEFAULT_TIMEOUT_S = 60.0
DEFAULT_CONNECT_TIMEOUT_S = 10.0

_GENERAL_DASHSCOPE_HOST = "dashscope.aliyuncs.com"

# Error categories used in logs and on TokenPlanError.category.
#   config           - missing key / base url / empty messages (caller/setup error)
#   timeout          - connect or read timeout
#   network          - other transport failure (DNS, connection reset, ...)
#   http_status      - non-2xx HTTP response
#   invalid_response - 2xx but body is not usable (bad JSON / no content)


class TokenPlanError(RuntimeError):
    """Raised when a Token Plan chat call cannot produce a valid response.

    Carries only a non-sensitive summary. ``str(err)`` never contains the API
    key, request or response bodies, prompts, or model output.
    """

    def __init__(
        self,
        category: str,
        *,
        request_id: str,
        status: int | None = None,
        hint: str = "",
    ) -> None:
        self.category = category
        self.request_id = request_id
        self.status = status
        message = (
            f"token plan chat failed "
            f"(category={category}, status={status}, request_id={request_id})"
        )
        if hint:
            message = f"{message}: {hint}"
        super().__init__(message)


# ---------------------------------------------------------------------------
# Configuration. Read from the environment on every call so that a redeploy or a
# test monkeypatch takes effect without re-importing. Legacy ``LISTING_LLM_*``
# variables remain honoured so existing deployments keep working; the
# ``TOKEN_PLAN_*`` variables take precedence.
# ---------------------------------------------------------------------------


def _first_env(*names: str, default: str = "") -> str:
    for name in names:
        value = os.environ.get(name)
        if value and value.strip():
            return value.strip()
    return default


def _float_env(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def api_key() -> str:
    """Token Plan API key. Never logged or echoed."""
    return _first_env("TOKEN_PLAN_API_KEY", "LISTING_LLM_API_KEY")


def base_url() -> str:
    return _first_env(
        "TOKEN_PLAN_BASE_URL", "LISTING_LLM_BASE_URL", default=DEFAULT_BASE_URL
    ).rstrip("/")


def text_model() -> str:
    """Model for listing-draft generation."""
    return _first_env("TOKEN_PLAN_TEXT_MODEL", "LISTING_LLM_MODEL", default=DEFAULT_TEXT_MODEL)


def agent_model() -> str:
    """Model for the station agent chat."""
    return _first_env(
        "TOKEN_PLAN_AGENT_MODEL",
        "TOKEN_PLAN_TEXT_MODEL",
        "LISTING_LLM_MODEL",
        default=DEFAULT_AGENT_MODEL,
    )


def is_configured() -> bool:
    return bool(api_key())


# ---------------------------------------------------------------------------
# Media (image / video) protocol selection. Shared by ``images.py`` and
# ``media.py`` so both the OpenAI-compatible "legacy" providers and the Token
# Plan native protocol stay reachable from the same deployment.
# ---------------------------------------------------------------------------

_TOKEN_PLAN_PROVIDER_ALIASES = {"token_plan", "tokenplan", "token-plan", "tp"}
_LEGACY_PROVIDER_ALIASES = {"legacy", "openai", "polo", "poloapi", "old"}


def is_token_plan_host(url: str) -> bool:
    """True when *url* targets the dedicated Token Plan MaaS host."""
    return "token-plan." in (url or "").lower()


def _origin(url: str) -> str:
    """Return ``scheme://host`` for *url*, dropping any path such as
    ``/compatible-mode/v1``. Falls back to the trimmed input when unparsable."""
    parts = urlsplit((url or "").strip())
    if parts.scheme and parts.netloc:
        return f"{parts.scheme}://{parts.netloc}"
    return (url or "").strip().rstrip("/")


def select_media_provider(explicit: str, base_urls: "list[str] | tuple[str, ...]") -> str:
    """Pick ``"token_plan"`` or ``"legacy"`` for an image / video call.

    Resolution order, deliberately not a fragile single check:

    1. An explicit ``LISTING_IMAGE_PROVIDER`` / ``LISTING_VIDEO_PROVIDER`` value
       (``token_plan`` or ``legacy``; case and punctuation insensitive) wins.
    2. Otherwise, if any configured base URL is on the Token Plan host, use the
       Token Plan native protocol.
    3. Otherwise fall back to the legacy OpenAI-compatible protocol.
    """
    choice = (explicit or "").strip().lower().replace(" ", "")
    if choice in _TOKEN_PLAN_PROVIDER_ALIASES:
        return "token_plan"
    if choice in _LEGACY_PROVIDER_ALIASES:
        return "legacy"
    for url in base_urls:
        if url and is_token_plan_host(url):
            return "token_plan"
    return "legacy"


def token_plan_media_base_url(*candidate_urls: str) -> str:
    """Base URL (``scheme://host``, no path) for Token Plan media endpoints.

    ``TOKEN_PLAN_MEDIA_BASE_URL`` overrides everything (handy for tests). Failing
    that, the origin of any caller-supplied base URL already on the Token Plan
    host is reused; otherwise the documented dedicated host is used.
    """
    explicit = _first_env("TOKEN_PLAN_MEDIA_BASE_URL")
    if explicit:
        return _origin(explicit)
    for url in candidate_urls:
        if url and is_token_plan_host(url):
            return _origin(url)
    return TOKEN_PLAN_MEDIA_BASE_URL


def _resolve_timeout(timeout: "httpx.Timeout | float | None") -> httpx.Timeout:
    if isinstance(timeout, httpx.Timeout):
        return timeout
    if isinstance(timeout, (int, float)) and timeout > 0:
        return httpx.Timeout(float(timeout))
    read = _float_env("TOKEN_PLAN_TIMEOUT_S", DEFAULT_TIMEOUT_S)
    connect = _float_env("TOKEN_PLAN_CONNECT_TIMEOUT_S", DEFAULT_CONNECT_TIMEOUT_S)
    return httpx.Timeout(read, connect=connect)


def _endpoint(base: str) -> str:
    return base if base.endswith("/chat/completions") else f"{base}/chat/completions"


def _new_request_id() -> str:
    return uuid.uuid4().hex[:12]


# Seam for tests: overridden to inject an ``httpx.MockTransport``.
def _make_client(timeout: httpx.Timeout) -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=timeout)


def _extract_content(data: Any) -> str:
    """Pull the assistant text out of an OpenAI-compatible response.

    Returns ``""`` for any unexpected shape, including a message that only
    carries ``reasoning_content`` (some models stream reasoning by default and
    respond more slowly) — the caller then falls back rather than surfacing an
    empty draft.
    """
    if not isinstance(data, dict):
        return ""
    choices = data.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    first = choices[0]
    message = first.get("message") if isinstance(first, dict) else None
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    if isinstance(content, list):
        content = "".join(
            part.get("text", "") for part in content if isinstance(part, dict)
        )
    if content is None:
        return ""
    return str(content)


async def chat_completion(
    messages: list[dict[str, Any]],
    *,
    model: str | None = None,
    timeout: "httpx.Timeout | float | None" = None,
) -> str:
    """Call the Token Plan OpenAI-compatible chat-completions endpoint.

    Returns the assistant message text (non-empty, stripped).

    Raises :class:`TokenPlanError` on any configuration, transport, HTTP, or
    response-validation problem. The exception is safe to log and safe to
    convert into a generic user-facing message; it never carries the key,
    the prompt, the request body, or the model output.
    """
    request_id = _new_request_id()

    if not isinstance(messages, list) or not messages:
        raise TokenPlanError("config", request_id=request_id, hint="empty messages")

    key = api_key()
    if not key:
        raise TokenPlanError(
            "config", request_id=request_id, hint="TOKEN_PLAN_API_KEY not set"
        )

    base = base_url()
    if not base:
        raise TokenPlanError("config", request_id=request_id, hint="base url not set")
    if _GENERAL_DASHSCOPE_HOST in base:
        # Operator-configurable, so not a hard failure, but flag it: the
        # dedicated key must be paired with the dedicated base URL or the
        # Token Plan quota is not consumed.
        logger.warning(
            "token_plan base url uses the general dashscope host; "
            "Token Plan quota will not be consumed request_id=%s",
            request_id,
        )

    payload = {
        "model": model or text_model(),
        "messages": messages,
        "stream": False,
    }
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }

    try:
        async with _make_client(_resolve_timeout(timeout)) as client:
            resp = await client.post(_endpoint(base), headers=headers, json=payload)
    except httpx.TimeoutException:
        logger.warning(
            "token_plan request failed request_id=%s status=%s category=%s",
            request_id, None, "timeout",
        )
        raise TokenPlanError("timeout", request_id=request_id) from None
    except httpx.RequestError:
        logger.warning(
            "token_plan request failed request_id=%s status=%s category=%s",
            request_id, None, "network",
        )
        raise TokenPlanError("network", request_id=request_id) from None

    status = resp.status_code
    if status < 200 or status >= 300:
        logger.warning(
            "token_plan request failed request_id=%s status=%s category=%s",
            request_id, status, "http_status",
        )
        raise TokenPlanError("http_status", request_id=request_id, status=status) from None

    try:
        data = resp.json()
    except (json.JSONDecodeError, ValueError):
        logger.warning(
            "token_plan request failed request_id=%s status=%s category=%s",
            request_id, status, "invalid_response",
        )
        raise TokenPlanError(
            "invalid_response", request_id=request_id, status=status, hint="body not json"
        ) from None

    content = _extract_content(data).strip()
    if not content:
        logger.warning(
            "token_plan request failed request_id=%s status=%s category=%s",
            request_id, status, "invalid_response",
        )
        raise TokenPlanError(
            "invalid_response", request_id=request_id, status=status, hint="no message content"
        ) from None

    logger.info("token_plan request ok request_id=%s status=%s", request_id, status)
    return content


# --------------------------------------------------------------------------- #
# Streaming chat completions                                                   #
#                                                                              #
# Same endpoint and same credentials as ``chat_completion``, with              #
# ``stream: true``. The provider answers with an SSE body whose frames may be  #
# split across arbitrary network chunks, so the parser below is byte-boundary  #
# agnostic: it buffers until it sees a frame terminator and never assumes a    #
# chunk contains a whole frame — or only one.                                  #
#                                                                              #
# The same logging rules apply: no prompts, no output text, no key, no headers.#
# --------------------------------------------------------------------------- #

#: Frames are separated by a blank line. Providers differ on line endings, so
#: both are accepted and CR is stripped before parsing.
_SSE_TERMINATORS = ("\r\n\r\n", "\n\n")


def iter_sse_frames(buffer: str) -> "tuple[list[str], str]":
    """Split *buffer* into complete SSE frames plus the unconsumed remainder.

    Pure and synchronous so the fragmentation behaviour can be tested directly
    without a transport. A frame is everything up to the first blank line.
    """
    frames: list[str] = []
    while True:
        cut = -1
        width = 0
        for terminator in _SSE_TERMINATORS:
            found = buffer.find(terminator)
            if found != -1 and (cut == -1 or found < cut):
                cut, width = found, len(terminator)
        if cut == -1:
            return frames, buffer
        frames.append(buffer[:cut])
        buffer = buffer[cut + width :]


def sse_frame_data(frame: str) -> str:
    """Concatenate the ``data:`` lines of one SSE frame.

    Comment lines (``:`` heartbeats) and unknown fields are ignored, which is
    what the SSE spec requires and what keeps provider heartbeats harmless.
    """
    parts: list[str] = []
    for line in frame.replace("\r\n", "\n").split("\n"):
        if not line or line.startswith(":"):
            continue
        if line.startswith("data:"):
            parts.append(line[5:].lstrip())
    return "\n".join(parts)


def _delta_text(payload: Any) -> str:
    """Assistant text out of one streamed chunk.

    ``reasoning_content`` is deliberately ignored: the product must never render
    or store the model's hidden reasoning, so it is dropped at the boundary
    rather than filtered later.
    """
    if not isinstance(payload, dict):
        return ""
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    first = choices[0]
    if not isinstance(first, dict):
        return ""
    delta = first.get("delta")
    if not isinstance(delta, dict):
        # Some providers repeat the full message on the terminal chunk.
        message = first.get("message")
        delta = message if isinstance(message, dict) else {}
    content = delta.get("content")
    if isinstance(content, list):
        content = "".join(p.get("text", "") for p in content if isinstance(p, dict))
    if content is None:
        return ""
    return str(content)


async def chat_completion_stream(
    messages: list[dict[str, Any]],
    *,
    model: str | None = None,
    timeout: "httpx.Timeout | float | None" = None,
):
    """Yield assistant text fragments from a streaming chat completion.

    Raises :class:`TokenPlanError` with the same categories and the same
    sanitized ``str()`` as :func:`chat_completion`.

    Cancellation of the consuming task propagates into the httpx stream: the
    ``async with`` blocks below unwind and close the connection, so a user who
    presses 停止 actually stops the upstream request rather than leaving it
    running to completion.
    """
    request_id = _new_request_id()

    if not isinstance(messages, list) or not messages:
        raise TokenPlanError("config", request_id=request_id, hint="empty messages")

    key = api_key()
    if not key:
        raise TokenPlanError(
            "config", request_id=request_id, hint="TOKEN_PLAN_API_KEY not set"
        )

    base = base_url()
    if not base:
        raise TokenPlanError("config", request_id=request_id, hint="base url not set")

    payload = {
        "model": model or agent_model(),
        "messages": messages,
        "stream": True,
    }
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
    }

    produced = 0
    try:
        async with _make_client(_resolve_timeout(timeout)) as client:
            async with client.stream(
                "POST", _endpoint(base), headers=headers, json=payload
            ) as resp:
                status = resp.status_code
                if status < 200 or status >= 300:
                    # Drain so the connection can be reused/closed cleanly. The
                    # body may carry provider detail; it is never logged.
                    await resp.aread()
                    logger.warning(
                        "token_plan stream failed request_id=%s status=%s category=%s",
                        request_id, status, "http_status",
                    )
                    raise TokenPlanError(
                        "http_status", request_id=request_id, status=status
                    )

                buffer = ""
                async for chunk in resp.aiter_text():
                    if not chunk:
                        continue
                    buffer += chunk
                    frames, buffer = iter_sse_frames(buffer)
                    for frame in frames:
                        data = sse_frame_data(frame)
                        if not data:
                            continue
                        if data.strip() == "[DONE]":
                            logger.info(
                                "token_plan stream ok request_id=%s status=%s",
                                request_id, status,
                            )
                            return
                        try:
                            parsed = json.loads(data)
                        except (json.JSONDecodeError, ValueError):
                            # A malformed chunk is skipped, not fatal: the rest
                            # of the stream is usually fine and the caller has
                            # already shown the user real text.
                            continue
                        text = _delta_text(parsed)
                        if text:
                            produced += len(text)
                            yield text

                # The provider ended without [DONE]. Trailing bytes may still
                # hold one unterminated frame.
                tail = sse_frame_data(buffer)
                if tail and tail.strip() != "[DONE]":
                    try:
                        text = _delta_text(json.loads(tail))
                    except (json.JSONDecodeError, ValueError):
                        text = ""
                    if text:
                        produced += len(text)
                        yield text
    except TokenPlanError:
        raise
    except httpx.TimeoutException:
        logger.warning(
            "token_plan stream failed request_id=%s status=%s category=%s produced=%s",
            request_id, None, "timeout", bool(produced),
        )
        raise TokenPlanError("timeout", request_id=request_id) from None
    except httpx.RequestError:
        logger.warning(
            "token_plan stream failed request_id=%s status=%s category=%s produced=%s",
            request_id, None, "network", bool(produced),
        )
        raise TokenPlanError("network", request_id=request_id) from None

    if produced == 0:
        logger.warning(
            "token_plan stream failed request_id=%s status=%s category=%s",
            request_id, None, "invalid_response",
        )
        raise TokenPlanError(
            "invalid_response", request_id=request_id, hint="no streamed content"
        )
    logger.info("token_plan stream ok request_id=%s", request_id)
