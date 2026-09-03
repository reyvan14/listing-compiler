#!/usr/bin/env python3
"""Minimal Token Plan connectivity probe.

Usage:
    TOKEN_PLAN_API_KEY=... python scripts/check_token_plan.py

Sends one tiny chat request and prints a pass/fail summary only. It never
prints the API key, the prompt, or the model response text. Exit code 0 on
success, 1 on failure.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import token_plan  # noqa: E402


async def _main() -> int:
    if not token_plan.is_configured():
        print("token_plan probe SKIPPED: TOKEN_PLAN_API_KEY not set")
        return 1
    try:
        text = await token_plan.chat_completion(
            [{"role": "user", "content": "ping"}],
            model=token_plan.text_model(),
        )
    except token_plan.TokenPlanError as exc:
        print(
            "token_plan probe FAILED "
            f"category={exc.category} status={exc.status} request_id={exc.request_id}"
        )
        return 1
    print(f"token_plan probe OK model={token_plan.text_model()} response_chars={len(text)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main()))
