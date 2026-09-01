"""Shared test setup for the api/ package.

The api/ modules use bare imports (``import token_plan``, ``import generate``,
...), so ``api/`` must be on ``sys.path``. Every test also runs with provider
environment variables cleared, so a developer's real ``api/.env`` / shell
config can never leak into a test run.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

_PROVIDER_ENV = (
    "TOKEN_PLAN_API_KEY",
    "TOKEN_PLAN_BASE_URL",
    "TOKEN_PLAN_TEXT_MODEL",
    "TOKEN_PLAN_AGENT_MODEL",
    "TOKEN_PLAN_TIMEOUT_S",
    "TOKEN_PLAN_CONNECT_TIMEOUT_S",
    "TOKEN_PLAN_MEDIA_BASE_URL",
    "LISTING_LLM_API_KEY",
    "LISTING_LLM_BASE_URL",
    "LISTING_LLM_MODEL",
    "LISTING_UPSTREAM_URL",
    "LISTING_UPSTREAM_USER",
    "LISTING_IMAGE_API_KEY",
    "LISTING_IMAGE_BASE_URL",
    "LISTING_IMAGE_MODEL",
    "LISTING_IMAGE_PROVIDER",
    "GPT_IMAGE_2_API_KEY",
    "LISTING_VIDEO_API_KEY",
    "LISTING_VIDEO_BASE_URL",
    "LISTING_VIDEO_MODEL",
    "LISTING_VIDEO_IMAGE_MODEL",
    "LISTING_VIDEO_PROVIDER",
    "LISTING_VIDEO_RESOLUTION",
    "LISTING_VIDEO_POLL_INTERVAL_S",
    "LISTING_VIDEO_POLL_TIMEOUT_S",
)


@pytest.fixture(autouse=True)
def _clean_provider_env(monkeypatch):
    for name in _PROVIDER_ENV:
        monkeypatch.delenv(name, raising=False)
    yield
