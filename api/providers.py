"""What each configured provider can actually do.

The temptation with a multimodal feature is to send a reference image and hope:
if the provider ignores the field, nothing visibly breaks, and the UI happily
says "reference image used". That is a lie with no error message attached.

So capabilities are declared, not assumed. A capability is true only where the
provider's documented request format has a place to put the thing. Callers ask
before they build a request, the UI asks before it claims anything happened,
and a provider without ``supports_reference_image`` never receives an invented
field -- there is no code path that adds one speculatively.

Nothing here reads a credential value. It reads whether one is *configured*,
which is a different fact and safe to report.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any

import ocr


@dataclass(frozen=True)
class ProviderCapabilities:
    """One provider protocol's documented abilities."""

    provider: str
    #: Text chat completions.
    supports_text: bool = False
    #: Accepts images as *input* for understanding (vision).
    supports_vision: bool = False
    #: Accepts a source image to condition generation on.
    supports_reference_image: bool = False
    #: Reads text out of images.
    supports_ocr: bool = False
    #: Produces still images.
    supports_image_generation: bool = False
    #: Produces video.
    supports_video_generation: bool = False
    #: Text-to-speech.
    supports_tts: bool = False
    #: Streamed responses.
    supports_streaming: bool = False
    #: Documented request field carrying the reference image, when supported.
    reference_image_field: str = ""
    notes: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "supports_text": self.supports_text,
            "supports_vision": self.supports_vision,
            "supports_reference_image": self.supports_reference_image,
            "supports_ocr": self.supports_ocr,
            "supports_image_generation": self.supports_image_generation,
            "supports_video_generation": self.supports_video_generation,
            "supports_tts": self.supports_tts,
            "supports_streaming": self.supports_streaming,
            "reference_image_field": self.reference_image_field,
            "notes": self.notes,
        }


#: Declared per protocol, from each provider's documented request format.
#:
#: ``legacy`` is the OpenAI-compatible ``/images/generations`` shape this project
#: already speaks. That endpoint takes a prompt and a size; it has no documented
#: field for a source image in the form this client uses, so reference images are
#: declared unsupported rather than smuggled into an undocumented key.
#:
#: ``token_plan`` is the dedicated multimodal-generation endpoint. Its request
#: body carries ``content`` parts that may include an image, which is what makes
#: image conditioning and vision genuinely available there.
_DECLARED: dict[str, ProviderCapabilities] = {
    "legacy": ProviderCapabilities(
        provider="legacy",
        supports_text=True,
        supports_image_generation=True,
        supports_streaming=True,
        notes=(
            "OpenAI 兼容协议。本项目使用的 /images/generations 请求体没有参考图字段，"
            "因此不声称支持图生图；不会为它编造参数。"
        ),
    ),
    "token_plan": ProviderCapabilities(
        provider="token_plan",
        supports_text=True,
        supports_vision=True,
        supports_reference_image=True,
        supports_image_generation=True,
        supports_video_generation=True,
        supports_streaming=True,
        reference_image_field="content[].image",
        notes=(
            "Token Plan 多模态生成协议：请求体的 content 数组可携带 image 部分，"
            "因此参考图与视觉理解是有文档依据的能力。"
        ),
    ),
    "none": ProviderCapabilities(
        provider="none",
        notes="未配置任何模型服务：走本地确定性回退，不产生任何外部请求。",
    ),
}


def declared(provider: str) -> ProviderCapabilities:
    return _DECLARED.get(provider or "", _DECLARED["none"])


def _configured(*names: str) -> bool:
    return any((os.environ.get(name) or "").strip() for name in names)


def image_provider() -> str:
    """The image protocol in effect, or ``"none"`` when unconfigured."""
    if not _configured("LISTING_IMAGE_API_KEY", "GPT_IMAGE_2_API_KEY", "TOKEN_PLAN_API_KEY"):
        return "none"
    import images

    return images._image_provider()


def video_provider() -> str:
    if not _configured("LISTING_VIDEO_API_KEY", "TOKEN_PLAN_API_KEY"):
        return "none"
    import media

    return media._video_provider()


def text_provider() -> str:
    if _configured("TOKEN_PLAN_API_KEY"):
        return "token_plan"
    if _configured("LISTING_LLM_API_KEY", "LISTING_UPSTREAM_URL"):
        return "legacy"
    return "none"


def snapshot() -> dict[str, Any]:
    """Everything the UI needs to describe, honestly, what this build can do.

    OCR is reported from the engine that is actually installed rather than from
    a provider declaration, because OCR here is a local binary and not a remote
    service: whether it works is a fact about this machine.
    """
    text = declared(text_provider())
    image = declared(image_provider())
    video = declared(video_provider())
    ocr_capability = ocr.capability()

    return {
        "text": text.as_dict(),
        "image": image.as_dict(),
        "video": video.as_dict(),
        "ocr": ocr_capability,
        "reference_image": {
            "supported": image.supports_reference_image,
            "field": image.reference_image_field,
            "reason": (
                ""
                if image.supports_reference_image
                else "当前图片服务的请求格式没有参考图字段，上传图不会被用于图生图。"
            ),
        },
        "vision": {
            "supported": text.supports_vision,
            "reason": (
                "" if text.supports_vision else "当前文本服务不支持图片理解，图片内容不会进入生成。"
            ),
        },
    }


def reference_image_supported() -> bool:
    """Whether an uploaded image may legitimately condition generation."""
    return declared(image_provider()).supports_reference_image


def assert_no_invented_fields(payload: dict[str, Any], provider_name: str) -> None:
    """Guard: refuse to send a capability field a provider never documented.

    Called on the way out, so a future edit that adds a reference image to a
    legacy request fails loudly here instead of silently doing nothing at the
    provider and reporting success to the operator.
    """
    capability = declared(provider_name)
    if capability.supports_reference_image:
        return
    banned = ("reference_image", "image_url", "init_image", "source_image", "ref_image")
    found = sorted(k for k in _walk_keys(payload) if k in banned)
    if found:
        raise ValueError(
            f"provider {provider_name!r} does not document reference images; "
            f"refusing to send {found}"
        )


def _walk_keys(value: Any) -> list[str]:
    out: list[str] = []
    if isinstance(value, dict):
        for key, child in value.items():
            out.append(str(key))
            out.extend(_walk_keys(child))
    elif isinstance(value, list):
        for item in value:
            out.extend(_walk_keys(item))
    return out
