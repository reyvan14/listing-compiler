"""Streaming Agent responses: output protocol, execution trace, SSE events.

Two things live here.

**The output protocol.** A model reply carries human text *and* a structured
plan. Streaming them on one channel means the plan JSON would otherwise appear
in the chat bubble character by character before we could recognise it. So the
model is asked to wrap its output::

    <assistant_reply>…</assistant_reply>
    <agent_plan>{…}</agent_plan>

:class:`ReplyPlanSplitter` consumes that incrementally. It holds back any tail
that could still turn out to be the start of a delimiter, so a tag split across
network chunks is never mistaken for chat text, and plan JSON is never emitted
as a delta. Older replies that use a fenced ```json block, or a bare object
after the prose, are handled by the same parser.

**The execution trace.** A short, ordered list of stages the user can actually
verify — reading the canvas, checking the evidence ledger, planning,
validating. It is deliberately *not* the model's reasoning: nothing the model
emits reaches it, and ``reasoning_content`` is dropped at the provider
boundary in ``token_plan``. The UI calls it 执行过程.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any, AsyncIterator

import agent
import agent_plan
import token_plan

# --------------------------------------------------------------------------- #
# Output protocol                                                              #
# --------------------------------------------------------------------------- #

REPLY_OPEN = "<assistant_reply>"
REPLY_CLOSE = "</assistant_reply>"
PLAN_OPEN = "<agent_plan>"
PLAN_CLOSE = "</agent_plan>"

#: Anything that can begin a non-reply section. ``"\n{"`` catches a model that
#: skips the tags and just appends a bare JSON object on its own line.
_MARKERS = (REPLY_OPEN, REPLY_CLOSE, PLAN_OPEN, PLAN_CLOSE, "```", "\n{")

#: Cap on buffered plan text. A model that never closes its plan tag must not
#: be able to grow the buffer without bound.
MAX_PLAN_CHARS = 20_000
#: Cap on emitted reply text, mirroring the non-streaming path.
MAX_REPLY_CHARS = 1_500


def _partial_marker_len(buffer: str) -> int:
    """Length of the buffer suffix that could still grow into a marker.

    Holding this back is what makes the parser safe against a delimiter split
    across chunks: ``"<agent_"`` at the end of one chunk is not chat text.
    """
    longest = max(len(m) for m in _MARKERS)
    for size in range(min(longest - 1, len(buffer)), 0, -1):
        tail = buffer[-size:]
        if any(m.startswith(tail) for m in _MARKERS):
            return size
    return 0


def _json_object_end(text: str) -> int:
    """Index just past the first balanced JSON object in *text*, or ``-1``.

    String-aware, so a brace inside a prompt string does not end the object.
    """
    depth = 0
    in_string = False
    escaped = False
    started = False
    for i, ch in enumerate(text):
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
            started = True
        elif ch == "}":
            depth -= 1
            if started and depth == 0:
                return i + 1
    return -1


class ReplyPlanSplitter:
    """Incremental splitter for the streamed reply/plan protocol.

    ``feed`` returns only text that is definitely part of the human reply.
    ``finish`` returns the trailing reply text and the buffered plan JSON.
    """

    def __init__(self) -> None:
        self._buffer = ""
        self._plan = ""
        # "reply" | "plan"
        self._mode = "reply"
        # how the plan section was introduced: tag | fence | bare
        self._plan_kind = ""
        self._plan_closed = False
        self._emitted = 0
        self._seen_any = False

    # -- reply mode --------------------------------------------------------
    def _scan_reply(self) -> "tuple[str, bool]":
        """Consume as much of the buffer as is safely reply text."""
        best_at = -1
        best_marker = ""
        for marker in _MARKERS:
            at = self._buffer.find(marker)
            if at != -1 and (best_at == -1 or at < best_at):
                best_at, best_marker = at, marker

        # A stream that opens with a bare object is a plan with no prose.
        if not self._seen_any and self._buffer.lstrip().startswith("{"):
            lead = len(self._buffer) - len(self._buffer.lstrip())
            best_at, best_marker = lead, "{"

        if best_at == -1:
            hold = _partial_marker_len(self._buffer)
            text, self._buffer = self._buffer[: len(self._buffer) - hold], self._buffer[
                len(self._buffer) - hold :
            ]
            return text, False

        text = self._buffer[:best_at]
        if best_marker in (REPLY_OPEN, REPLY_CLOSE, PLAN_CLOSE):
            # Structural only; drop the tag and keep reading reply text. A
            # PLAN_CLOSE can legitimately land here when the plan's closing
            # brace already ended the section in an earlier chunk.
            self._buffer = self._buffer[best_at + len(best_marker) :]
            return text, True
        if best_marker == PLAN_OPEN:
            self._buffer = self._buffer[best_at + len(best_marker) :]
            self._plan_kind = "tag"
        elif best_marker == "```":
            rest = self._buffer[best_at + 3 :]
            # ```json — drop the language tag, keep the object.
            if rest[:4].lower() == "json":
                rest = rest[4:]
            self._buffer = rest.lstrip("\n")
            self._plan_kind = "fence"
        else:
            # bare object: the brace itself belongs to the plan
            self._buffer = self._buffer[best_at:].lstrip("\n")
            self._plan_kind = "bare"
        self._mode = "plan"
        return text, True

    # -- plan mode ---------------------------------------------------------
    def _scan_plan(self) -> bool:
        closer = PLAN_CLOSE if self._plan_kind == "tag" else "```"
        if self._plan_kind != "bare":
            at = self._buffer.find(closer)
            if at != -1:
                self._plan += self._buffer[:at]
                self._buffer = self._buffer[at + len(closer) :]
                self._mode = "reply"
                self._plan_closed = True
                return True
        # A balanced object ends the section even without its closer, so
        # trailing prose after the plan still reaches the user.
        end = _json_object_end(self._plan + self._buffer)
        if end != -1:
            combined = self._plan + self._buffer
            self._plan = combined[:end]
            rest = combined[end:]
            # Drop a closer that immediately follows the object.
            for tail in (PLAN_CLOSE, "```"):
                if rest.lstrip().startswith(tail):
                    rest = rest.lstrip()[len(tail) :]
                    break
            self._buffer = rest
            self._mode = "reply"
            self._plan_closed = True
            return True

        hold = len(closer) - 1
        keep = self._buffer[len(self._buffer) - hold :] if hold else ""
        self._plan += self._buffer[: len(self._buffer) - len(keep)]
        self._buffer = keep
        if len(self._plan) > MAX_PLAN_CHARS:
            self._plan = self._plan[:MAX_PLAN_CHARS]
        return False

    def feed(self, chunk: str) -> list[str]:
        """Reply-text fragments that are safe to emit right now."""
        if not chunk:
            return []
        self._buffer += chunk
        out: list[str] = []
        while True:
            if self._mode == "plan":
                if not self._scan_plan():
                    break
                continue
            text, again = self._scan_reply()
            if text:
                self._seen_any = True
                room = MAX_REPLY_CHARS - self._emitted
                if room > 0:
                    clipped = text[:room]
                    self._emitted += len(clipped)
                    out.append(clipped)
            if not again:
                break
        if out:
            self._seen_any = True
        return out

    def finish(self) -> "tuple[str, str | None]":
        """``(trailing reply text, plan json text or None)``."""
        if self._mode == "plan":
            self._plan += self._buffer
            self._buffer = ""
        tail = self._buffer
        self._buffer = ""

        plan = self._plan.strip()
        if plan and self._plan_kind == "bare":
            try:
                json.loads(plan)
            except (json.JSONDecodeError, ValueError):
                # Prose that merely began with a brace. Balanced braces are not
                # proof of JSON, so give the text back rather than losing it.
                tail, plan = plan + tail, ""

        room = MAX_REPLY_CHARS - self._emitted
        tail = tail[: max(0, room)]
        self._emitted += len(tail)
        return tail, plan or None


# --------------------------------------------------------------------------- #
# Execution trace                                                              #
# --------------------------------------------------------------------------- #

#: Ordered stages. ``applying`` / ``generating`` / ``completed`` are driven by
#: the client once the user approves, so the server never claims them.
STAGES = (
    "understanding",
    "reading_canvas",
    "checking_evidence",
    "planning",
    "validating",
    "ready",
    "applying",
    "generating",
    "completed",
    "failed",
    "cancelled",
)

STAGE_LABELS = {
    "understanding": "正在理解你的要求",
    "reading_canvas": "正在读取当前画布",
    "checking_evidence": "正在核对证据账本",
    "planning": "正在生成变更计划",
    "validating": "正在校验计划",
    "ready": "计划已就绪，等待你确认",
    "applying": "正在应用到画布",
    "generating": "正在生成内容",
    "completed": "已完成",
    "failed": "未完成",
    "cancelled": "已取消",
}


# --------------------------------------------------------------------------- #
# Event pipeline                                                               #
# --------------------------------------------------------------------------- #

#: How long to wait on a silent upstream before emitting a heartbeat.
HEARTBEAT_S = 10.0


async def _heartbeat_iter(source: AsyncIterator[str], interval: float):
    """Yield items from *source*, or ``None`` when it has been quiet.

    The pending ``__anext__`` is kept across heartbeats rather than cancelled,
    so a slow first token produces heartbeats without restarting the request.
    """
    pending: "asyncio.Future[str] | None" = None
    try:
        while True:
            if pending is None:
                pending = asyncio.ensure_future(source.__anext__())
            done, _ = await asyncio.wait({pending}, timeout=interval)
            if not done:
                yield None
                continue
            task, pending = pending, None
            try:
                item = task.result()
            except StopAsyncIteration:
                return
            yield item
    finally:
        if pending is not None:
            pending.cancel()
        aclose = getattr(source, "aclose", None)
        if aclose is not None:
            await aclose()


def _event(name: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {"event": name, "data": payload}


class _Trace:
    """Emits ordered, numbered status events."""

    def __init__(self) -> None:
        self.sequence = 0

    def status(self, stage: str, detail: str = "") -> dict[str, Any]:
        self.sequence += 1
        return _event(
            "status",
            {
                "stage": stage,
                "label": STAGE_LABELS.get(stage, stage),
                "detail": detail,
                "sequence": self.sequence,
            },
        )


def _canvas_detail(context: dict[str, Any]) -> str:
    nodes = context.get("nodes") or []
    connections = context.get("connections") or []
    selected = context.get("selectedNodeIds") or []
    parts = [f"{len(nodes)} 个节点", f"{len(connections)} 条连接"]
    if selected:
        parts.append(f"{len(selected)} 个已选中")
    return "，".join(parts)


def _evidence_detail(context: dict[str, Any]) -> str:
    summary = context.get("evidenceSummary") or {}
    verified = int(summary.get("verified") or 0)
    needs = int(summary.get("needsReview") or 0)
    conflicting = int(summary.get("conflicting") or 0)
    unsupported = int(summary.get("unsupported") or 0)
    if not any((verified, needs, conflicting, unsupported)):
        return "账本为空，宣称将标为无证据支撑"
    return (
        f"已核实 {verified}，待确认 {needs}，冲突 {conflicting}，无支撑 {unsupported}"
    )


async def stream_agent_events(
    messages: list[dict[str, Any]],
    context: "dict[str, Any] | None" = None,
) -> AsyncIterator[dict[str, Any]]:
    """Yield the ordered event stream for one Agent turn.

    Emits, in order: ``meta``, a run of ``status`` events, zero or more
    ``delta`` events, an optional ``plan``, and ``done``. ``error`` replaces
    the tail on failure and is always followed by ``done`` so the client can
    reset its busy state from a single place.
    """
    request_id = uuid.uuid4().hex[:12]
    trace = _Trace()
    yield _event("meta", {"requestId": request_id})

    cleaned = agent.clean_messages(messages)
    if not cleaned:
        yield _event("delta", {"text": "直接说你想搭的流程，或问三台规则。"})
        yield _event("done", {"requestId": request_id})
        return

    last_user = next((m["content"] for m in reversed(cleaned) if m["role"] == "user"), "")
    context = context or {}

    yield trace.status("understanding", last_user[:60])
    yield trace.status("reading_canvas", _canvas_detail(context))
    yield trace.status("checking_evidence", _evidence_detail(context))

    raw_plan: "dict[str, Any] | None" = None
    source = "template"
    reply_text = ""
    produced_delta = False

    if not token_plan.is_configured():
        # No provider: the audited template answers, and the trace says so
        # rather than implying a model was consulted.
        yield trace.status("planning", "未配置模型，使用确定性模板")
        raw_plan = agent_plan.deterministic_plan(last_user, context)
    else:
        yield trace.status("planning", "正在向模型请求结构化计划")
        splitter = ReplyPlanSplitter()
        stream = token_plan.chat_completion_stream(
            agent.build_prompt(cleaned, context), model=token_plan.agent_model()
        )
        try:
            async for item in _heartbeat_iter(stream, HEARTBEAT_S):
                if item is None:
                    yield _event("heartbeat", {"requestId": request_id})
                    continue
                for piece in splitter.feed(item):
                    reply_text += piece
                    produced_delta = True
                    yield _event("delta", {"text": piece})
        except asyncio.CancelledError:
            raise
        except token_plan.TokenPlanError as exc:
            if produced_delta:
                # Text is already on screen. Re-asking would duplicate it and
                # spend a second call, so stop and let the user retry.
                yield _event(
                    "warning",
                    {"message": "模型连接中断，已保留收到的部分回复。可以重试。"},
                )
                yield trace.status("failed", "上游中断")
                yield _event(
                    "error",
                    {
                        "category": exc.category,
                        "message": _safe_error_message(exc.category),
                        "retryable": exc.category in ("timeout", "network", "http_status"),
                    },
                )
                yield _event("done", {"requestId": request_id})
                return
            yield _event(
                "warning", {"message": "模型暂时不可用，已改用确定性模板。"}
            )
            raw_plan = agent_plan.deterministic_plan(last_user, context)
        else:
            tail, plan_json = splitter.finish()
            if tail:
                reply_text += tail
                produced_delta = True
                yield _event("delta", {"text": tail})
            if plan_json:
                try:
                    raw_plan = json.loads(plan_json)
                    source = "model"
                except (json.JSONDecodeError, ValueError):
                    raw_plan = None

    yield trace.status("validating", "对照允许清单校验每一步")

    plan = None
    if raw_plan is not None:
        try:
            plan = agent_plan.validate_plan(raw_plan)
        except agent_plan.PlanError as exc:
            # A plan we cannot trust is dropped, never repaired.
            yield _event("warning", {"message": f"模型给出的计划未通过校验，已丢弃（{exc}）。"})
            plan = None

    if plan is None and agent.looks_like_canvas_request(last_user):
        fallback = agent_plan.deterministic_plan(last_user, context)
        if fallback:
            plan = agent_plan.validate_plan(fallback)
            source = "template"

    if plan is not None:
        plan = agent_plan.with_rationale(
            plan, text=last_user, context=context, source=source
        )
        yield _event("plan", {"plan": plan})
        yield trace.status("ready", plan["title"])
    else:
        yield trace.status("ready", "本次没有画布改动")

    if not produced_delta:
        text = agent_plan.plan_reply(plan) if plan else agent.fallback_reply(last_user)
        yield _event("delta", {"text": text})

    yield _event("done", {"requestId": request_id})


def _safe_error_message(category: str) -> str:
    """User-facing text for a provider failure. Never carries provider detail."""
    return {
        "timeout": "模型响应超时。可以重试。",
        "network": "无法连接模型服务。可以重试。",
        "http_status": "模型服务返回错误。可以重试。",
        "invalid_response": "模型返回内容无法解析。可以重试。",
        "config": "模型未配置，本次使用确定性模板。",
    }.get(category, "模型调用失败。可以重试。")


def sse_frame(event: dict[str, Any]) -> str:
    """One SSE frame. Data is compact JSON on a single line."""
    body = json.dumps(event["data"], ensure_ascii=False, separators=(",", ":"))
    return f"event: {event['event']}\ndata: {body}\n\n"
