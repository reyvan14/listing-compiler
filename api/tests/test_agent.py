"""agent_reply: Token Plan chat + preserved keyword fallback."""

from __future__ import annotations

import asyncio

import agent
import token_plan


def run(coro):
    return asyncio.run(coro)


def test_empty_messages_returns_hint():
    assert run(agent.agent_reply([])) == "直接问上新规则，或把提示词贴过来。"


def test_falls_back_to_keyword_reply_when_unconfigured():
    reply = run(agent.agent_reply([{"role": "user", "content": "主图能加字吗"}]))
    assert "白底" in reply  # deterministic fallback_reply branch


def test_uses_token_plan_when_configured(monkeypatch):
    monkeypatch.setenv("TOKEN_PLAN_API_KEY", "sk-test")
    seen = {}

    async def fake_chat(messages, *, model=None, timeout=None):
        seen["model"] = model
        seen["system"] = messages[0]["role"]
        return "这是模型回答"

    monkeypatch.setattr(token_plan, "chat_completion", fake_chat)
    out = run(agent.agent_reply([{"role": "user", "content": "hi"}]))

    assert out == "这是模型回答"
    assert seen["model"] == "qwen3.7-plus"
    assert seen["system"] == "system"


def test_provider_error_falls_back(monkeypatch):
    monkeypatch.setenv("TOKEN_PLAN_API_KEY", "sk-test")

    async def boom(messages, *, model=None, timeout=None):
        raise token_plan.TokenPlanError("timeout", request_id="abc123def456")

    monkeypatch.setattr(token_plan, "chat_completion", boom)
    reply = run(agent.agent_reply([{"role": "user", "content": "BPA 证书怎么处理"}]))
    assert "BPA" in reply
