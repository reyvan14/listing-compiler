"""Token Plan client: config, transport errors, response validation, safe logging."""

from __future__ import annotations

import asyncio
import json
import logging

import httpx
import pytest

import token_plan
from token_plan import TokenPlanError, chat_completion

SECRET_KEY = "sk-test-DO-NOT-LOG"


def run(coro):
    return asyncio.run(coro)


def mock_client_factory(handler):
    def factory(timeout):
        return httpx.AsyncClient(transport=httpx.MockTransport(handler), timeout=timeout)

    return factory


def use_handler(monkeypatch, handler):
    monkeypatch.setattr(token_plan, "_make_client", mock_client_factory(handler))


def ok_body(content="hi there"):
    return {"id": "resp-1", "choices": [{"index": 0, "message": {"role": "assistant", "content": content}}]}


@pytest.fixture
def key(monkeypatch):
    monkeypatch.setenv("TOKEN_PLAN_API_KEY", SECRET_KEY)


# --------------------------------------------------------------------------- #
# happy path                                                                  #
# --------------------------------------------------------------------------- #


def test_success_returns_content_and_sends_expected_request(monkeypatch, key):
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("authorization")
        seen["ctype"] = request.headers.get("content-type")
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json=ok_body("hello world"))

    use_handler(monkeypatch, handler)
    out = run(chat_completion([{"role": "user", "content": "hi"}]))

    assert out == "hello world"
    assert seen["url"] == (
        "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions"
    )
    assert seen["auth"] == f"Bearer {SECRET_KEY}"
    assert seen["ctype"] == "application/json"
    assert seen["body"]["model"] == "qwen3.7-plus"
    assert seen["body"]["stream"] is False
    assert seen["body"]["messages"] == [{"role": "user", "content": "hi"}]


def test_base_url_and_model_are_configurable(monkeypatch, key):
    monkeypatch.setenv("TOKEN_PLAN_BASE_URL", "https://example.test/v1/")
    monkeypatch.setenv("TOKEN_PLAN_TEXT_MODEL", "glm-5.2")
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["model"] = json.loads(request.content)["model"]
        return httpx.Response(200, json=ok_body())

    use_handler(monkeypatch, handler)
    run(chat_completion([{"role": "user", "content": "x"}]))

    assert seen["url"] == "https://example.test/v1/chat/completions"
    assert seen["model"] == "glm-5.2"


def test_explicit_model_argument_wins(monkeypatch, key):
    seen = {}

    def handler(request):
        seen["model"] = json.loads(request.content)["model"]
        return httpx.Response(200, json=ok_body())

    use_handler(monkeypatch, handler)
    run(chat_completion([{"role": "user", "content": "x"}], model="deepseek-v4-pro"))
    assert seen["model"] == "deepseek-v4-pro"


def test_list_content_parts_are_joined(monkeypatch, key):
    body = {"choices": [{"message": {"content": [{"type": "text", "text": "a"}, {"type": "text", "text": "b"}]}}]}
    use_handler(monkeypatch, lambda r: httpx.Response(200, json=body))
    assert run(chat_completion([{"role": "user", "content": "x"}])) == "ab"


def test_legacy_listing_llm_env_still_works(monkeypatch):
    # No TOKEN_PLAN_* set; the deprecated LISTING_LLM_* vars must still drive the call.
    monkeypatch.setenv("LISTING_LLM_API_KEY", "legacy-key")
    monkeypatch.setenv("LISTING_LLM_BASE_URL", "https://legacy.test/v1")
    monkeypatch.setenv("LISTING_LLM_MODEL", "kimi-k2.6")
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("authorization")
        seen["model"] = json.loads(request.content)["model"]
        return httpx.Response(200, json=ok_body())

    use_handler(monkeypatch, handler)
    run(chat_completion([{"role": "user", "content": "x"}]))

    assert seen["url"] == "https://legacy.test/v1/chat/completions"
    assert seen["auth"] == "Bearer legacy-key"
    assert seen["model"] == "kimi-k2.6"


# --------------------------------------------------------------------------- #
# error categories                                                            #
# --------------------------------------------------------------------------- #


def test_missing_key_raises_config(monkeypatch):
    with pytest.raises(TokenPlanError) as ei:
        run(chat_completion([{"role": "user", "content": "x"}]))
    assert ei.value.category == "config"
    assert ei.value.request_id


def test_empty_messages_raises_config(key):
    with pytest.raises(TokenPlanError) as ei:
        run(chat_completion([]))
    assert ei.value.category == "config"


