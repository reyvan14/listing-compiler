"""Image compliance inspection driven by the actual image bytes.

Every number this module reports is measured from a decoded image. Nothing is
inferred from a filename, a generation prompt, an asset mode, or the fact that
we asked a provider for a white background. Asking for white and getting white
are different events, and only the second one is evidence.

Where a rule genuinely cannot be settled from pixels alone -- "is the product
85% of the frame", "is there a logo overlaid", "is this the right product" --
the result is ``manual_review``, never a quiet pass. That distinction is the
point of the module: a checklist that turns unverifiable requirements into
green ticks is worse than no checklist, because it launders an assumption into
a record.

Deterministic and offline: Pillow decodes, the sampling grid is fixed, and no
provider is contacted. The same bytes always produce the same verdicts.
"""

from __future__ import annotations

import hashlib
import io
import logging
from datetime import datetime, timezone
from math import gcd
from typing import Any

from PIL import Image, ImageFile, UnidentifiedImageError

import policy

logger = logging.getLogger("listing.imagecheck")

#: A truncated file must be an error, not a half-decoded image we then measure.
ImageFile.LOAD_TRUNCATED_IMAGES = False

#: Version stamps recorded on every record, so an old result is never mistaken
#: for one produced by today's logic.
DECODE_METHOD = "pillow-decode/v1"
BACKGROUND_METHOD = "border-sample-median/v1"

#: Upload ceiling, matched to the evidence store so one limit governs uploads.
MAX_IMAGE_BYTES = 20 * 1024 * 1024
#: Decompression-bomb guard: a 100 MP "image" is a denial of service, not a photo.
MAX_PIXELS = 50_000_000

#: Formats we are willing to decode at all. Derived from the bytes by Pillow's
#: own sniffing, never from the filename or the browser-declared type.
DECODABLE_FORMATS: dict[str, str] = {
    "PNG": "image/png",
    "JPEG": "image/jpeg",
    "WEBP": "image/webp",
    "GIF": "image/gif",
    "TIFF": "image/tiff",
    "BMP": "image/bmp",
}

# Result states ------------------------------------------------------------- #

PASS = "pass"
FAIL = "fail"
WARNING = "warning"
MANUAL_REVIEW = "manual_review"
UNAVAILABLE = "unavailable"

RESULT_STATES = (PASS, FAIL, WARNING, MANUAL_REVIEW, UNAVAILABLE)

#: States that must never be summarised as "this image is fine".
UNSETTLED = (MANUAL_REVIEW, UNAVAILABLE)


class ImageInspectionError(ValueError):
    """Rejected image. ``safe_message`` is safe to show a user."""

    def __init__(self, code: str, message: str, status: int = 400) -> None:
        self.code = code
        self.safe_message = message
        self.http_status = status
        super().__init__(message)


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


# --------------------------------------------------------------------------- #
# Decoding                                                                     #
# --------------------------------------------------------------------------- #


def aspect_ratio_label(width: int, height: int) -> str:
    """``1:1``, ``4:3``, ``9:16`` … reduced exactly, never rounded to a pretty one."""
    if width <= 0 or height <= 0:
        return ""
    divisor = gcd(width, height)
    return f"{width // divisor}:{height // divisor}"


def parse_ratio(label: str) -> float:
    """``"9:16"`` -> 0.5625. Raises ValueError on anything else."""
    left, _, right = str(label).partition(":")
    w, h = float(left), float(right)
    if w <= 0 or h <= 0:
        raise ValueError(f"bad ratio {label!r}")
    return w / h


