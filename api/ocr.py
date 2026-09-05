"""Optional OCR, and the honest reporting of its absence.

OCR is the difference between "we read the certificate" and "we displayed the
certificate". This module makes the first possible where an engine is installed
and makes the second *say so* where one is not.

The contract that matters: **a missing engine is never a clean bill of health.**
``run_ocr`` on a box without Tesseract returns ``manual_review`` with reason
``ocr_unavailable``, not an empty-but-successful read. Nothing downstream may
turn that into a passing check, and the application starts and serves normally
either way -- the dependency is optional, and its absence is a reported state
rather than a crash or a silent pass.

Word confidences and boxes come from Tesseract's own TSV output. They are shown
to the operator for correction because OCR is *evidence of what the pixels look
like*, not a verified reading: in this project's own fixtures Tesseract reads
"350 ml" as "350 mt" at 63% confidence, and a workflow that auto-approved that
would put a wrong capacity into a listing.
"""

from __future__ import annotations

import csv
import io
import logging
import os
import shutil
import subprocess
from dataclasses import dataclass
from typing import Any, Protocol

logger = logging.getLogger("listing.ocr")

# Result states -------------------------------------------------------------- #

OK = "ok"
MANUAL_REVIEW = "manual_review"
FAILED = "failed"

# Reasons a run produced no text --------------------------------------------- #

OCR_UNAVAILABLE = "ocr_unavailable"
IMAGE_TOO_LARGE = "image_too_large"
TIMED_OUT = "timed_out"
ENGINE_ERROR = "engine_error"
UNREADABLE = "unreadable"

#: Ceilings. OCR on an unbounded image is a denial of service, and a hung
#: subprocess is worse than no OCR at all.
MAX_OCR_BYTES = 12 * 1024 * 1024
MAX_OCR_PIXELS = 40_000_000
DEFAULT_TIMEOUT_S = 20.0

#: Languages this module will ask for. Tesseract needs the matching traineddata
#: installed; we ask only for packs the engine reports it has.
LANG_ALIASES: dict[str, str] = {
    "en": "eng",
    "en-US": "eng",
    "en-GB": "eng",
    "zh": "chi_sim",
    "zh-CN": "chi_sim",
    "zh-TW": "chi_tra",
}


@dataclass(frozen=True)
class OcrWord:
    text: str
    confidence: float
    #: Pixel box in the source image: left, top, width, height.
    left: int
    top: int
    width: int
    height: int
    line: int

    def as_dict(self) -> dict[str, Any]:
        return {
            "text": self.text,
            "confidence": round(self.confidence, 2),
            "box": {"left": self.left, "top": self.top, "width": self.width, "height": self.height},
            "line": self.line,
        }


@dataclass(frozen=True)
class OcrResult:
    state: str
    provider: str
    method: str
    words: tuple[OcrWord, ...] = ()
    text: str = ""
    languages: tuple[str, ...] = ()
    reason: str = ""
    detail: str = ""
    #: Which page or image this came from, for multi-page sources.
    page: "int | None" = None

    @property
    def ok(self) -> bool:
        return self.state == OK

    def mean_confidence(self) -> float:
        scored = [w.confidence for w in self.words if w.confidence >= 0]
        return round(sum(scored) / len(scored), 2) if scored else 0.0

    def as_dict(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "provider": self.provider,
            "method": self.method,
            "text": self.text,
            "words": [w.as_dict() for w in self.words],
            "languages": list(self.languages),
            "reason": self.reason,
            "detail": self.detail,
            "page": self.page,
            "mean_confidence": self.mean_confidence(),
        }


class OcrProvider(Protocol):
    """Anything that can turn image bytes into located, scored words."""

    name: str

    def available(self) -> bool: ...

    def languages(self) -> tuple[str, ...]: ...

    def read(self, data: bytes, *, languages: tuple[str, ...], timeout: float) -> OcrResult: ...


# --------------------------------------------------------------------------- #
# Tesseract                                                                    #
# --------------------------------------------------------------------------- #


def _tesseract_cmd() -> str:
    """The Tesseract binary, from config or PATH. Empty when not installed."""
    configured = os.environ.get("LISTING_OCR_CMD", "").strip()
    if configured:
        return configured if os.path.isfile(configured) else ""
    return shutil.which("tesseract") or ""


