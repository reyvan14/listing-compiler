"""Typed domain actions the Agent may request.

The model never names an endpoint, a URL, an HTTP method, a file path or a
command. It picks an ``action`` from a closed list and supplies typed
parameters; this module decides what that means and calls the real subsystem.
Anything not on the list is rejected before dispatch, so the blast radius of a
prompt injection is "an action the product already offers", not "whatever the
attacker can phrase".

Two gates sit in front of execution.

*Read-only* actions may run once the plan is approved: reading a passport or a
policy impact changes nothing and costs nothing.

*Consequential* actions -- approving a revision, applying a migration,
exporting a handoff package, spending money on media -- require a second,
explicit confirmation carrying the action's own confirmation token. Approving a
plan is not consent to spend or to sign something.

Retries are idempotent by construction. Every request carries a client-supplied
key; a repeat with the same key returns the first result instead of doing the
work twice, which is what stops a double-click or a network retry from
exporting twice or paying twice.

Publishing is not on the list, and there is no code path that could add it at
runtime.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import intake
from evidence import store

_LOCK = threading.RLock()
_SCHEMA = "listing-agent-actions/v1"

# Result states -------------------------------------------------------------- #

OK = "ok"
REJECTED = "rejected"
NEEDS_CONFIRMATION = "needs_confirmation"
FAILED = "failed"
UNAVAILABLE = "unavailable"

MAX_ACTIONS_PER_PLAN = 8


class ActionError(ValueError):
    def __init__(self, code: str, message: str, status: int = 400) -> None:
        self.code = code
        self.safe_message = message
        self.http_status = status
        super().__init__(message)


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


# --------------------------------------------------------------------------- #
# The allow-list                                                               #
# --------------------------------------------------------------------------- #


class ActionSpec:
    """One permitted action: its parameters, its risk, and what runs it."""

    def __init__(
        self,
        name: str,
        *,
        label: str,
        summary: str,
        params: dict[str, type],
        required: tuple[str, ...] = (),
        read_only: bool = True,
        requires_confirmation: bool = False,
        costs_money: bool = False,
        confirm_prompt: str = "",
    ) -> None:
        self.name = name
        self.label = label
        self.summary = summary
        self.params = params
        self.required = required
        self.read_only = read_only
        self.requires_confirmation = requires_confirmation
        self.costs_money = costs_money
        self.confirm_prompt = confirm_prompt

    def as_dict(self) -> dict[str, Any]:
        return {
            "action": self.name,
            "label": self.label,
            "summary": self.summary,
            "params": {k: v.__name__ for k, v in self.params.items()},
            "required": list(self.required),
            "read_only": self.read_only,
            "requires_confirmation": self.requires_confirmation,
            "costs_money": self.costs_money,
            "confirm_prompt": self.confirm_prompt,
        }


ACTIONS: dict[str, ActionSpec] = {
    "validate_listing": ActionSpec(
        "validate_listing",
        label="校验文案",
        summary="对指定修订运行确定性校验，不改动任何内容。",
        params={"revision_id": str},
        required=("revision_id",),
    ),
    "inspect_image": ActionSpec(
        "inspect_image",
        label="检查图片",
        summary="按像素重新检查已存储的图片资产。",
        params={"asset_id": str},
        required=("asset_id",),
    ),
    "open_release_passport": ActionSpec(
        "open_release_passport",
        label="查看发布护照",
        summary="读取已存在的发布护照，不重新计算，不导出。",
        params={"passport_id": str},
        required=("passport_id",),
    ),
    "build_release_passport": ActionSpec(
        "build_release_passport",
        label="生成发布护照",
        summary="按当前记录重新计算就绪状态并存储护照。",
        params={"sku_id": str, "platform": str},
        required=("sku_id", "platform"),
        read_only=False,
    ),
    "export_release_package": ActionSpec(
        "export_release_package",
        label="导出交接包",
        summary="生成并校验交接包 ZIP。不会向任何平台发布。",
        params={"passport_id": str},
        required=("passport_id",),
        read_only=False,
        requires_confirmation=True,
        confirm_prompt="导出交接包会把已批准文案、图片原件与审批记录打包。不会发布到任何平台。确认导出？",
    ),
    "analyze_policy_impact": ActionSpec(
        "analyze_policy_impact",
        label="分析政策影响面",
        summary="计算一次政策变更影响到哪些产物，不改写任何产物。",
        params={"base": str, "candidate": str},
        required=("base", "candidate"),
    ),
    "build_migration_candidate": ActionSpec(
        "build_migration_candidate",
        label="生成迁移候选补丁",
        summary="为受影响字段生成候选补丁供人工审阅。当前产物不被改写。",
        params={"platform": str, "fields": list},
        required=("platform",),
        read_only=False,
        requires_confirmation=True,
        confirm_prompt="生成迁移候选补丁可能调用模型并产生费用。当前已批准内容不会被改写。确认继续？",
        costs_money=True,
    ),
    "open_evidence_source": ActionSpec(
        "open_evidence_source",
        label="查看证据文件",
        summary="读取一份证据文件的元数据与关联事实。",
        params={"source_id": str},
        required=("source_id",),
    ),
    "analyze_feedback": ActionSpec(
        "analyze_feedback",
        label="分析投放反馈",
        summary="对已导入的表现数据做确定性分析，产出候选改进项。",
        params={"import_id": str},
        required=("import_id",),
    ),
    "create_experiment": ActionSpec(
        "create_experiment",
        label="创建实验",
        summary="登记一次 A/B 实验的假设、基线修订与候选修订。",
        params={"hypothesis": str, "baseline_revision_id": str, "candidate_revision_id": str},
        required=("hypothesis", "baseline_revision_id"),
        read_only=False,
    ),
}

#: Actions that stay refused no matter what. Named so the refusal is explicit
#: rather than implied by absence.
FORBIDDEN = (
    "publish_listing",
    "submit_to_marketplace",
    "delete_project",
    "run_shell",
    "http_request",
    "read_file",
    "write_file",
)


def catalog() -> list[dict[str, Any]]:
    return [ACTIONS[name].as_dict() for name in sorted(ACTIONS)]


# --------------------------------------------------------------------------- #
# Validation                                                                   #
# --------------------------------------------------------------------------- #

#: Most parameters are entity ids and short enums. They are validated against a
#: positive allow-list rather than a blacklist of dangerous shapes: a blacklist
#: only refuses the attacks someone thought of, and this one already missed
#: "rev-1; rm -rf /" once. If a value is not id-shaped, it is refused.
_MAX_PARAM_CHARS = 200
_ID_PARAM = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$")

#: Parameters that are genuinely prose. Bounded and stripped of instruction
#: shapes, but not required to look like an id.
_FREE_TEXT_PARAMS = frozenset({"hypothesis"})
_MAX_TEXT_CHARS = 500

#: Parameters that are human-chosen names rather than generated ids. A SKU is
#: identified by its product name in this product, so it is routinely Chinese
#: and contains spaces — the id pattern would reject every real one. These are
#: bounded and refused if they contain anything that could act as a path
#: separator, a control character, or protocol syntax.
_NAME_PARAMS = frozenset({"sku_id"})
_MAX_NAME_CHARS = 120
_UNSAFE_IN_NAME = ("/", "\\", "..", "\x00", "\n", "\r", "\t", "://", "<", ">")


def validate_action(raw: Any) -> dict[str, Any]:
    """Type-check one requested action. Raises ``ActionError`` on anything odd."""
    if not isinstance(raw, dict):
        raise ActionError("bad_action", "操作格式不正确。")

    name = str(raw.get("action") or "").strip()
    if name in FORBIDDEN:
        raise ActionError("forbidden_action", f"操作 {name} 永远不被允许。", status=403)
    spec = ACTIONS.get(name)
    if spec is None:
        raise ActionError("unknown_action", f"未知操作：{name or '(空)'}", status=400)

    supplied = raw.get("params")
    if supplied is None:
        supplied = {}
    if not isinstance(supplied, dict):
        raise ActionError("bad_params", f"{name} 的参数格式不正确。")

    unknown = sorted(set(supplied) - set(spec.params))
    if unknown:
        raise ActionError("unknown_param", f"{name} 不接受参数：{'、'.join(unknown)}")

    cleaned: dict[str, Any] = {}
    for key, expected in spec.params.items():
        if key not in supplied:
            if key in spec.required:
                raise ActionError("missing_param", f"{name} 缺少必需参数：{key}")
            continue
        value = supplied[key]
        if expected is str:
            text = str(value).strip()
            if key in _NAME_PARAMS:
                if not text:
                    raise ActionError("missing_param", f"{name} 缺少必需参数：{key}")
                if len(text) > _MAX_NAME_CHARS:
                    raise ActionError("param_too_long", f"{name}.{key} 超出长度上限。")
                if any(bad in text for bad in _UNSAFE_IN_NAME):
                    raise ActionError(
                        "unsafe_param",
                        f"{name}.{key} 含有不允许的字符，已拒绝。",
                        status=400,
                    )
                cleaned[key] = text
                continue
            if key in _FREE_TEXT_PARAMS:
                if len(text) > _MAX_TEXT_CHARS:
                    raise ActionError("param_too_long", f"{name}.{key} 超出长度上限。")
                # Prose is stored as data. It never becomes an instruction, and
                # it never becomes a path.
                cleaned[key] = intake.sanitize_for_prompt(text, limit=_MAX_TEXT_CHARS)
                continue
            if len(text) > _MAX_PARAM_CHARS:
                raise ActionError("param_too_long", f"{name}.{key} 超出长度上限。")
            if not _ID_PARAM.match(text):
                raise ActionError(
                    "unsafe_param",
                    f"{name}.{key} 不是合法的标识符，已拒绝。",
                    status=400,
                )
            cleaned[key] = text
        elif expected is list:
            if not isinstance(value, list) or len(value) > 40:
                raise ActionError("bad_params", f"{name}.{key} 必须是长度 ≤ 40 的列表。")
            items = [str(v).strip() for v in value]
            bad = [v for v in items if not _ID_PARAM.match(v)]
            if bad:
                raise ActionError("unsafe_param", f"{name}.{key} 含有非法标识符，已拒绝。")
            cleaned[key] = items
        else:  # pragma: no cover - no other types declared today
            cleaned[key] = value

    return {"action": name, "params": cleaned, "spec": spec}


def validate_plan(actions: Any) -> list[dict[str, Any]]:
    """Validate a whole requested plan. All or nothing."""
    if not isinstance(actions, list):
        raise ActionError("bad_plan", "操作计划格式不正确。")
    if len(actions) > MAX_ACTIONS_PER_PLAN:
        raise ActionError(
            "too_many_actions", f"一次最多 {MAX_ACTIONS_PER_PLAN} 个操作。"
        )
    return [validate_action(item) for item in actions]


def preview(actions: list[dict[str, Any]]) -> dict[str, Any]:
    """What a plan would do, before anything runs."""
    rows = []
    for validated in actions:
        spec: ActionSpec = validated["spec"]
        rows.append(
            {
                "action": spec.name,
                "label": spec.label,
                "summary": spec.summary,
                "params": validated["params"],
                "read_only": spec.read_only,
                "requires_confirmation": spec.requires_confirmation,
                "costs_money": spec.costs_money,
                "confirm_prompt": spec.confirm_prompt,
            }
        )
    return {
        "actions": rows,
        "read_only": all(r["read_only"] for r in rows),
        "needs_confirmation": [r["action"] for r in rows if r["requires_confirmation"]],
        "publishes": False,
    }


def confirmation_token(action: str, params: dict[str, Any]) -> str:
    """A token bound to this exact action and parameters.

    Confirming an export of passport A must not authorise an export of passport
    B, so the token is derived from the payload rather than being a bare "yes".
    """
    payload = json.dumps({"action": action, "params": params}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:32]


# --------------------------------------------------------------------------- #
# Idempotency ledger                                                           #
# --------------------------------------------------------------------------- #


def _ledger_path() -> Path:
    return store.store_dir() / "agent_actions.json"


def _blank() -> dict[str, Any]:
    return {"schema": _SCHEMA, "runs": {}}


def read_ledger() -> dict[str, Any]:
    path = _ledger_path()
    if not path.exists():
        return _blank()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return _blank()
    if not isinstance(data, dict) or not isinstance(data.get("runs"), dict):
        return _blank()
    return data


def _write_ledger(ledger: dict[str, Any]) -> None:
    path = _ledger_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(ledger, handle, ensure_ascii=False, indent=2, sort_keys=True)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def _recorded(key: str) -> "dict[str, Any] | None":
    return read_ledger()["runs"].get(key)


def _record(key: str, result: dict[str, Any]) -> None:
    with _LOCK:
        ledger = read_ledger()
        ledger["runs"][key] = result
        _write_ledger(ledger)


# --------------------------------------------------------------------------- #
# Handlers                                                                     #
# --------------------------------------------------------------------------- #


def _h_validate_listing(params: dict[str, Any]) -> dict[str, Any]:
    import review

    revision = review.get_revision(params["revision_id"])
    result = review.run_validation(revision)
    return {
        "revision_id": revision["revision_id"],
        "blockers": result["blockers"],
        "warnings": result["warnings"],
        "policy_snapshot_ids": result["policy_snapshot_ids"],
        "checks": result["checks"],
    }


def _h_inspect_image(params: dict[str, Any]) -> dict[str, Any]:
    import mediaassets

    asset = mediaassets.get_asset(params["asset_id"])
    verified = mediaassets.verify_asset(params["asset_id"])
    return {
        "asset_id": asset["asset_id"],
        "summary": asset["summary"],
        "results": asset["results"],
        "checksum": verified,
    }


def _h_open_release_passport(params: dict[str, Any]) -> dict[str, Any]:
    import passport

    record = passport.get(params["passport_id"])
    return {
        "passport_id": record["passport_id"],
        "readiness": record["readiness"],
        "readiness_reasons": record["readiness_reasons"],
        "revision_id": record["revision_id"],
        "manual_review": record["manual_review"],
    }


def _h_build_release_passport(params: dict[str, Any]) -> dict[str, Any]:
    import passport

    record = passport.build(params["sku_id"], params["platform"])
    return {
        "passport_id": record["passport_id"],
        "readiness": record["readiness"],
        "readiness_reasons": record["readiness_reasons"],
        "content_digest": record["content_digest"],
    }


def _h_export_release_package(params: dict[str, Any]) -> dict[str, Any]:
    import passport

    built = passport.build_package(params["passport_id"])
    return {
        "passport_id": params["passport_id"],
        "digest": built["export"]["digest"],
        "files": built["export"]["files"],
        "bytes": built["export"]["bytes"],
        "verified": built["export"]["verified"],
        "published": False,
        "note": "已生成并校验交接包。本工具没有向任何平台发布。",
    }


def _h_analyze_policy_impact(params: dict[str, Any]) -> dict[str, Any]:
    import policy

    base = policy.get_snapshot(params["base"])
    candidate = policy.get_snapshot(params["candidate"])
    diff = policy.diff_snapshots(base, candidate).to_dict()
    return {
        "base": params["base"],
        "candidate": params["candidate"],
        "added": [r["id"] for r in diff["added"]],
        "removed": [r["id"] for r in diff["removed"]],
        "changed": [c["rule_id"] for c in diff["changed"]],
        "affected_fields": diff["affected_fields"],
    }


def _h_build_migration_candidate(params: dict[str, Any]) -> dict[str, Any]:
    """Deliberately does not call a model here.

    The migration engine's candidate builder is an async, request-shaped API.
    Rather than half-invoke it, this action reports what it would target and
    hands the operator to the existing migration panel, which already has the
    preview-and-approve flow. Claiming to have built a patch we did not build
    would be exactly the kind of fake progress the spec forbids.
    """
    return {
        "platform": params["platform"],
        "fields": params.get("fields", []),
        "built": False,
        "handoff": "migration_panel",
        "note": "已定位到受影响平台与字段；候选补丁请在「规则变更 / 迁移」面板中生成并逐项批准。",
    }


def _h_open_evidence_source(params: dict[str, Any]) -> dict[str, Any]:
    from evidence import facts as facts_module

    source = store.get_source(params["source_id"])
    linked = [
        {"fact_id": f["fact_id"], "key": f["key"], "state": f["state"]}
        for f in facts_module.list_facts()
        if any(s.get("source_id") == params["source_id"] for s in f.get("sources", []))
    ]
    return {
        "source_id": source["source_id"],
        "filename": source["filename"],
        "mime_type": source["mime_type"],
        "sha256": source["sha256"],
        "uploaded_at": source["uploaded_at"],
        "linked_facts": linked,
    }


def _h_analyze_feedback(params: dict[str, Any]) -> dict[str, Any]:
    try:
        import feedback
    except ImportError:
        raise _unavailable("analyze_feedback")
    return feedback.analyze_import(params["import_id"])


def _h_create_experiment(params: dict[str, Any]) -> dict[str, Any]:
    try:
        import feedback
    except ImportError:
        raise _unavailable("create_experiment")
    return feedback.create_experiment(
        hypothesis=params["hypothesis"],
        baseline_revision_id=params["baseline_revision_id"],
        candidate_revision_id=params.get("candidate_revision_id", ""),
    )


def _unavailable(action: str) -> ActionError:
    return ActionError(
        "capability_unavailable",
        f"本次构建未包含 {action} 所需的能力。",
        status=501,
    )


HANDLERS: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
    "validate_listing": _h_validate_listing,
    "inspect_image": _h_inspect_image,
    "open_release_passport": _h_open_release_passport,
    "build_release_passport": _h_build_release_passport,
    "export_release_package": _h_export_release_package,
    "analyze_policy_impact": _h_analyze_policy_impact,
    "build_migration_candidate": _h_build_migration_candidate,
    "open_evidence_source": _h_open_evidence_source,
    "analyze_feedback": _h_analyze_feedback,
    "create_experiment": _h_create_experiment,
}


# --------------------------------------------------------------------------- #
# Execution                                                                    #
# --------------------------------------------------------------------------- #


def execute(
    raw_action: Any,
    *,
    idempotency_key: str,
    confirmed_token: str = "",
) -> dict[str, Any]:
    """Run one validated action, at most once per idempotency key.

    The returned record is the execution trace entry: what was requested, what
    was validated, whether a confirmation was required and supplied, and the
    real result. There is no field for model reasoning, and nothing here
    fabricates progress.
    """
    key = (idempotency_key or "").strip()[:120]
    if not key:
        raise ActionError("missing_idempotency_key", "缺少幂等标识，已拒绝执行。")

    previous = _recorded(key)
    if previous is not None:
        # A retry returns the first outcome rather than repeating the work.
        return {**previous, "replayed": True}

    validated = validate_action(raw_action)
    spec: ActionSpec = validated["spec"]
    params = validated["params"]
    expected = confirmation_token(spec.name, params)

    if spec.requires_confirmation and confirmed_token != expected:
        # Not recorded: nothing happened, so a later confirmed attempt with the
        # same key must still be allowed to run.
        return {
            "action": spec.name,
            "params": params,
            "state": NEEDS_CONFIRMATION,
            "confirmation_token": expected,
            "confirm_prompt": spec.confirm_prompt,
            "costs_money": spec.costs_money,
            "message": "该操作需要单独确认后才会执行。",
            "at": _now(),
            "replayed": False,
        }

    started = _now()
    try:
        result = HANDLERS[spec.name](params)
        record = {
            "action": spec.name,
            "params": params,
            "state": OK,
            "read_only": spec.read_only,
            "confirmed": bool(spec.requires_confirmation),
            "result": result,
            "started_at": started,
            "at": _now(),
            "idempotency_key": key,
            "replayed": False,
        }
    except ActionError as exc:
        record = {
            "action": spec.name,
            "params": params,
            "state": UNAVAILABLE if exc.code == "capability_unavailable" else REJECTED,
            "error": exc.code,
            "message": exc.safe_message,
            "started_at": started,
            "at": _now(),
            "idempotency_key": key,
            "replayed": False,
        }
    except Exception as exc:  # noqa: BLE001 - surface a safe, typed failure
        record = {
            "action": spec.name,
            "params": params,
            "state": FAILED,
            "error": type(exc).__name__,
            "message": "操作执行失败，未产生任何更改。",
            "started_at": started,
            "at": _now(),
            "idempotency_key": key,
            "replayed": False,
        }

    # Only settled outcomes are recorded; a needs_confirmation reply is not one.
    _record(key, record)
    return record


def history(limit: int = 50) -> list[dict[str, Any]]:
    runs = sorted(read_ledger()["runs"].values(), key=lambda r: r.get("at", ""))
    return runs[-limit:]