def decode(data: bytes, *, declared_mime: str = "") -> dict[str, Any]:
    """Measure one image from its bytes.

    Raises ``ImageInspectionError`` for anything we refuse to measure: empty,
    oversized, undecodable, truncated, absurdly large in pixels, or carrying a
    declared type that the bytes contradict.
    """
    if not data:
        raise ImageInspectionError("empty_image", "图片内容为空。")
    if len(data) > MAX_IMAGE_BYTES:
        raise ImageInspectionError(
            "image_too_large",
            f"图片超过 {MAX_IMAGE_BYTES // (1024 * 1024)} MB 上限。",
            status=413,
        )

    # Two passes on purpose. verify() detects truncation and corruption but
    # leaves the file unusable, so the measurements come from a fresh open.
    try:
        with Image.open(io.BytesIO(data)) as probe:
            probe.verify()
    except UnidentifiedImageError:
        raise ImageInspectionError("unsupported_format", "无法识别该文件的图片格式。", status=415)
    except Exception:
        raise ImageInspectionError("corrupt_image", "图片数据损坏或不完整，无法解析。")

    try:
        image = Image.open(io.BytesIO(data))
        image.load()
    except Exception:
        raise ImageInspectionError("corrupt_image", "图片数据损坏或不完整，无法解析。")

    with image:
        fmt = (image.format or "").upper()
        if fmt not in DECODABLE_FORMATS:
            raise ImageInspectionError(
                "unsupported_format", f"暂不支持 {fmt or '未知'} 格式的图片。", status=415
            )
        width, height = image.width, image.height
        if width <= 0 or height <= 0:
            raise ImageInspectionError("corrupt_image", "图片尺寸无效。")
        if width * height > MAX_PIXELS:
            raise ImageInspectionError(
                "image_too_many_pixels",
                f"图片像素数超过 {MAX_PIXELS // 1_000_000} MP 上限。",
                status=413,
            )

        mime = DECODABLE_FORMATS[fmt]
        declared = (declared_mime or "").split(";")[0].strip().lower()
        if declared and declared != mime and declared.startswith("image/"):
            raise ImageInspectionError(
                "mime_mismatch",
                f"文件内容是 {mime}，与声明的 {declared} 不一致。",
                status=415,
            )

        mode = image.mode
        has_alpha = mode in ("RGBA", "LA", "PA") or "transparency" in image.info

        return {
            "sha256": hashlib.sha256(data).hexdigest(),
            "format": fmt,
            "mime_type": mime,
            "width": width,
            "height": height,
            "aspect_ratio": aspect_ratio_label(width, height),
            "aspect_value": round(width / height, 6),
            "size_bytes": len(data),
            "color_mode": mode,
            "has_alpha": bool(has_alpha),
            "inspected_at": _now(),
            "method": DECODE_METHOD,
        }


# --------------------------------------------------------------------------- #
# Background: measured, not assumed                                            #
# --------------------------------------------------------------------------- #

#: Fraction of each edge treated as border, and how many samples per band.
_BAND = 0.06
_PER_BAND = 24
#: Per-channel distance at which a sample still counts as "the same colour".
_SAME_COLOUR_TOLERANCE = 8


def _median(values: list[int]) -> int:
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) // 2