class TesseractProvider:
    """Real adapter over the Tesseract CLI.

    The CLI rather than a Python binding: it needs no extra wheel, it gives
    word-level boxes and confidences directly through TSV, and the arguments are
    a fixed list with no shell interpolation, so a filename can never become a
    command.
    """

    name = "tesseract"

    def __init__(self, command: str = "") -> None:
        self._command = command

    def command(self) -> str:
        return self._command or _tesseract_cmd()

    def available(self) -> bool:
        return bool(self.command())

    def version(self) -> str:
        command = self.command()
        if not command:
            return ""
        try:
            out = subprocess.run(
                [command, "--version"], capture_output=True, text=True, timeout=10, check=False
            )
        except (OSError, subprocess.SubprocessError):
            return ""
        return (out.stdout or "").splitlines()[0].strip() if out.stdout else ""

    def languages(self) -> tuple[str, ...]:
        """Language packs the installed engine actually has."""
        command = self.command()
        if not command:
            return ()
        try:
            out = subprocess.run(
                [command, "--list-langs"], capture_output=True, text=True, timeout=10, check=False
            )
        except (OSError, subprocess.SubprocessError):
            return ()
        lines = [line.strip() for line in (out.stdout or "").splitlines()[1:] if line.strip()]
        return tuple(lines)

    def read(
        self,
        data: bytes,
        *,
        languages: tuple[str, ...] = ("eng",),
        timeout: float = DEFAULT_TIMEOUT_S,
    ) -> OcrResult:
        command = self.command()
        if not command:
            return OcrResult(
                state=MANUAL_REVIEW,
                provider=self.name,
                method="tesseract-cli",
                reason=OCR_UNAVAILABLE,
                detail="未安装 OCR 引擎，无法读取图片中的文字，需人工阅读确认。",
            )

        installed = set(self.languages())
        wanted = tuple(lang for lang in languages if lang in installed) or ("eng",)

        import tempfile

        with tempfile.TemporaryDirectory() as work:
            source = os.path.join(work, "page.img")
            with open(source, "wb") as handle:
                handle.write(data)
            # A fixed argument list. No shell, no interpolation, no user string
            # in a position where it could be read as an option.
            args = [command, source, "stdout", "-l", "+".join(wanted), "--psm", "6", "tsv"]
            try:
                out = subprocess.run(
                    args, capture_output=True, text=True, timeout=timeout, check=False
                )
            except subprocess.TimeoutExpired:
                return OcrResult(
                    state=MANUAL_REVIEW, provider=self.name, method="tesseract-cli",
                    reason=TIMED_OUT, languages=wanted,
                    detail=f"OCR 超过 {timeout:.0f} 秒未完成，已中止。",
                )
            except OSError:
                return OcrResult(
                    state=MANUAL_REVIEW, provider=self.name, method="tesseract-cli",
                    reason=ENGINE_ERROR, languages=wanted,
                    detail="OCR 引擎无法启动。",
                )

        if out.returncode != 0:
            # Never log the engine's stderr verbatim: it echoes file paths.
            logger.warning("tesseract exited %s", out.returncode)
            return OcrResult(
                state=MANUAL_REVIEW, provider=self.name, method="tesseract-cli",
                reason=ENGINE_ERROR, languages=wanted,
                detail="OCR 引擎返回错误，未产生可用结果。",
            )

        words = _parse_tsv(out.stdout or "")
        if not words:
            return OcrResult(
                state=MANUAL_REVIEW, provider=self.name, method="tesseract-cli",
                reason=UNREADABLE, languages=wanted,
                detail="OCR 未在图片中找到可识别的文字，需人工阅读。",
            )
        return OcrResult(
            state=OK,
            provider=self.name,
            method="tesseract-cli",
            words=words,
            text=_lines(words),
            languages=wanted,
        )


