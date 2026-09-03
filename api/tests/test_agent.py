"""agent_reply: Token Plan chat + preserved keyword fallback.

agent_reply now returns {"reply", "plan"} so it can propose canvas operations;
the keyword fallback behaviour it had before is unchanged underneath.
"""

from __future__ import annotations

import asyncio

import agent
import token_plan


def run(coro):
    return asyncio.run(coro)


def test_empty_messages_returns_hint():
    out = run(agent.agent_reply([]))
    assert out["plan"] is None
    assert "规则" in out["reply"] or "流程" in out["reply"]


def test_falls_back_to_keyword_reply_when_unconfigured():
    out = run(agent.agent_reply([{"role": "user", "content": "主图能加字吗"}]))
    assert "白底" in out["reply"]  # deterministic fallback_reply branch
    assert out["plan"] is None  # a question is not a canvas request


def test_uses_token_plan_when_configured(monkeypatch):
    monkeypatch.setenv("TOKEN_PLAN_API_KEY", "sk-test")
    seen = {}

    async def fake_chat(messages, *, model=None, timeout=None):
        seen["model"] = model
        seen["system"] = messages[0]["role"]
        return "这是模型回答"

    monkeypatch.setattr(token_plan, "chat_completion", fake_chat)
    out = run(agent.agent_reply([{"role": "user", "content": "hi"}]))

    assert out["reply"] == "这是模型回答"
    assert out["plan"] is None
    assert seen["model"] == "qwen3.7-plus"
    assert seen["system"] == "system"


def test_provider_error_falls_back(monkeypatch):
    monkeypatch.setenv("TOKEN_PLAN_API_KEY", "sk-test")

    async def boom(messages, *, model=None, timeout=None):
        raise token_plan.TokenPlanError("timeout", request_id="abc123def456")

    monkeypatch.setattr(token_plan, "chat_completion", boom)
    out = run(agent.agent_reply([{"role": "user", "content": "BPA 证书怎么处理"}]))
    assert "BPA" in out["reply"]
