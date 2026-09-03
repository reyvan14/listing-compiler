"""generate_drafts: Token Plan tier + preserved fallback behaviour."""

from __future__ import annotations

import asyncio

import generate
import token_plan


def run(coro):
    return asyncio.run(coro)


def test_falls_back_to_local_drafts_when_provider_unconfigured():
    # No TOKEN_PLAN_* / LISTING_LLM_* / upstream env (cleared by conftest).
    drafts, source = run(
        generate.generate_drafts(
            "Foldable Cup", "folds flat\nleak proof", ["amazon", "tiktok", "shopify"], "compliant", []
        )
    )
    assert source == "fallback"
    assert {d["id"] for d in drafts} == {"amazon", "tiktok", "shopify"}
    for d in drafts:
        assert d["title"]
        assert isinstance(d["checks"], list) and d["checks"]


def test_uses_token_plan_when_configured(monkeypatch):
    monkeypatch.setenv("TOKEN_PLAN_API_KEY", "sk-test")
    calls = {}

    async def fake_chat(messages, *, model=None, timeout=None):
        calls["model"] = model
        return (
            '{"drafts":[{"id":"amazon","title":"Foldable Silicone Travel Cup 350ml Leak Proof Lid",'
            '"fields":['
            '{"label":"五点 1","value":"folds flat to 4cm"},'
            '{"label":"五点 2","value":"food grade silicone"},'
            '{"label":"五点 3","value":"leak proof lid"},'
            '{"label":"五点 4","value":"350ml capacity"},'
            '{"label":"五点 5","value":"lightweight for travel"}]}]}'
        )

    monkeypatch.setattr(token_plan, "chat_completion", fake_chat)
    drafts, source = run(generate.generate_drafts("Cup", "folds", ["amazon"], "compliant", []))

    assert source == "llm"
    assert calls["model"] == "qwen3.7-plus"
    assert drafts[0]["id"] == "amazon"
    assert drafts[0]["name"] == "Amazon"
    assert any(c["id"] == "bullets" and c["state"] == "pass" for c in drafts[0]["checks"])


def test_provider_error_falls_back_and_does_not_propagate(monkeypatch):
    monkeypatch.setenv("TOKEN_PLAN_API_KEY", "sk-test")

    async def boom(messages, *, model=None, timeout=None):
        raise token_plan.TokenPlanError("http_status", request_id="abc123def456", status=500)

    monkeypatch.setattr(token_plan, "chat_completion", boom)
    drafts, source = run(generate.generate_drafts("Cup", "folds", ["amazon"], "compliant", []))
    assert source == "fallback"
    assert drafts and drafts[0]["id"] == "amazon"


def test_unparseable_provider_output_falls_back(monkeypatch):
    monkeypatch.setenv("TOKEN_PLAN_API_KEY", "sk-test")

    async def junk(messages, *, model=None, timeout=None):
        return "the model forgot to return json"

    monkeypatch.setattr(token_plan, "chat_completion", junk)
    drafts, source = run(generate.generate_drafts("Cup", "folds", ["amazon"], "compliant", []))
    assert source == "fallback"
    assert drafts