def _parse_tsv(payload: str) -> tuple[OcrWord, ...]:
    """Word rows from Tesseract's TSV. Malformed rows are skipped, not guessed."""
    words: list[OcrWord] = []
    reader = csv.DictReader(io.StringIO(payload), delimiter="\t", quoting=csv.QUOTE_NONE)
    for row in reader:
        try:
            if int(row.get("level") or 0) != 5:
                continue
            text = (row.get("text") or "").strip()
            confidence = float(row.get("conf") or -1)
            if not text or confidence < 0:
                continue
            words.append(
                OcrWord(
                    text=text,
                    confidence=confidence,
                    left=int(row["left"]),
                    top=int(row["top"]),
                    width=int(row["width"]),
                    height=int(row["height"]),
                    line=int(row.get("line_num") or 0),
                )
            )
        except (TypeError, ValueError, KeyError):
            continue
    return tuple(words)


def _lines(words: tuple[OcrWord, ...]) -> str:
    grouped: dict[int, list[OcrWord]] = {}
    for word in words:
        grouped.setdefault(word.line, []).append(word)
    return "\n".join(
        " ".join(w.text for w in sorted(group, key=lambda w: w.left))
        for _, group in sorted(grouped.items())
    ).strip()


# --------------------------------------------------------------------------- #
# Entry point                                                                  #
# --------------------------------------------------------------------------- #

_PROVIDER: "OcrProvider | None" = None


def provider() -> OcrProvider:
    global _PROVIDER
    if _PROVIDER is None:
        _PROVIDER = TesseractProvider()
    return _PROVIDER


def set_provider(value: "OcrProvider | None") -> None:
    """Test seam. ``None`` restores the default."""
    global _PROVIDER
    _PROVIDER = value


def available() -> bool:
    return provider().available()


def capability() -> dict[str, Any]:
    """What OCR this deployment actually has. Rendered in the UI verbatim."""
    engine = provider()
    installed = engine.available()
    langs = list(engine.languages()) if installed else []
    return {
        "available": installed,
        "provider": engine.name,
        "version": engine.version() if hasattr(engine, "version") and installed else "",
        "languages": langs,
        "supports_chinese": any(lang.startswith("chi") for lang in langs),
        "supports_english": "eng" in langs,
        "note": (
            "OCR 已启用，识别结果仍需人工确认后才能成为已核实事实。"
            if installed
            else "未安装 OCR 引擎：图片中的文字不会被自动读取，相关事实一律标为需人工核验。"
        ),
    }


def run_ocr(
    data: bytes,
    *,
    languages: "tuple[str, ...] | None" = None,
    timeout: float = DEFAULT_TIMEOUT_S,
    page: "int | None" = None,
) -> OcrResult:
    """Read text from one image. Never raises; failure is a reported state."""
    engine = provider()
    method = getattr(engine, "name", "unknown")

    if not data:
        return OcrResult(
            state=MANUAL_REVIEW, provider=method, method="none",
            reason=UNREADABLE, detail="图片内容为空。", page=page,
        )
    if len(data) > MAX_OCR_BYTES:
        return OcrResult(
            state=MANUAL_REVIEW, provider=method, method="none", reason=IMAGE_TOO_LARGE,
            detail=f"图片超过 {MAX_OCR_BYTES // (1024 * 1024)} MB，未做 OCR。", page=page,
        )

    # Pixel ceiling, checked before handing anything to the engine.
    try:
        from PIL import Image

        with Image.open(io.BytesIO(data)) as probe:
            if probe.width * probe.height > MAX_OCR_PIXELS:
                return OcrResult(
                    state=MANUAL_REVIEW, provider=method, method="none",
                    reason=IMAGE_TOO_LARGE,
                    detail=f"图片像素数超过 {MAX_OCR_PIXELS // 1_000_000} MP，未做 OCR。",
                    page=page,
                )
    except Exception:
        return OcrResult(
            state=MANUAL_REVIEW, provider=method, method="none",
            reason=UNREADABLE, detail="无法解码该图片，未做 OCR。", page=page,
        )

    wanted = languages or ("eng", "chi_sim")
    result = engine.read(data, languages=tuple(wanted), timeout=timeout)
    if page is not None and result.page is None:
        result = OcrResult(**{**result.__dict__, "page": page})
    logger.info(
        "ocr provider=%s state=%s words=%d", result.provider, result.state, len(result.words)
    )
    return result
