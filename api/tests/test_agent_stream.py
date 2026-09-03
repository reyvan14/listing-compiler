"""Streaming Agent: provider SSE parsing, output protocol, event ordering.

Nothing here reaches a network. The provider is an ``httpx.MockTransport`` that
replays byte-for-byte chunk sequences, so fragmentation is exercised exactly as
a real connection would deliver it.
"""

from __future__ import annotations

import asyncio
import json
import logging

import httpx
import pytest
from fastapi.testclient import TestClient

import agent_plan as ap
import agent_stream as astream
import app as app_module
import token_plan

client = TestClient(app_module.app)

CANONICAL = "创建三平台完整上新工作流，Amazon 1:1 白底，TikTok 9:16 场景图并生成 15 秒视频，Shopify 4:3"

SECRET = "sk-test-do-not-log-2f9c1"


def ctx(**over):
    base = {
        "selectedNodeIds": [],
        "nodes": [
            {
                "id": "shape:sku",
                "type": "sku_listing",
                "position": {"x": 36, "y": 36},
                "editableFields": {"productName": "折叠硅胶水杯 350ml", "uploadCount": 2},
                "status": "idle",
            }
        ],
        "connections": [],
        "evidenceSummary": {
            "verified": 1,
            "needsReview": 2,
            "conflicting": 0,
            "unsupported": 1,
        },
        "policyVersions": {},
    }
    base.update(over)
    return base


