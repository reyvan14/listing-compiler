"""Token Plan provider — designated competition model access.

Only the documented OpenAI-compatible **chat-completions** API is integrated
here. Image and video providers are intentionally left untouched: their Token
Plan protocols have not been verified yet.

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

import httpx

logger = logging.getLogger("listing.token_plan")

# Dedicated Token Plan endpoint. The dedicated key MUST be used with this base
# URL; requests to the general ``dashscope.aliyuncs.com`` host do not consume
# Token Plan quota.
DEFAULT_BASE_URL = "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
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
