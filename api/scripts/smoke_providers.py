#!/usr/bin/env python3
"""Manual real-provider smoke test: one text, one image, one video request.

Run this by hand, only when credentials are configured. It is deliberately not
part of the automated suite: the test suite must never depend on a paid
external service, and CI must never spend money.

    TOKEN_PLAN_API_KEY=... python scripts/smoke_providers.py
    python scripts/smoke_providers.py --skip-video     # text and image only

What it prints: which provider protocol was selected, whether each request
succeeded, how long it took, and the shape of what came back. What it never
prints: the API key, any Authorization header, the prompt, the response text,
or a media data URL. A result is summarised by kind and size, never by content.

OCR is not assumed. It is reported from whatever engine is installed locally,
and its absence is stated rather than treated as a failure.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import ocr  # noqa: E402
import providers  # noqa: E402


def _line(label: str, value: str) -> None:
    print(f"  {label:<22} {value}")


def _describe(value: object) -> str:
    """Shape and size of a result. Never its content."""
    text = str(value or "")
    if text.startswith("data:"):
        header, _, payload = text.partition(",")
        return f"{header[:40]}… ({len(payload)} base64 chars)"
    if text.startswith(("http://", "https://")):
        return f"URL ({len(text)} chars)"
    return f"{type(value).__name__} ({len(text)} chars)"


async def _text() -> bool:
    import token_plan

    print("\n[1/3] text")
    provider = providers.text_provider()
    _line("provider", provider)
    if provider == "none":
        _line("result", "SKIPPED — no text credential configured")
        return True
    started = time.monotonic()
    try:
        reply = await token_plan.chat_completion(
            [{"role": "user", "content": "Reply with the single word OK."}]
        )
    except Exception as exc:  # noqa: BLE001 - the category is the useful part
        _line("result", f"FAILED — {type(exc).__name__}")
        return False
    _line("elapsed", f"{time.monotonic() - started:.2f}s")
    _line("result", f"OK — {_describe(reply)}")
    return True


async def _image() -> bool:
    import images

    print("\n[2/3] image")
    provider = providers.image_provider()
    capability = providers.declared(provider)
    _line("provider", provider)
    _line("reference image", "supported" if capability.supports_reference_image else "not supported")
    if provider == "none":
        _line("result", "SKIPPED — no image credential configured")
        return True
    started = time.monotonic()
    try:
        url = await images.generate_prompt_image(
            "a plain white studio background, no product, no text", "1:1"
        )
    except Exception as exc:  # noqa: BLE001
        _line("result", f"FAILED — {type(exc).__name__}")
        return False
    _line("elapsed", f"{time.monotonic() - started:.2f}s")
    _line("result", f"OK — {_describe(url)}")
    return True


async def _video() -> bool:
    import media

    print("\n[3/3] video")
    provider = providers.video_provider()
    _line("provider", provider)
    if provider == "none":
        _line("result", "SKIPPED — no video credential configured")
        return True
    started = time.monotonic()
    try:
        result = await media.generate_media_video(
            prompt="a collapsible cup unfolding on a plain surface",
            aspect_ratio="9:16",
            duration="5s",
        )
    except Exception as exc:  # noqa: BLE001
        _line("result", f"FAILED — {type(exc).__name__}")
        return False
    _line("elapsed", f"{time.monotonic() - started:.2f}s")
    _line("result", f"OK — {_describe(result)}")
    return True


def _capabilities() -> None:
    print("\ncapabilities (declared, not guessed)")
    snapshot = providers.snapshot()
    _line("text", snapshot["text"]["provider"])
    _line("image", snapshot["image"]["provider"])
    _line("video", snapshot["video"]["provider"])
    _line("reference image", str(snapshot["reference_image"]["supported"]))
    _line("vision", str(snapshot["vision"]["supported"]))

    capability = ocr.capability()
    _line("ocr", "installed" if capability["available"] else "not installed")
    if capability["available"]:
        _line("ocr languages", ", ".join(capability["languages"]) or "(none)")
    else:
        # Absence is a state to report, not a failure of this script.
        _line("ocr note", "OCR is optional; its absence does not fail this smoke test.")


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-video", action="store_true", help="skip the video request")
    args = parser.parse_args()

    print("real-provider smoke test")
    print("no credential, prompt or response body is printed by this script")
    _capabilities()

    results = [await _text(), await _image()]
    if args.skip_video:
        print("\n[3/3] video")
        _line("result", "SKIPPED — --skip-video")
    else:
        results.append(await _video())

    failures = results.count(False)
    print(f"\n{'FAILED' if failures else 'PASSED'} — {failures} failing request(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