def _band_points(width: int, height: int) -> list[tuple[str, int, int]]:
    """Fixed sampling grid over the four border bands. Deterministic by design."""
    bw = max(1, int(width * _BAND))
    bh = max(1, int(height * _BAND))
    points: list[tuple[str, int, int]] = []

    def spread(count: int, span: int) -> list[int]:
        if span <= 1:
            return [0] * count
        return [min(span - 1, (i * span) // count + span // (2 * count)) for i in range(count)]

    for x in spread(_PER_BAND, width):
        points.append(("top", x, min(height - 1, bh // 2)))
        points.append(("bottom", x, max(0, height - 1 - bh // 2)))
    for y in spread(_PER_BAND, height):
        points.append(("left", min(width - 1, bw // 2), y))
        points.append(("right", max(0, width - 1 - bw // 2), y))
    return points


def sample_background(data: bytes) -> dict[str, Any]:
    """Estimate the background colour from real border pixels.

    The estimate is the per-channel *median* of the samples, which survives a
    logo or a product edge intruding into one band. ``uniformity`` is the share
    of samples that actually agree with the estimate -- an interpretable number,
    not a model score -- and it is what the caller should treat as confidence in
    the phrase "this image has one background colour".

    It says nothing about whether a marketplace will accept the image.
    """
    with Image.open(io.BytesIO(data)) as image:
        image.load()
        # Flatten transparency onto white before measuring: a transparent corner
        # is not evidence of a white background, and leaving it as (0,0,0,0)
        # would silently read as black.
        if image.mode in ("RGBA", "LA", "PA") or "transparency" in image.info:
            rgba = image.convert("RGBA")
            flat = Image.new("RGB", rgba.size, (255, 255, 255))
            flat.paste(rgba, mask=rgba.split()[3])
            rgb = flat
        else:
            rgb = image.convert("RGB")

        points = _band_points(rgb.width, rgb.height)
        pixels = rgb.load()
        samples = [(band, pixels[x, y]) for band, x, y in points]

    if not samples:  # pragma: no cover - a decoded image always has pixels
        return {
            "state": UNAVAILABLE,
            "method": BACKGROUND_METHOD,
            "detail": "无法采样背景像素。",
        }

    estimate = tuple(_median([s[1][c] for s in samples]) for c in range(3))
    agreeing = [
        s for s in samples
        if max(abs(s[1][c] - estimate[c]) for c in range(3)) <= _SAME_COLOUR_TOLERANCE
    ]
    uniformity = round(len(agreeing) / len(samples), 4)

    by_band: dict[str, int] = {}
    for band, _ in samples:
        by_band[band] = by_band.get(band, 0) + 1

    return {
        "method": BACKGROUND_METHOD,
        "sampled_regions": [
            {"band": band, "samples": count, "fraction_of_edge": _BAND}
            for band, count in sorted(by_band.items())
        ],
        "sample_count": len(samples),
        "background_rgb": list(estimate),
        "background_hex": "#%02x%02x%02x" % estimate,
        "uniformity": uniformity,
        "tolerance": _SAME_COLOUR_TOLERANCE,
        # The share of border samples matching the estimate. Confidence that a
        # single background colour exists — NOT a probability of approval.
        "confidence": uniformity,
    }


# --------------------------------------------------------------------------- #
# Rule evaluation                                                              #
# --------------------------------------------------------------------------- #

#: Rule kinds this module can settle from pixels.
MEASURABLE_KINDS = (
    "image_format",
    "image_min_dimensions",
    "image_max_dimensions",
    "image_max_bytes",
    "image_aspect_ratio",
    "image_no_transparency",
    "image_white_background",
)

#: Rule kinds that are real requirements but need OCR, object detection or a
#: human. They resolve to manual_review and are never summarised as passing.
MANUAL_KINDS = (
    "image_subject_coverage",
    "image_no_overlaid_text",
)

_MANUAL_REASON: dict[str, str] = {
    "image_subject_coverage": "判断主体占比需要目标检测，本工具未启用，请人工核对。",
    "image_no_overlaid_text": "判断是否叠加文字/logo 需要 OCR 与检测，本工具未启用，请人工核对。",
}


def _result(
    rule: Any,
    state: str,
    *,
    measured: Any,
    expected: Any,
    detail: str,
    method: str,
    snapshot_id: str,
    asset_id: str,
    evidence: "dict[str, Any] | None" = None,
) -> dict[str, Any]:
    return {
        "rule_id": rule.id,
        "kind": rule.kind,
        "severity": rule.severity,
        "policy_snapshot_id": snapshot_id,
        "asset_id": asset_id,
        "state": state,
        "measured": measured,
        "expected": expected,
        "detail": detail,
        "method": method,
        "evidence": evidence or {},
        "description": rule.description,
    }


def _severity_state(ok: bool, severity: str) -> str:
    if ok:
        return PASS
    return FAIL if severity == "blocking" else WARNING


def evaluate_rule(
    rule: Any,
    asset: dict[str, Any],
    background: "dict[str, Any] | None",
    *,
    snapshot_id: str,
) -> "dict[str, Any] | None":
    """One image rule against one measured asset. ``None`` if not an image rule."""
    kind = rule.kind
    params = dict(rule.params or {})
    asset_id = asset.get("asset_id", "")

    def make(state: str, measured: Any, expected: Any, detail: str, method: str = DECODE_METHOD, ev=None):
        return _result(
            rule, state,
            measured=measured, expected=expected, detail=detail, method=method,
            snapshot_id=snapshot_id, asset_id=asset_id, evidence=ev,
        )

    if kind in MANUAL_KINDS:
        return make(
            MANUAL_REVIEW,
            None,
            params or None,
            _MANUAL_REASON[kind],
            method="not-implemented",
        )

    if kind == "image_format":
        allowed = [str(f).upper() for f in params.get("allowed", [])]
        ok = asset["format"] in allowed
        return make(
            _severity_state(ok, rule.severity),
            asset["format"],
            allowed,
            f"实际格式 {asset['format']}，允许 {'、'.join(allowed)}。",
        )

    if kind == "image_min_dimensions":
        min_w = int(params.get("min_width", 0))
        min_h = int(params.get("min_height", 0))
        ok = asset["width"] >= min_w and asset["height"] >= min_h
        return make(
            _severity_state(ok, rule.severity),
            f"{asset['width']}×{asset['height']}",
            f"≥ {min_w}×{min_h}",
            f"实际 {asset['width']}×{asset['height']}px，下限 {min_w}×{min_h}px。",
        )

    if kind == "image_max_dimensions":
        max_w = int(params.get("max_width", 0))
        max_h = int(params.get("max_height", 0))
        ok = asset["width"] <= max_w and asset["height"] <= max_h
        return make(
            _severity_state(ok, rule.severity),
            f"{asset['width']}×{asset['height']}",
            f"≤ {max_w}×{max_h}",
            f"实际 {asset['width']}×{asset['height']}px，上限 {max_w}×{max_h}px。",
        )

    if kind == "image_max_bytes":
        limit = int(params.get("max", 0))
        ok = asset["size_bytes"] <= limit
        return make(
            _severity_state(ok, rule.severity),
            asset["size_bytes"],
            f"≤ {limit}",
            f"实际 {asset['size_bytes']} 字节，上限 {limit} 字节。",
        )

    if kind == "image_aspect_ratio":
        allowed = [str(r) for r in params.get("allowed", [])]
        tolerance = float(params.get("tolerance", 0.02))
        actual = float(asset["aspect_value"])
        ok = any(abs(actual - parse_ratio(r)) <= tolerance for r in allowed)
        return make(
            _severity_state(ok, rule.severity),
            f"{asset['aspect_ratio']} ({actual:.4f})",
            f"{'、'.join(allowed)} ±{tolerance}",
            f"实际比例 {asset['aspect_ratio']}，允许 {'、'.join(allowed)}（容差 {tolerance}）。",
        )

    if kind == "image_no_transparency":
        ok = not asset["has_alpha"]
        return make(
            _severity_state(ok, rule.severity),
            asset["color_mode"] + (" + alpha" if asset["has_alpha"] else ""),
            "无 alpha 通道",
            "图片带透明通道。" if asset["has_alpha"] else "图片不含透明通道。",
        )

    if kind == "image_white_background":
        if not background:
            return make(
                UNAVAILABLE, None, None,
                "背景像素采样不可用，未作判定。",
                method=BACKGROUND_METHOD,
            )
        min_channel = int(params.get("min_channel", 250))
        min_uniformity = float(params.get("min_uniformity", 0.95))
        rgb = background["background_rgb"]
        uniformity = float(background["uniformity"])
        ok = min(rgb) >= min_channel and uniformity >= min_uniformity
        return make(
            _severity_state(ok, rule.severity),
            f"RGB{tuple(rgb)} · 一致度 {uniformity:.2f}",
            f"每通道 ≥ {min_channel} 且一致度 ≥ {min_uniformity}",
            (
                f"边缘采样 {background['sample_count']} 点，背景估计 {background['background_hex']}，"
                f"一致度 {uniformity:.2f}。"
            ),
            method=BACKGROUND_METHOD,
            ev=background,
        )

    return None


def inspect(
    data: bytes,
    platform: str,
    *,
    asset_id: str = "",
    declared_mime: str = "",
) -> dict[str, Any]:
    """Decode, measure and grade one image against a platform's policy snapshot.

    Raises ``ImageInspectionError`` when the bytes cannot be measured at all --
    a rejected upload never becomes a silent pass, and never damages whatever
    the caller already stored.
    """
    asset = decode(data, declared_mime=declared_mime)
    asset["asset_id"] = asset_id or asset["sha256"][:16]
    asset["platform"] = platform

    try:
        snapshot = policy.current_snapshot(platform)
    except Exception:
        # Without a snapshot there is no rule to apply. Say so; do not pass.
        return {
            "asset": asset,
            "background": None,
            "results": [],
            "summary": _summarise([]),
            "policy_snapshot_id": "",
            "unavailable_reason": f"未找到平台 {platform} 的政策快照，未作任何判定。",
        }

    image_rules = [
        r for r in snapshot.rules if r.kind in MEASURABLE_KINDS or r.kind in MANUAL_KINDS
    ]

    # Sampled for every platform, not only the ones with a white-background
    # rule: the measurement is cheap, and a Shopify reviewer still benefits from
    # seeing what the background actually is even where no rule constrains it.
    background: "dict[str, Any] | None" = None
    try:
        background = sample_background(data)
    except Exception:
        # A measurement that failed is "unavailable", never "fine".
        logger.warning("background sampling failed for asset=%s", asset["asset_id"])
        background = None

    results = [
        result
        for rule in image_rules
        if (result := evaluate_rule(rule, asset, background, snapshot_id=snapshot.version))
    ]

    return {
        "asset": asset,
        "background": background,
        "results": results,
        "summary": _summarise(results),
        "policy_snapshot_id": snapshot.version,
        "unavailable_reason": "",
    }


def _summarise(results: list[dict[str, Any]]) -> dict[str, Any]:
    counts = {state: 0 for state in RESULT_STATES}
    for r in results:
        counts[r["state"]] = counts.get(r["state"], 0) + 1
    return {
        "counts": counts,
        "blocked": counts[FAIL] > 0,
        # An image with open manual-review items is not "verified". The flag is
        # named for what it is so no caller can read it as a pass.
        "fully_verified": counts[FAIL] == 0
        and counts[WARNING] == 0
        and counts[MANUAL_REVIEW] == 0
        and counts[UNAVAILABLE] == 0,
        "needs_manual_review": counts[MANUAL_REVIEW] > 0,
        "unavailable": counts[UNAVAILABLE] > 0,
    }