def test_http_500_raises_http_status_without_leaking_body(monkeypatch, key):
    def handler(request):
        return httpx.Response(500, json={"error": {"message": "internal detail SHOULD-NOT-LEAK"}})

    use_handler(monkeypatch, handler)
    with pytest.raises(TokenPlanError) as ei:
        run(chat_completion([{"role": "user", "content": "x"}]))
    assert ei.value.category == "http_status"
    assert ei.value.status == 500
    assert "SHOULD-NOT-LEAK" not in str(ei.value)


def test_read_timeout_maps_to_timeout_category(monkeypatch, key):
    def handler(request):
        raise httpx.ReadTimeout("slow", request=request)

    use_handler(monkeypatch, handler)
    with pytest.raises(TokenPlanError) as ei:
        run(chat_completion([{"role": "user", "content": "x"}]))
    assert ei.value.category == "timeout"
    assert ei.value.status is None


def test_connect_error_maps_to_network_category(monkeypatch, key):
    def handler(request):
        raise httpx.ConnectError("no route", request=request)

    use_handler(monkeypatch, handler)
    with pytest.raises(TokenPlanError) as ei:
        run(chat_completion([{"role": "user", "content": "x"}]))
    assert ei.value.category == "network"


def test_non_json_body_raises_invalid_response(monkeypatch, key):
    use_handler(monkeypatch, lambda r: httpx.Response(200, text="<html>not json</html>"))
    with pytest.raises(TokenPlanError) as ei:
        run(chat_completion([{"role": "user", "content": "x"}]))
    assert ei.value.category == "invalid_response"


def test_blank_content_raises_invalid_response(monkeypatch, key):
    use_handler(monkeypatch, lambda r: httpx.Response(200, json={"choices": [{"message": {"content": "   "}}]}))
    with pytest.raises(TokenPlanError) as ei:
        run(chat_completion([{"role": "user", "content": "x"}]))
    assert ei.value.category == "invalid_response"


def test_reasoning_only_response_raises_invalid_response(monkeypatch, key):
    body = {"choices": [{"message": {"content": None, "reasoning_content": "thinking hard"}}]}
    use_handler(monkeypatch, lambda r: httpx.Response(200, json=body))
    with pytest.raises(TokenPlanError) as ei:
        run(chat_completion([{"role": "user", "content": "x"}]))
    assert ei.value.category == "invalid_response"


def test_missing_choices_raises_invalid_response(monkeypatch, key):
    use_handler(monkeypatch, lambda r: httpx.Response(200, json={"id": "x"}))
    with pytest.raises(TokenPlanError) as ei:
        run(chat_completion([{"role": "user", "content": "x"}]))
    assert ei.value.category == "invalid_response"


# --------------------------------------------------------------------------- #
# logging discipline                                                          #
# --------------------------------------------------------------------------- #


def test_failure_logs_only_status_category_request_id(monkeypatch, key, caplog):
    use_handler(monkeypatch, lambda r: httpx.Response(503, json={"error": "boom-secret-body"}))
    with caplog.at_level(logging.INFO, logger="listing.token_plan"):
        with pytest.raises(TokenPlanError):
            run(chat_completion([{"role": "user", "content": "prompt-should-not-be-logged"}]))

    text = "\n".join(rec.getMessage() for rec in caplog.records)
    assert "boom-secret-body" not in text
    assert "prompt-should-not-be-logged" not in text
    assert SECRET_KEY not in text
    assert "Bearer" not in text
    assert "authorization" not in text.lower()
    assert "status=503" in text
    assert "category=http_status" in text
    assert "request_id=" in text


def test_success_log_has_no_response_text(monkeypatch, key, caplog):
    use_handler(monkeypatch, lambda r: httpx.Response(200, json=ok_body("MODEL-SAID-THIS")))
    with caplog.at_level(logging.INFO, logger="listing.token_plan"):
        run(chat_completion([{"role": "user", "content": "secret-prompt"}]))
    text = "\n".join(rec.getMessage() for rec in caplog.records)
    assert "MODEL-SAID-THIS" not in text
    assert "secret-prompt" not in text
    assert SECRET_KEY not in text
    assert "request_id=" in text


def test_general_dashscope_host_is_flagged(monkeypatch, key, caplog):
    monkeypatch.setenv("TOKEN_PLAN_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1")
    use_handler(monkeypatch, lambda r: httpx.Response(200, json=ok_body()))
    with caplog.at_level(logging.WARNING, logger="listing.token_plan"):
        run(chat_completion([{"role": "user", "content": "x"}]))
    assert any("dashscope" in rec.getMessage() for rec in caplog.records)


def test_error_str_is_safe_to_log():
    err = TokenPlanError("http_status", request_id="abc123def456", status=429)
    s = str(err)
    assert "abc123def456" in s and "429" in s and "http_status" in s
