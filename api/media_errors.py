"""Typed errors for the image / video media endpoints.

``MediaError`` subclasses ``ValueError`` so the existing ``except ValueError`` /
``except Exception`` handlers keep working. The endpoint layer maps ``category``
to an HTTP status, a stable string ``code``, and a safe generic Chinese
``message``. Provider response bodies and credentials are never carried on the
exception or the response.
"""

from __future__ import annotations

_STATUS: dict[str, int] = {
    "unconfigured": 503,
    "invalid_input": 422,
    "timeout": 504,
    "provider_failure": 502,
    "bad_response": 502,
}

_CODE: dict[str, str] = {
    "unconfigured": "provider_unconfigured",
    "invalid_input": "invalid_input",
    "timeout": "provider_timeout",
    "provider_failure": "provider_failure",
    "bad_response": "provider_failure",
}


class MediaError(ValueError):
    """A media generation failure with an HTTP-mappable category.

    ``kind`` is ``"image"`` / ``"video"`` / ``"media"`` and only affects the
    user-facing wording. ``detail`` is a short, non-sensitive string for server
    logs only (never the provider body or key).
    """

    def __init__(self, category: str, *, kind: str = "media", detail: str = "") -> None:
        if category not in _STATUS:
            category = "provider_failure"
        self.category = category
        self.kind = kind
        self.detail = detail
        super().__init__(f"media {kind} error: {category}")

    @property
    def http_status(self) -> int:
        return _STATUS[self.category]

    @property
    def code(self) -> str:
        return _CODE[self.category]

    @property
    def safe_message(self) -> str:
        if self.category == "unconfigured":
            if self.kind == "image":
                return "当前未配置图片模型。"
            if self.kind == "video":
                return "当前未配置视频模型。"
            return "当前未配置图片/视频模型。"
        if self.category == "invalid_input":
            return "请求参数无效，请检查后重试。"
        if self.category == "timeout":
            return "模型服务响应超时，请稍后重试。"
        return "模型服务暂时不可用，请稍后重试。"
