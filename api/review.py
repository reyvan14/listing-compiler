"""Editable listing revisions, deterministic validation, and human approval.

A generated listing is a *proposal*, not an answer. This module turns it into a
reviewable object with a lifecycle:

    draft -> in_review -> needs_changes -> validated -> approved
                                              |
                                              +-> superseded | rolled_back

Three rules shape every function here.

**Nothing is silently overwritten.** A ``draft`` is the operator's working copy
and may be edited in place. Anything that has left ``draft`` -- something a
reviewer has already acted on -- forks into a new child revision instead. An
approved revision is never mutated, only superseded or rolled back.

**Certainty never appears from nowhere.** Editing content clears the validation
result that was computed against the old content, so a stale green check cannot
survive an edit. Approval re-runs the deterministic checker rather than trusting
the stored verdict, and refuses outright while a blocker stands.

**History is append-only.** Rollback restores content by *creating* a revision,
never by deleting the ones that came after it. Every transition lands in an
audit log with an operator, a reason and a timestamp; nothing in this module
invents review activity that a human did not perform.

On ``in_review``: validation is synchronous today, so a revision normally passes
through this state inside one request and it is visible in the audit trail
rather than as a resting state. A revision *rests* in ``in_review`` only when the
validator could not produce a result (see ``submit_for_validation``), which is
the honest place for "submitted, no verdict yet".

Persistence mirrors ``evidence.store``: one atomically-replaced JSON ledger under
the request-scoped evidence directory. No database, no credentials, no model.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import policy
from checker import apply_checks
from evidence import store

# --------------------------------------------------------------------------- #
# Lifecycle                                                                    #
# --------------------------------------------------------------------------- #

DRAFT = "draft"
IN_REVIEW = "in_review"
NEEDS_CHANGES = "needs_changes"
VALIDATED = "validated"
APPROVED = "approved"
SUPERSEDED = "superseded"
ROLLED_BACK = "rolled_back"

STATES = (DRAFT, IN_REVIEW, NEEDS_CHANGES, VALIDATED, APPROVED, SUPERSEDED, ROLLED_BACK)

#: States whose revision is the operator's mutable working copy. Everything else
#: forks on edit, because a reviewer may already have acted on it.
EDITABLE_IN_PLACE = (DRAFT, NEEDS_CHANGES)

#: States that mean "this revision is the live answer for its sku+platform".
ACTIVE = (APPROVED,)

PLATFORMS = ("amazon", "tiktok", "shopify")

#: Ceilings. A revision is operator-typed text, not a document upload.
MAX_TITLE_CHARS = 500
MAX_FIELD_CHARS = 5000
MAX_FIELDS = 40
MAX_REASON_CHARS = 1000
MAX_OPERATOR_CHARS = 120


class ReviewError(ValueError):
    """Rejected review operation. ``safe_message`` is safe to show a user."""

    def __init__(self, code: str, message: str, status: int = 400) -> None:
        self.code = code
        self.safe_message = message
        self.http_status = status
        super().__init__(message)


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


# --------------------------------------------------------------------------- #
# Ledger                                                                       #
# --------------------------------------------------------------------------- #

_LOCK = threading.RLock()

_SCHEMA = "listing-review/v1"


def _ledger_path() -> Path:
    return store.store_dir() / "reviews.json"


def _blank_ledger() -> dict[str, Any]:
    return {
        "schema": _SCHEMA,
        "seq": 0,
        "revisions": {},
        "approvals": {},
        "acknowledgements": {},
        "validations": {},
        "audit": [],
    }


def read_ledger() -> dict[str, Any]:
    path = _ledger_path()
    if not path.exists():
        return _blank_ledger()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return _blank_ledger()
    if not isinstance(data, dict) or not isinstance(data.get("revisions"), dict):
        return _blank_ledger()
    blank = _blank_ledger()
    for key, default in blank.items():
        data.setdefault(key, default)
    return data


def _write_ledger(ledger: dict[str, Any]) -> None:
    path = _ledger_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(ledger, fh, ensure_ascii=False, indent=2, sort_keys=True)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def _next_id(ledger: dict[str, Any], prefix: str) -> str:
    ledger["seq"] = int(ledger.get("seq") or 0) + 1
    return f"{prefix}-{ledger['seq']:04d}"


def _audit(
    ledger: dict[str, Any],
    event: str,
    *,
    revision_id: str = "",
    operator: str = "",
    reason: str = "",
    detail: "dict[str, Any] | None" = None,
) -> dict[str, Any]:
    entry = {
        "event_id": _next_id(ledger, "evt"),
        "event": event,
        "revision_id": revision_id,
        "operator": operator,
        "reason": reason,
        "detail": detail or {},
        "at": _now(),
    }
    ledger["audit"].append(entry)
    return entry


# --------------------------------------------------------------------------- #
# Content                                                                      #
# --------------------------------------------------------------------------- #


def _clean_text(value: Any, limit: int) -> str:
    text = str(value or "").replace("\r\n", "\n").strip()
    return text[:limit]


def normalise_content(raw: Any) -> dict[str, Any]:
    """Coerce operator-supplied listing content into the stored shape.

    The shape is deliberately the one the rest of the backend already speaks --
    ``{title, fields: [{label, value}]}``, exactly what ``checker.apply_checks``
    grades and what a canvas result card carries -- so a hand-edited listing is
    validated by precisely the rules that gate a generated one.
    """
    if not isinstance(raw, dict):
        raise ReviewError("bad_content", "修订内容格式不正确。")

    fields: list[dict[str, str]] = []
    for item in (raw.get("fields") or [])[:MAX_FIELDS]:
        if not isinstance(item, dict):
            continue
        label = _clean_text(item.get("label"), 120)
        if not label:
            continue
        fields.append({"label": label, "value": _clean_text(item.get("value"), MAX_FIELD_CHARS)})

    return {
        "title": _clean_text(raw.get("title"), MAX_TITLE_CHARS),
        "fields": fields,
    }


def content_hash(content: dict[str, Any]) -> str:
    """Stable hash of listing content. Identical copy ⇒ identical hash."""
    canonical = json.dumps(content, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def field_hashes(content: dict[str, Any]) -> dict[str, str]:
    """Per-field hashes, for a passport that must pin exact copy."""
    out = {"title": hashlib.sha256(content["title"].encode("utf-8")).hexdigest()}
    for field in content["fields"]:
        out[field["label"]] = hashlib.sha256(field["value"].encode("utf-8")).hexdigest()
    return out


#: Generator metadata keys we are willing to persist. Anything resembling a
#: credential is dropped at the boundary rather than filtered on the way out.
_GENERATOR_KEYS = ("provider", "model", "mode", "source", "task_id", "request_id")


def clean_generator(raw: Any) -> dict[str, str]:
    """Model/provider metadata with no credential-shaped field able to survive."""
    if not isinstance(raw, dict):
        return {}
    return {
        key: _clean_text(raw.get(key), 200)
        for key in _GENERATOR_KEYS
        if str(raw.get(key) or "").strip()
    }


# --------------------------------------------------------------------------- #
# Validation                                                                   #
# --------------------------------------------------------------------------- #


def _policy_snapshot_ids(platform: str) -> list[str]:
    try:
        return [policy.current_snapshot(platform).version]
    except Exception:  # pragma: no cover - defensive
        return []


def run_validation(revision: dict[str, Any]) -> dict[str, Any]:
    """Grade a revision with the existing deterministic checker.

    No model, no network. The returned record is stored verbatim and referenced
    by any approval taken on its strength, so an approval can always be traced
    back to the exact verdict that permitted it.
    """
    platform = revision["platform"]
    draft = {
        "id": platform,
        "title": revision["content"]["title"],
        "fields": list(revision["content"]["fields"]),
    }
    graded = apply_checks(
        draft,
        product_name=revision.get("product_name", ""),
        points=revision.get("points", ""),
        asset_mode=revision.get("asset_mode", "compliant"),
    )
    checks = graded.get("checks") or []
    blockers = [c["id"] for c in checks if c.get("blocking")]
    warnings = [c["id"] for c in checks if not c.get("blocking") and c.get("state") != "pass"]
    return {
        "validation_id": "",  # assigned by the caller, which owns the ledger
        "revision_id": revision["revision_id"],
        "platform": platform,
        "content_hash": revision["content_hash"],
        "checks": checks,
        "blockers": blockers,
        "warnings": warnings,
        "policy_snapshot_ids": _policy_snapshot_ids(platform),
        "suggested_title": graded.get("suggestedTitle", ""),
        "ran_at": _now(),
    }


def _store_validation(ledger: dict[str, Any], record: dict[str, Any]) -> dict[str, Any]:
    record = dict(record)
    record["validation_id"] = _next_id(ledger, "val")
    ledger["validations"][record["validation_id"]] = record
    return record


# --------------------------------------------------------------------------- #
# Revisions                                                                    #
# --------------------------------------------------------------------------- #


def _revision_key(revision: dict[str, Any]) -> tuple:
    return (revision.get("sku_id", ""), revision.get("platform", ""))


def _siblings(ledger: dict[str, Any], sku_id: str, platform: str) -> list[dict[str, Any]]:
    return sorted(
        (
            r
            for r in ledger["revisions"].values()
            if r.get("sku_id") == sku_id and r.get("platform") == platform
        ),
        key=lambda r: r.get("seq", 0),
    )


def _require(ledger: dict[str, Any], revision_id: str) -> dict[str, Any]:
    revision = ledger["revisions"].get(revision_id)
    if revision is None:
        raise ReviewError("unknown_revision", "找不到该修订版本。", status=404)
    return revision


def create_revision(
    *,
    sku_id: str,
    platform: str,
    content: Any,
    project_id: str = "",
    market: str = "US",
    locale: str = "en-US",
    source: str = "generated",
    generator: Any = None,
    product_name: str = "",
    points: str = "",
    asset_mode: str = "compliant",
    parent_revision_id: str = "",
) -> dict[str, Any]:
    """Register a generated listing as the first reviewable revision.

    Idempotent on identical generated content: re-opening the reviewer, or
    reloading the page, must not manufacture revision history. A second call
    carrying byte-identical content for the same sku+platform returns the
    existing revision rather than forking one.
    """
    if platform not in PLATFORMS:
        raise ReviewError("bad_platform", f"未知平台：{platform}")
    sku_id = _clean_text(sku_id, 120)
    if not sku_id:
        raise ReviewError("missing_sku", "缺少 SKU 标识。")

    normalised = normalise_content(content)
    digest = content_hash(normalised)

    with _LOCK:
        ledger = read_ledger()
        existing = _siblings(ledger, sku_id, platform)
        for revision in existing:
            if revision.get("content_hash") == digest and revision.get("source") == source:
                return dict(revision)

        revision_id = _next_id(ledger, "rev")
        revision = {
            "revision_id": revision_id,
            "seq": ledger["seq"],
            "project_id": _clean_text(project_id, 120),
            "sku_id": sku_id,
            "platform": platform,
            "market": _clean_text(market, 40) or "US",
            "locale": _clean_text(locale, 40) or "en-US",
            "parent_revision_id": _clean_text(parent_revision_id, 40),
            "restores_revision_id": "",
            "created_at": _now(),
            "updated_at": _now(),
            "source": _clean_text(source, 40) or "generated",
            "generator": clean_generator(generator),
            "product_name": _clean_text(product_name, 300),
            "points": _clean_text(points, MAX_FIELD_CHARS),
            "asset_mode": "promo" if asset_mode == "promo" else "compliant",
            "content": normalised,
            "content_hash": digest,
            "field_hashes": field_hashes(normalised),
            "state": DRAFT,
            "validation_id": "",
            "approval_id": "",
        }
        ledger["revisions"][revision_id] = revision
        _audit(ledger, "revision_created", revision_id=revision_id, detail={"source": source})
        _write_ledger(ledger)
        return dict(revision)


def save_draft(
    revision_id: str,
    content: Any,
    *,
    operator: str = "",
) -> dict[str, Any]:
    """Persist edited content.

    A working ``draft`` is updated in place. Anything a reviewer has already
    acted on -- submitted, validated, approved, superseded -- forks into a new
    child revision, so no recorded decision is ever quietly attached to copy it
    was not taken against.
    """
    normalised = normalise_content(content)
    digest = content_hash(normalised)
    operator = _clean_text(operator, MAX_OPERATOR_CHARS)

    with _LOCK:
        ledger = read_ledger()
        revision = _require(ledger, revision_id)

        if revision["content_hash"] == digest and revision["state"] in EDITABLE_IN_PLACE:
            return dict(revision)

        if revision["state"] in EDITABLE_IN_PLACE:
            revision["content"] = normalised
            revision["content_hash"] = digest
            revision["field_hashes"] = field_hashes(normalised)
            revision["updated_at"] = _now()
            # An edit invalidates the verdict computed against the old copy.
            revision["validation_id"] = ""
            revision["state"] = DRAFT
            _audit(ledger, "revision_edited", revision_id=revision_id, operator=operator)
            _write_ledger(ledger)
            return dict(revision)

        child_id = _next_id(ledger, "rev")
        child = dict(revision)
        child.update(
            {
                "revision_id": child_id,
                "seq": ledger["seq"],
                "parent_revision_id": revision_id,
                "restores_revision_id": "",
                "created_at": _now(),
                "updated_at": _now(),
                "source": "edited",
                "content": normalised,
                "content_hash": digest,
                "field_hashes": field_hashes(normalised),
                "state": DRAFT,
                "validation_id": "",
                "approval_id": "",
            }
        )
        ledger["revisions"][child_id] = child
        _audit(
            ledger,
            "revision_forked",
            revision_id=child_id,
            operator=operator,
            detail={"parent_revision_id": revision_id, "parent_state": revision["state"]},
        )
        _write_ledger(ledger)
        return dict(child)


def submit_for_validation(revision_id: str, *, operator: str = "") -> dict[str, Any]:
    """Run the deterministic checker and record the verdict on the revision.

    Blockers send the revision back to ``needs_changes``; a clean run makes it
    ``validated`` and eligible for human approval. If the checker cannot produce
    a verdict at all the revision rests in ``in_review`` -- submitted, no result
    -- rather than being credited with a pass it did not earn.
    """
    operator = _clean_text(operator, MAX_OPERATOR_CHARS)
    with _LOCK:
        ledger = read_ledger()
        revision = _require(ledger, revision_id)
        if revision["state"] in (APPROVED, SUPERSEDED, ROLLED_BACK):
            raise ReviewError(
                "not_editable",
                "该修订已完成审批，请先创建新的候选修订再提交校验。",
            )

        revision["state"] = IN_REVIEW
        _audit(ledger, "validation_submitted", revision_id=revision_id, operator=operator)

        try:
            record = _store_validation(ledger, run_validation(revision))
        except Exception:
            # Rest in in_review: submitted, no verdict. Never a silent pass.
            _write_ledger(ledger)
            raise ReviewError(
                "validation_unavailable",
                "校验暂时不可用，修订保持「待校验」状态。",
                status=503,
            )

        revision["validation_id"] = record["validation_id"]
        revision["state"] = NEEDS_CHANGES if record["blockers"] else VALIDATED
        revision["updated_at"] = _now()
        _audit(
            ledger,
            "validation_completed",
            revision_id=revision_id,
            operator=operator,
            detail={
                "validation_id": record["validation_id"],
                "blockers": record["blockers"],
                "warnings": record["warnings"],
            },
        )
        _write_ledger(ledger)
        return dict(revision)


def acknowledge_warnings(
    revision_id: str,
    warning_ids: list[str],
    *,
    operator: str,
    reason: str,
) -> dict[str, Any]:
    """Record a named human taking responsibility for specific warnings.

    Only warnings the stored validation actually raised may be acknowledged --
    acknowledging a warning that was never reported would put a signature under
    nothing. Blockers are not acknowledgeable at all; they are fixed.
    """
    operator = _clean_text(operator, MAX_OPERATOR_CHARS)
    reason = _clean_text(reason, MAX_REASON_CHARS)
    if not operator:
        raise ReviewError("missing_operator", "请填写复核人。")
    if not reason:
        raise ReviewError("missing_reason", "请填写豁免理由。")

    with _LOCK:
        ledger = read_ledger()
        revision = _require(ledger, revision_id)
        record = ledger["validations"].get(revision.get("validation_id") or "")
        if record is None:
            raise ReviewError("not_validated", "该修订还没有校验结果，无法确认警告。")

        wanted = [w for w in dict.fromkeys(warning_ids or []) if isinstance(w, str)]
        unknown = [w for w in wanted if w not in record["warnings"]]
        if unknown:
            raise ReviewError(
                "unknown_warning",
                f"以下警告不在本次校验结果中：{'、'.join(unknown)}",
            )
        if not wanted:
            raise ReviewError("no_warnings", "请选择需要确认的警告。")

        ack_id = _next_id(ledger, "ack")
        ack = {
            "ack_id": ack_id,
            "revision_id": revision_id,
            "validation_id": record["validation_id"],
            "warning_ids": wanted,
            "operator": operator,
            "reason": reason,
            "at": _now(),
        }
        ledger["acknowledgements"][ack_id] = ack
        _audit(
            ledger,
            "warnings_acknowledged",
            revision_id=revision_id,
            operator=operator,
            reason=reason,
            detail={"warning_ids": wanted},
        )
        _write_ledger(ledger)
        return dict(ack)


def _supersede_active(
    ledger: dict[str, Any],
    sku_id: str,
    platform: str,
    *,
    keep: str,
    new_state: str,
    operator: str,
    reason: str,
) -> list[str]:
    """Deactivate every other approved revision for this sku+platform.

    Older approvals are re-stated, never deleted: the record of who approved
    what, and when, has to survive being replaced.
    """
    touched: list[str] = []
    for revision in _siblings(ledger, sku_id, platform):
        if revision["revision_id"] == keep or revision["state"] != APPROVED:
            continue
        revision["state"] = new_state
        revision["updated_at"] = _now()
        touched.append(revision["revision_id"])
        _audit(
            ledger,
            new_state,
            revision_id=revision["revision_id"],
            operator=operator,
            reason=reason,
            detail={"replaced_by": keep},
        )
    return touched


def approve(revision_id: str, *, operator: str, reason: str = "") -> dict[str, Any]:
    """Approve a revision, but only if the checker still says it may ship.

    The stored verdict is not trusted: validation re-runs against the current
    content and current policy snapshots here, because an approval that quotes a
    verdict computed for different copy is worthless as a record.
    """
    operator = _clean_text(operator, MAX_OPERATOR_CHARS)
    reason = _clean_text(reason, MAX_REASON_CHARS)
    if not operator:
        raise ReviewError("missing_operator", "请填写审批人。")

    with _LOCK:
        ledger = read_ledger()
        revision = _require(ledger, revision_id)
        if revision["state"] == APPROVED:
            raise ReviewError("already_approved", "该修订已批准，无需重复审批。")
        if revision["state"] in (SUPERSEDED, ROLLED_BACK):
            raise ReviewError("inactive_revision", "该修订已被取代或回滚，无法再次批准。")

        record = _store_validation(ledger, run_validation(revision))
        revision["validation_id"] = record["validation_id"]

        if record["blockers"]:
            revision["state"] = NEEDS_CHANGES
            revision["updated_at"] = _now()
            _audit(
                ledger,
                "approval_blocked",
                revision_id=revision_id,
                operator=operator,
                detail={"blockers": record["blockers"]},
            )
            _write_ledger(ledger)
            raise ReviewError(
                "blocked_by_validation",
                f"仍有 {len(record['blockers'])} 项阻断校验未通过，无法批准。",
                status=409,
            )

        approval_id = _next_id(ledger, "apr")
        approval = {
            "approval_id": approval_id,
            "revision_id": revision_id,
            "sku_id": revision["sku_id"],
            "platform": revision["platform"],
            "operator": operator,
            "decision": "approved",
            "reason": reason,
            "content_hash": revision["content_hash"],
            "validation_result_ids": [record["validation_id"]],
            "policy_snapshot_ids": list(record["policy_snapshot_ids"]),
            "at": _now(),
        }
        ledger["approvals"][approval_id] = approval

        superseded = _supersede_active(
            ledger,
            revision["sku_id"],
            revision["platform"],
            keep=revision_id,
            new_state=SUPERSEDED,
            operator=operator,
            reason=f"被 {revision_id} 取代",
        )

        revision["state"] = APPROVED
        revision["approval_id"] = approval_id
        revision["updated_at"] = _now()
        _audit(
            ledger,
            "revision_approved",
            revision_id=revision_id,
            operator=operator,
            reason=reason,
            detail={"approval_id": approval_id, "superseded": superseded},
        )
        _write_ledger(ledger)
        return {"revision": dict(revision), "approval": dict(approval), "superseded": superseded}


def request_changes(revision_id: str, *, operator: str, reason: str) -> dict[str, Any]:
    """Reviewer sends a revision back. A reason is mandatory."""
    operator = _clean_text(operator, MAX_OPERATOR_CHARS)
    reason = _clean_text(reason, MAX_REASON_CHARS)
    if not operator:
        raise ReviewError("missing_operator", "请填写复核人。")
    if not reason:
        raise ReviewError("missing_reason", "请说明需要修改的内容。")

    with _LOCK:
        ledger = read_ledger()
        revision = _require(ledger, revision_id)
        if revision["state"] in (APPROVED, SUPERSEDED, ROLLED_BACK):
            raise ReviewError("inactive_revision", "该修订已完成审批，无法退回修改。")

        approval_id = _next_id(ledger, "apr")
        approval = {
            "approval_id": approval_id,
            "revision_id": revision_id,
            "sku_id": revision["sku_id"],
            "platform": revision["platform"],
            "operator": operator,
            "decision": "changes_requested",
            "reason": reason,
            "content_hash": revision["content_hash"],
            "validation_result_ids": [revision["validation_id"]] if revision["validation_id"] else [],
            "policy_snapshot_ids": _policy_snapshot_ids(revision["platform"]),
            "at": _now(),
        }
        ledger["approvals"][approval_id] = approval
        revision["state"] = NEEDS_CHANGES
        revision["updated_at"] = _now()
        _audit(
            ledger,
            "changes_requested",
            revision_id=revision_id,
            operator=operator,
            reason=reason,
            detail={"approval_id": approval_id},
        )
        _write_ledger(ledger)
        return {"revision": dict(revision), "approval": dict(approval)}


def rollback_to(revision_id: str, *, operator: str, reason: str) -> dict[str, Any]:
    """Restore an earlier revision's exact content as a new approved revision.

    Rollback is an approval, so it obeys the same gate: the restored copy is
    re-validated against *current* policy, and if it no longer passes, the
    rollback is refused rather than quietly reinstating a listing that would
    now be blocked. Nothing later in the history is deleted -- the revision
    being rolled back away from is marked ``rolled_back`` and stays readable.
    """
    operator = _clean_text(operator, MAX_OPERATOR_CHARS)
    reason = _clean_text(reason, MAX_REASON_CHARS)
    if not operator:
        raise ReviewError("missing_operator", "请填写操作人。")
    if not reason:
        raise ReviewError("missing_reason", "请说明回滚原因。")

    with _LOCK:
        ledger = read_ledger()
        target = _require(ledger, revision_id)
        siblings = _siblings(ledger, target["sku_id"], target["platform"])
        head = siblings[-1] if siblings else target

        restored_id = _next_id(ledger, "rev")
        restored = dict(target)
        restored.update(
            {
                "revision_id": restored_id,
                "seq": ledger["seq"],
                # lineage points at what was in place; provenance names what it restores
                "parent_revision_id": head["revision_id"],
                "restores_revision_id": revision_id,
                "created_at": _now(),
                "updated_at": _now(),
                "source": "rollback",
                "state": DRAFT,
                "validation_id": "",
                "approval_id": "",
            }
        )

        record = _store_validation(ledger, run_validation(restored))
        restored["validation_id"] = record["validation_id"]

        if record["blockers"]:
            # Refuse rather than reinstate a listing today's rules would block.
            restored["state"] = NEEDS_CHANGES
            ledger["revisions"][restored_id] = restored
            _audit(
                ledger,
                "rollback_blocked",
                revision_id=restored_id,
                operator=operator,
                reason=reason,
                detail={"restores": revision_id, "blockers": record["blockers"]},
            )
            _write_ledger(ledger)
            raise ReviewError(
                "blocked_by_validation",
                f"回滚目标在当前规则下有 {len(record['blockers'])} 项阻断校验，未执行回滚。"
                f"已保留候选修订 {restored_id} 供修改。",
                status=409,
            )

        approval_id = _next_id(ledger, "apr")
        approval = {
            "approval_id": approval_id,
            "revision_id": restored_id,
            "sku_id": restored["sku_id"],
            "platform": restored["platform"],
            "operator": operator,
            "decision": "rollback",
            "reason": reason,
            "content_hash": restored["content_hash"],
            "validation_result_ids": [record["validation_id"]],
            "policy_snapshot_ids": list(record["policy_snapshot_ids"]),
            "at": _now(),
        }
        ledger["approvals"][approval_id] = approval

        ledger["revisions"][restored_id] = restored
        deactivated = _supersede_active(
            ledger,
            restored["sku_id"],
            restored["platform"],
            keep=restored_id,
            new_state=ROLLED_BACK,
            operator=operator,
            reason=reason,
        )

        restored["state"] = APPROVED
        restored["approval_id"] = approval_id
        _audit(
            ledger,
            "revision_rolled_back",
            revision_id=restored_id,
            operator=operator,
            reason=reason,
            detail={
                "restores": revision_id,
                "approval_id": approval_id,
                "rolled_back": deactivated,
            },
        )
        _write_ledger(ledger)
        return {
            "revision": dict(restored),
            "approval": dict(approval),
            "rolled_back": deactivated,
        }


# --------------------------------------------------------------------------- #
# Reads and diffs                                                              #
# --------------------------------------------------------------------------- #

UNCHANGED = "unchanged"
ADDED = "added"
REMOVED = "removed"
MODIFIED = "modified"


def diff_content(base: dict[str, Any], target: dict[str, Any]) -> list[dict[str, Any]]:
    """Field-level diff, matched by label. Title participates as a field."""
    rows: list[dict[str, Any]] = []

    def row(label: str, before: str, after: str, present_before: bool, present_after: bool):
        if not present_before:
            status = ADDED
        elif not present_after:
            status = REMOVED
        elif before == after:
            status = UNCHANGED
        else:
            status = MODIFIED
        rows.append({"label": label, "before": before, "after": after, "status": status})

    row("标题", base.get("title", ""), target.get("title", ""), True, True)

    base_fields = {f["label"]: f["value"] for f in base.get("fields", [])}
    target_fields = {f["label"]: f["value"] for f in target.get("fields", [])}
    order = list(base_fields) + [k for k in target_fields if k not in base_fields]
    for label in order:
        row(
            label,
            base_fields.get(label, ""),
            target_fields.get(label, ""),
            label in base_fields,
            label in target_fields,
        )
    return rows


def diff_revisions(base_id: str, target_id: str) -> dict[str, Any]:
    ledger = read_ledger()
    base = _require(ledger, base_id)
    target = _require(ledger, target_id)
    rows = diff_content(base["content"], target["content"])
    counts: dict[str, int] = {UNCHANGED: 0, ADDED: 0, REMOVED: 0, MODIFIED: 0}
    for r in rows:
        counts[r["status"]] += 1
    return {
        "base": _summary(base),
        "target": _summary(target),
        "rows": rows,
        "counts": counts,
        "identical": base["content_hash"] == target["content_hash"],
    }


def _summary(revision: dict[str, Any]) -> dict[str, Any]:
    return {
        "revision_id": revision["revision_id"],
        "state": revision["state"],
        "source": revision["source"],
        "platform": revision["platform"],
        "sku_id": revision["sku_id"],
        "created_at": revision["created_at"],
        "content_hash": revision["content_hash"],
        "parent_revision_id": revision.get("parent_revision_id", ""),
        "restores_revision_id": revision.get("restores_revision_id", ""),
    }


def get_revision(revision_id: str) -> dict[str, Any]:
    return dict(_require(read_ledger(), revision_id))


def list_revisions(*, sku_id: str = "", platform: str = "") -> list[dict[str, Any]]:
    ledger = read_ledger()
    rows = [
        r
        for r in ledger["revisions"].values()
        if (not sku_id or r.get("sku_id") == sku_id)
        and (not platform or r.get("platform") == platform)
    ]
    return sorted(rows, key=lambda r: r.get("seq", 0))


def active_revision(sku_id: str, platform: str) -> "dict[str, Any] | None":
    """The single approved revision for this sku+platform, if one exists."""
    for revision in reversed(_siblings(read_ledger(), sku_id, platform)):
        if revision["state"] == APPROVED:
            return dict(revision)
    return None


def revision_view(revision_id: str) -> dict[str, Any]:
    """Everything the reviewer UI needs for one revision, from stored records."""
    ledger = read_ledger()
    revision = _require(ledger, revision_id)
    validation = ledger["validations"].get(revision.get("validation_id") or "")
    approvals = sorted(
        (a for a in ledger["approvals"].values() if a["revision_id"] == revision_id),
        key=lambda a: a["at"],
    )
    acks = sorted(
        (a for a in ledger["acknowledgements"].values() if a["revision_id"] == revision_id),
        key=lambda a: a["at"],
    )
    history = _siblings(ledger, revision["sku_id"], revision["platform"])
    approved = next((r for r in reversed(history) if r["state"] == APPROVED), None)
    return {
        "revision": dict(revision),
        "validation": dict(validation) if validation else None,
        "approvals": [dict(a) for a in approvals],
        "acknowledgements": [dict(a) for a in acks],
        "history": [_summary(r) for r in history],
        "approved_revision_id": approved["revision_id"] if approved else "",
        "audit": [
            dict(e) for e in ledger["audit"] if e.get("revision_id") in {r["revision_id"] for r in history}
        ],
    }