def chunk_stream(chunks):
    """A mock provider that emits *chunks* verbatim, in order."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"".join(c.encode() for c in chunks))

    def make(timeout):
        return httpx.AsyncClient(transport=httpx.MockTransport(handler), timeout=timeout)

    return make


def sse(obj) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"


def delta(text: str) -> dict:
    return {"choices": [{"delta": {"content": text}}]}


def read_events(monkeypatch, body) -> list[tuple[str, dict]]:
    """POST the streaming endpoint and parse the SSE body into events."""
    with client.stream("POST", "/api/agent/chat/stream", json=body) as resp:
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        assert resp.headers["x-accel-buffering"] == "no"
        assert "no-cache" in resp.headers["cache-control"]
        raw = "".join(resp.iter_text())
    out: list[tuple[str, dict]] = []
    for frame in raw.split("\n\n"):
        if not frame.strip():
            continue
        name = ""
        data = ""
        for line in frame.split("\n"):
            if line.startswith("event: "):
                name = line[7:]
            elif line.startswith("data: "):
                data = line[6:]
        if name:
            out.append((name, json.loads(data) if data else {}))
    return out


# --------------------------------------------------------------------------- #
# Provider SSE parsing                                                         #
# --------------------------------------------------------------------------- #


def test_frames_split_across_arbitrary_chunk_boundaries_are_reassembled():
    """Byte boundaries are a network artefact, never a parsing boundary."""
    body = sse(delta("你好")) + sse(delta("世界")) + "data: [DONE]\n\n"
    for size in (1, 3, 7, 13, len(body)):
        pieces = [body[i : i + size] for i in range(0, len(body), size)]
        buffer = ""
        seen = []
        for piece in pieces:
            buffer += piece
            frames, buffer = token_plan.iter_sse_frames(buffer)
            for frame in frames:
                seen.append(token_plan.sse_frame_data(frame))
        assert seen[-1] == "[DONE]", size
        texts = [
            token_plan._delta_text(json.loads(d)) for d in seen if d != "[DONE]"
        ]
        assert "".join(texts) == "你好世界", size


def test_crlf_frames_and_comment_heartbeats_are_handled():
    buffer = ": keep-alive\r\n\r\n" + "data: " + json.dumps(delta("ok")) + "\r\n\r\n"
    frames, rest = token_plan.iter_sse_frames(buffer)
    assert rest == ""
    assert token_plan.sse_frame_data(frames[0]) == ""  # comment only
    assert token_plan._delta_text(json.loads(token_plan.sse_frame_data(frames[1]))) == "ok"


def test_malformed_chunks_are_skipped_not_fatal(monkeypatch):
    monkeypatch.setenv("TOKEN_PLAN_API_KEY", SECRET)
    monkeypatch.setattr(
        token_plan,
        "_make_client",
        chunk_stream(
            [
                "data: {not json at all}\n\n",
                sse(delta("有效")),
                "data: \n\n",
                sse(delta("内容")),
                "data: [DONE]\n\n",
            ]
        ),
    )

    async def run():
        return [t async for t in token_plan.chat_completion_stream([{"role": "user", "content": "x"}])]

    assert "".join(asyncio.run(run())) == "有效内容"


def test_reasoning_content_is_never_surfaced(monkeypatch):
    """Hidden reasoning must not leave the provider boundary."""
    monkeypatch.setenv("TOKEN_PLAN_API_KEY", SECRET)
    monkeypatch.setattr(
        token_plan,
        "_make_client",
        chunk_stream(
            [
                sse({"choices": [{"delta": {"reasoning_content": "先想一想…"}}]}),
                sse(delta("答案")),
                "data: [DONE]\n\n",
            ]
        ),
    )

    async def run():
        return [t async for t in token_plan.chat_completion_stream([{"role": "user", "content": "x"}])]

    assert asyncio.run(run()) == ["答案"]


def test_stream_http_error_is_sanitized_and_logs_no_secret(monkeypatch, caplog):
    monkeypatch.setenv("TOKEN_PLAN_API_KEY", SECRET)

    def handler(request):
        assert request.headers["authorization"] == f"Bearer {SECRET}"
        return httpx.Response(429, json={"error": "quota", "key": SECRET})

    monkeypatch.setattr(
        token_plan,
        "_make_client",
        lambda timeout: httpx.AsyncClient(
            transport=httpx.MockTransport(handler), timeout=timeout
        ),
    )

    async def run():
        return [t async for t in token_plan.chat_completion_stream([{"role": "user", "content": "x"}])]

    with caplog.at_level(logging.DEBUG):
        with pytest.raises(token_plan.TokenPlanError) as excinfo:
            asyncio.run(run())

    assert excinfo.value.category == "http_status"
    assert SECRET not in str(excinfo.value)
    blob = " ".join(r.getMessage() for r in caplog.records)
    assert SECRET not in blob
    assert "quota" not in blob


def test_client_cancellation_closes_the_upstream_stream(monkeypatch):
    """Stopping the consumer must stop the provider request, not orphan it."""
    monkeypatch.setenv("TOKEN_PLAN_API_KEY", SECRET)
    closed = {"value": False}

    class TrackingTransport(httpx.MockTransport):
        async def handle_async_request(self, request):
            response = await super().handle_async_request(request)
            original = response.aclose

            async def aclose():
                closed["value"] = True
                await original()

            response.aclose = aclose
            return response

    body = "".join(sse(delta(f"片段{i}")) for i in range(50))
    monkeypatch.setattr(
        token_plan,
        "_make_client",
        lambda timeout: httpx.AsyncClient(
            transport=TrackingTransport(lambda r: httpx.Response(200, content=body.encode())),
            timeout=timeout,
        ),
    )

    async def run():
        stream = token_plan.chat_completion_stream([{"role": "user", "content": "x"}])
        async for _ in stream:
            break  # abandon after the first fragment
        await stream.aclose()

    asyncio.run(run())
    assert closed["value"] is True


# --------------------------------------------------------------------------- #
# Output protocol                                                              #
# --------------------------------------------------------------------------- #

TAGGED = (
    "<assistant_reply>我拟了一个方案，请确认。</assistant_reply>"
    '<agent_plan>{"title":"T","summary":"S","operations":['
    '{"type":"create_node","tempId":"a","nodeType":"image_generation",'
    '"fields":{"aspectRatio":"1:1"}}]}</agent_plan>'
)


@pytest.mark.parametrize("size", [1, 2, 5, 11, 40, len(TAGGED)])
def test_delimiters_split_across_chunks_never_leak_plan_json(size):
    splitter = astream.ReplyPlanSplitter()
    emitted = []
    for i in range(0, len(TAGGED), size):
        emitted.extend(splitter.feed(TAGGED[i : i + size]))
    tail, plan_json = splitter.finish()
    text = "".join(emitted) + tail

    assert text == "我拟了一个方案，请确认。"
    for leak in ("<agent_plan>", "operations", "create_node", "{", "}"):
        assert leak not in text, (size, leak)
    assert json.loads(plan_json)["title"] == "T"


def test_a_fenced_json_block_is_treated_as_the_plan():
    splitter = astream.ReplyPlanSplitter()
    out = splitter.feed('先看看这个方案。\n```json\n{"title":"X","operations":[]}\n```\n')
    tail, plan_json = splitter.finish()
    assert "".join(out).strip() == "先看看这个方案。"
    assert json.loads(plan_json)["title"] == "X"
    assert "{" not in "".join(out)


def test_a_bare_object_after_prose_is_buffered_not_shown():
    splitter = astream.ReplyPlanSplitter()
    out = splitter.feed('好的。\n{"title":"Y","operations":[]}')
    tail, plan_json = splitter.finish()
    assert ("".join(out) + tail).strip() == "好的。"
    assert json.loads(plan_json)["title"] == "Y"


def test_prose_that_merely_starts_with_a_brace_is_given_back_to_the_user():
    """Nothing the user typed should silently vanish into a plan buffer."""
    splitter = astream.ReplyPlanSplitter()
    out = splitter.feed("说明如下。\n{这不是 JSON，只是普通文字}")
    tail, plan_json = splitter.finish()
    assert plan_json is None
    assert "这不是 JSON" in ("".join(out) + tail)


def test_trailing_prose_after_the_plan_still_reaches_the_user():
    splitter = astream.ReplyPlanSplitter()
    out = splitter.feed(
        '开始。<agent_plan>{"title":"Z","operations":[]}</agent_plan>结束。'
    )
    tail, plan_json = splitter.finish()
    text = "".join(out) + tail
    assert text == "开始。结束。"
    assert json.loads(plan_json)["title"] == "Z"


# --------------------------------------------------------------------------- #
# Endpoint: event ordering and content                                         #
# --------------------------------------------------------------------------- #


def test_deterministic_workflow_streams_status_then_plan_then_done(monkeypatch):
    """No provider configured: the audited template still narrates its work."""
    events = read_events(
        monkeypatch,
        {"messages": [{"role": "user", "content": CANONICAL}], "context": ctx()},
    )
    names = [name for name, _ in events]

    assert names[0] == "meta"
    assert names[-1] == "done"
    assert names.index("plan") < names.index("done")

    stages = [d["stage"] for n, d in events if n == "status"]
    assert stages[:5] == [
        "understanding",
        "reading_canvas",
        "checking_evidence",
        "planning",
        "validating",
    ]
    assert "ready" in stages
    # sequence numbers are monotonic and gap-free
    seqs = [d["sequence"] for n, d in events if n == "status"]
    assert seqs == list(range(1, len(seqs) + 1))

    # the trace reports verifiable facts, not narration
    detail = {d["stage"]: d["detail"] for n, d in events if n == "status"}
    assert "1 个节点" in detail["reading_canvas"]
    assert "待确认 2" in detail["checking_evidence"]
    assert "确定性模板" in detail["planning"]


def test_the_streamed_canonical_plan_matches_the_audited_template(monkeypatch):
    events = read_events(
        monkeypatch,
        {"messages": [{"role": "user", "content": CANONICAL}], "context": ctx()},
    )
    plan = next(d["plan"] for n, d in events if n == "plan")

    creates = [o for o in plan["operations"] if o["type"] == "create_node"]
    ratios = [o["fields"].get("aspectRatio") for o in creates]
    assert sorted(r for r in ratios if r) == ["1:1", "4:3", "9:16", "9:16"]

    video = next(o for o in creates if o["nodeType"] == "video_generation")
    assert video["fields"]["duration"] == "15s"

    assert len([o for o in plan["operations"] if o["type"] == "connect_nodes"]) == 4

    runs = [o for o in plan["operations"] if o["type"] == "run_nodes"]
    assert runs and runs[0]["nodeIds"] == ["shape:sku"]
    assert plan["requiresRunConfirmation"] is True

    # compact 2x2: two distinct columns, two distinct rows
    slots = {(o["position"]["x"], o["position"]["y"]) for o in creates}
    assert len({x for x, _ in slots}) == 2
    assert len({y for _, y in slots}) == 2


def test_the_plan_carries_a_structured_rationale_and_no_free_text_reasoning(monkeypatch):
    events = read_events(
        monkeypatch,
        {"messages": [{"role": "user", "content": CANONICAL}], "context": ctx()},
    )
    rationale = next(d["plan"] for n, d in events if n == "plan")["rationale"]

    assert rationale["source"] == "template"
    assert rationale["platforms"] == ["Amazon", "TikTok Shop", "Shopify"]
    assert rationale["estimatedModelCalls"] == 4
    assert rationale["requiresRunConfirmation"] is True
    assert rationale["publishes"] is False
    assert {n["nodeType"] for n in rationale["nodes"]} == {
        "image_generation",
        "video_generation",
    }
    # Every value is a short structured field, never a paragraph of reasoning.
    assert "reasoning" not in json.dumps(rationale, ensure_ascii=False).lower()
    assert "思考" not in json.dumps(rationale, ensure_ascii=False)


def test_a_question_streams_text_and_no_plan(monkeypatch):
    events = read_events(
        monkeypatch,
        {"messages": [{"role": "user", "content": "主图能加字吗"}], "context": ctx()},
    )
    assert not any(n == "plan" for n, _ in events)
    text = "".join(d["text"] for n, d in events if n == "delta")
    assert text
    assert "{" not in text


def test_model_plan_streams_deltas_first_and_the_plan_only_after_validation(monkeypatch):
    monkeypatch.setenv("TOKEN_PLAN_API_KEY", SECRET)
    reply = (
        "<assistant_reply>我拟了一个方案。</assistant_reply>"
        '<agent_plan>{"title":"模型计划","summary":"S","estimatedModelCalls":1,'
        '"operations":[{"type":"create_node","tempId":"a",'
        '"nodeType":"image_generation","fields":{"aspectRatio":"1:1"}}]}</agent_plan>'
    )
    # one character per SSE frame: maximum fragmentation
    monkeypatch.setattr(
        token_plan,
        "_make_client",
        chunk_stream([sse(delta(ch)) for ch in reply] + ["data: [DONE]\n\n"]),
    )

    events = read_events(
        monkeypatch,
        {"messages": [{"role": "user", "content": "帮我加一个白底主图节点"}], "context": ctx()},
    )
    names = [n for n, _ in events]
    assert names.index("delta") < names.index("plan")

    text = "".join(d["text"] for n, d in events if n == "delta")
    assert text == "我拟了一个方案。"
    assert "agent_plan" not in text and "{" not in text

    plan = next(d["plan"] for n, d in events if n == "plan")
    assert plan["title"] == "模型计划"
    assert plan["rationale"]["source"] == "model"


def test_an_invalid_model_plan_is_dropped_and_the_template_answers(monkeypatch):
    monkeypatch.setenv("TOKEN_PLAN_API_KEY", SECRET)
    reply = (
        "<assistant_reply>好的。</assistant_reply>"
        '<agent_plan>{"title":"坏计划","operations":['
        '{"type":"exec","command":"rm -rf /"}]}</agent_plan>'
    )
    monkeypatch.setattr(
        token_plan, "_make_client", chunk_stream([sse(delta(reply)), "data: [DONE]\n\n"])
    )

    events = read_events(
        monkeypatch,
        {"messages": [{"role": "user", "content": CANONICAL}], "context": ctx()},
    )
    warnings = [d["message"] for n, d in events if n == "warning"]
    assert any("未通过校验" in w for w in warnings)

    plan = next(d["plan"] for n, d in events if n == "plan")
    assert plan["rationale"]["source"] == "template"
    assert {o["type"] for o in plan["operations"]} <= set(ap.OPERATION_TYPES)
    assert "exec" not in json.dumps(plan, ensure_ascii=False)


def test_no_second_model_request_after_a_partial_failure(monkeypatch):
    """Once text has been shown, a retry would duplicate it and cost twice."""
    monkeypatch.setenv("TOKEN_PLAN_API_KEY", SECRET)
    calls = {"count": 0}

    def handler(request):
        calls["count"] += 1
        # A well-formed frame, then a truncated one, then the connection drops.
        body = sse(delta("先说一句")) + 'data: {"choices":'
        return httpx.Response(200, content=body.encode())

    monkeypatch.setattr(
        token_plan,
        "_make_client",
        lambda timeout: httpx.AsyncClient(
            transport=httpx.MockTransport(handler), timeout=timeout
        ),
    )

    events = read_events(
        monkeypatch,
        {"messages": [{"role": "user", "content": CANONICAL}], "context": ctx()},
    )
    assert calls["count"] == 1
    text = "".join(d["text"] for n, d in events if n == "delta")
    assert "先说一句" in text
    assert [n for n, _ in events][-1] == "done"


def test_a_provider_failure_before_any_text_falls_back_to_the_template(monkeypatch):
    monkeypatch.setenv("TOKEN_PLAN_API_KEY", SECRET)
    monkeypatch.setattr(
        token_plan,
        "_make_client",
        lambda timeout: httpx.AsyncClient(
            transport=httpx.MockTransport(lambda r: httpx.Response(503)), timeout=timeout
        ),
    )

    events = read_events(
        monkeypatch,
        {"messages": [{"role": "user", "content": CANONICAL}], "context": ctx()},
    )
    warnings = [d["message"] for n, d in events if n == "warning"]
    assert any("确定性模板" in w for w in warnings)
    plan = next(d["plan"] for n, d in events if n == "plan")
    assert plan["rationale"]["source"] == "template"
    assert SECRET not in json.dumps(events, ensure_ascii=False)


def test_the_non_streaming_endpoint_is_unchanged(monkeypatch):
    """Backward compatibility: the old contract still holds."""
    res = client.post(
        "/api/agent/chat",
        json={"messages": [{"role": "user", "content": CANONICAL}], "context": ctx()},
    )
    assert res.status_code == 200
    data = res.json()["data"]
    assert set(data) == {"reply", "plan"}
    assert isinstance(data["reply"], str) and data["reply"]
    assert data["plan"]["requiresRunConfirmation"] is True


def test_no_event_payload_ever_contains_a_secret_or_a_prompt(monkeypatch):
    monkeypatch.setenv("TOKEN_PLAN_API_KEY", SECRET)
    monkeypatch.setattr(
        token_plan,
        "_make_client",
        chunk_stream([sse(delta("<assistant_reply>好的。</assistant_reply>")), "data: [DONE]\n\n"]),
    )
    events = read_events(
        monkeypatch,
        {"messages": [{"role": "user", "content": CANONICAL}], "context": ctx()},
    )
    blob = json.dumps(events, ensure_ascii=False)
    assert SECRET not in blob
    assert "Authorization" not in blob
    assert "system" not in blob.lower() or "systemd" in blob.lower()
