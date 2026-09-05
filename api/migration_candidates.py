"""Stored migration candidates: build once, review, then apply deliberately.

The migration engine in ``migration.py`` is stateless — a caller hands it
artifacts and gets patches back. That is the right shape for the panel, which
already holds the canvas in memory, but it is the wrong shape for an Agent
action: an action runs on the server with nothing but its parameters, and its
result has to survive the round trip so a human can review the same candidate
the action produced.

So this module gives the engine a home. It reads the *stored review
revisions* as its artifacts, runs the real deterministic analysis over them,
and writes the result down under a candidate id.

Three properties are load-bearing:

**Build is not apply.** Building writes a candidate record and nothing else.
No listing content changes until a separate call arrives naming the patches a
human approved, and that call needs a confirmation token bound to the exact
candidate.

**Applying never overwrites an approved revision.** Patches go in through
``review.save_draft``, which forks anything already acted on. The approved copy
stays approved and stays live; what a migration produces is a draft awaiting
the normal review gate.

**A missing prerequisite is a blocker, not a placeholder.** No historical
snapshot to compare against, or no approved revision to migrate, produces a
named blocker and no candidate. Inventing an empty candidate so the UI has
something to show would be the exact fake progress this codebase refuses.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import migration
import policy
import review
from evidence import store

_LOCK = threading.RLock()
_SCHEMA = "listing-migration-candidates/v1"

MAX_OPERATOR_CHARS = 120
MAX_REASON_CHARS = 500

#: States a stored candidate moves through. `blocked` is terminal: the record
#: exists so the operator can read *why* nothing was built.
STATES = ("blocked", "built", "applied", "rolled_back")


class CandidateError(ValueError):
    def __init__(self, code: str, message: str, status: int = 400) -> None:
        self.code = code
        self.safe_message = message
        self.http_status = status
        super().__init__(message)


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _clean(value: Any, limit: int) -> str:
    return " ".join(str(value or "").split())[:limit]


# --------------------------------------------------------------------------- #
# Ledger                                                                       #
# --------------------------------------------------------------------------- #


def _ledger_path() -> Path:
    return store.store_dir() / "migration_candidates.json"


def _blank() -> dict[str, Any]:
    return {"schema": _SCHEMA, "seq": 0, "candidates": {}, "keys": {}}


def read_ledger() -> dict[str, Any]:
    path = _ledger_path()
    if not path.exists():
        return _blank()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return _blank()
    if not isinstance(data, dict) or not isinstance(data.get("candidates"), dict):
        return _blank()
    data.setdefault("keys", {})
    data.setdefault("seq", 0)
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


def _next_id(ledger: dict[str, Any]) -> str:
    ledger["seq"] = int(ledger.get("seq") or 0) + 1
    return f"mig-{ledger['seq']:04d}"


# --------------------------------------------------------------------------- #
# Confirmation tokens                                                          #
# --------------------------------------------------------------------------- #

#: Applying is a second, separate decision. The token binds that decision to
#: one candidate and one exact set of patches, so a confirmation collected for
#: a two-field migration cannot be replayed against a later, wider one.


def _secret() -> bytes:
    return store.store_dir().as_posix().encode("utf-8") + b"|migration-apply"


def confirmation_token(candidate_id: str, patch_ids: list[str]) -> str:
    payload = f"{candidate_id}|{'|'.join(sorted(patch_ids))}".encode("utf-8")
    return hmac.new(_secret(), payload, hashlib.sha256).hexdigest()[:32]


def _check_token(candidate_id: str, patch_ids: list[str], token: str) -> None:
    expected = confirmation_token(candidate_id, patch_ids)
    if not hmac.compare_digest(expected, _clean(token, 64)):
        raise CandidateError(
            "confirmation_mismatch",
            "确认令牌与要应用的补丁不匹配，请重新确认后再应用。",
            status=409,
        )


# --------------------------------------------------------------------------- #
# Artifacts from stored revisions                                              #
# --------------------------------------------------------------------------- #


def _artifact_from_revision(revision: dict[str, Any]) -> dict[str, Any]:
    """A review revision in the shape the migration engine reads.

    ``fact_refs`` are present but empty: these revisions carry no per-field SKU
    fact wiring, and an *absent* key would make the engine treat the artifact as
    legacy and flag it wholesale. An empty list says what is true — dependencies
    were computed and none matched — so only the policy path can fire here.
    """
    content = revision.get("content") or {}
    return {
        "artifact_id": revision["revision_id"],
        "platform": revision["platform"],
        "kind": "listing",
        "sku_id": revision.get("sku_id", ""),
        "title": str(content.get("title") or ""),
        "title_fact_refs": [],
        "asset_refs": [],
        "fields": [
            {
                "name": str(f.get("label") or f"field-{i + 1}"),
                "value": str(f.get("value") or ""),
                "fact_refs": [],
            }
            for i, f in enumerate(content.get("fields") or [])
        ],
    }


def _active_revisions(platform: str) -> list[dict[str, Any]]:
    """Every approved revision on this platform — one per SKU."""
    return [
        r
        for r in review.list_revisions(platform=platform)
        if r.get("state") in review.ACTIVE
    ]


# --------------------------------------------------------------------------- #
# Build                                                                        #
# --------------------------------------------------------------------------- #


def _blockers_for(platform: str) -> list[dict[str, str]]:
    """Prerequisites that must hold before a candidate can exist at all."""
    blockers: list[dict[str, str]] = []
    if platform not in review.PLATFORMS:
        blockers.append({"code": "unknown_platform", "detail": f"未知平台：{platform}"})
        return blockers

    try:
        policy.current_snapshot(platform)
    except policy.PolicyError:
        blockers.append(
            {"code": "no_current_policy", "detail": f"{platform} 没有当前政策快照，无法比较。"}
        )
    if policy.historical_snapshot(platform) is None:
        blockers.append(
            {
                "code": "no_baseline_policy",
                "detail": (
                    f"{platform} 只有一个政策快照，没有可对比的历史版本，"
                    "因此不存在需要迁移的规则变更。"
                ),
            }
        )
    if not _active_revisions(platform):
        blockers.append(
            {
                "code": "no_approved_revision",
                "detail": (
                    f"{platform} 没有已批准的修订。迁移候选只针对已批准内容构建，"
                    "请先在审核界面批准一版。"
                ),
            }
        )
    return blockers


def build(
    platform: str,
    *,
    fields: "list[str] | None" = None,
    source_action: str = "",
    idempotency_key: str = "",
    operator: str = "",
) -> dict[str, Any]:
    """Run the real migration analysis and store the result under an id.

    Returns the stored record either way: a `blocked` record names what is
    missing, a `built` record carries the patches.
    """
    platform = _clean(platform, 40).lower()
    wanted_fields = [_clean(f, 60) for f in (fields or []) if _clean(f, 60)]
    key = _clean(idempotency_key, 160)

    if key:
        ledger = read_ledger()
        prior = (ledger.get("keys") or {}).get(key)
        if prior and prior in ledger["candidates"]:
            return {**ledger["candidates"][prior], "replayed": True}

    blockers = _blockers_for(platform)
    if blockers:
        return _store(
            {
                "platform": platform,
                "state": "blocked",
                "requested_fields": wanted_fields,
                "policy_diff": None,
                "base_policy_version": "",
                "candidate_policy_version": "",
                "affected": [],
                "unaffected": [],
                "patches": [],
                "blockers": blockers,
                "warnings": [],
                "evidence_refs": [],
                "applied": [],
                "source_action": _clean(source_action, 80),
                "idempotency_key": key,
                "operator": _clean(operator, MAX_OPERATOR_CHARS),
            },
            key,
        )

    base = policy.historical_snapshot(platform)
    current = policy.current_snapshot(platform)
    assert base is not None  # guaranteed by _blockers_for

    revisions = _active_revisions(platform)
    artifacts = [_artifact_from_revision(r) for r in revisions]

    impact = migration.analyze_impact(
        artifacts,
        facts_before={},
        facts_after={},
        base_policy_version=base.version,
        candidate_policy_version=current.version,
    )

    available = migration.impacted_targets(impact)
    warnings: list[str] = []
    targets = None
    if wanted_fields:
        targets = sorted(t for t in available if t[1] in wanted_fields)
        missing = sorted(set(wanted_fields) - {t[1] for t in available})
        if missing:
            warnings.append(
                "以下字段不在本次规则变更的影响范围内，已跳过：" + "、".join(missing)
            )
        if not targets:
            warnings.append("所请求的字段都不受影响，因此没有生成任何补丁。")

    # Deterministic only: no model is called here. A migration that needs a
    # rewrite the rules cannot derive is reported as needing a human, not
    # quietly handed to a model behind an action the operator confirmed for
    # something else.
    candidate = migration.build_candidate_patches(
        artifacts,
        impact,
        facts_before={},
        facts_after={},
        base_policy_version=base.version,
        candidate_policy_version=current.version,
        targets=targets,
    )

    patches = candidate.get("patches") or []
    by_revision = {r["revision_id"]: r for r in revisions}
    for patch in patches:
        # The engine keys a patch by (artifact, field); the store needs a single
        # opaque id an operator can approve one at a time.
        patch["patch_id"] = f"{patch.get('artifact_id')}:{patch.get('field')}"
        source = by_revision.get(patch.get("artifact_id", ""))
        if source:
            patch["sku_id"] = source.get("sku_id", "")
            patch["revision_state"] = source.get("state", "")

    diff = policy.diff_snapshots(base, current).to_dict()

    return _store(
        {
            "platform": platform,
            "state": "built",
            "requested_fields": wanted_fields,
            "policy_diff": diff,
            "base_policy_version": base.version,
            "candidate_policy_version": current.version,
            "affected": impact.get("affected", []),
            "unaffected": impact.get("unaffected", []),
            "patches": patches,
            "blockers": [],
            "warnings": warnings + list(candidate.get("warnings") or []),
            "human_review": candidate.get("human_review", []),
            # What a reader can pull up to check the claim: the two snapshots
            # and the exact revisions the patches were computed from.
            "evidence_refs": [
                {"kind": "policy_snapshot", "id": base.version},
                {"kind": "policy_snapshot", "id": current.version},
                *[{"kind": "revision", "id": r["revision_id"]} for r in revisions],
            ],
            "applied": [],
            "source_action": _clean(source_action, 80),
            "idempotency_key": key,
            "operator": _clean(operator, MAX_OPERATOR_CHARS),
        },
        key,
    )


def _store(record: dict[str, Any], key: str) -> dict[str, Any]:
    with _LOCK:
        ledger = read_ledger()
        candidate_id = _next_id(ledger)
        record = {
            "candidate_id": candidate_id,
            "created_at": _now(),
            "updated_at": _now(),
            **record,
        }
        ledger["candidates"][candidate_id] = record
        if key:
            ledger["keys"][key] = candidate_id
        _write_ledger(ledger)
    return {**record, "replayed": False}


# --------------------------------------------------------------------------- #
# Read                                                                         #
# --------------------------------------------------------------------------- #


def get(candidate_id: str) -> dict[str, Any]:
    record = read_ledger()["candidates"].get(_clean(candidate_id, 40))
    if record is None:
        raise CandidateError("unknown_candidate", "找不到该迁移候选。", status=404)
    return record


def listing() -> list[dict[str, Any]]:
    rows = read_ledger()["candidates"].values()
    return sorted(rows, key=lambda r: r["candidate_id"])


# --------------------------------------------------------------------------- #
# Apply                                                                        #
# --------------------------------------------------------------------------- #


def apply(
    candidate_id: str,
    *,
    patch_ids: list[str],
    operator: str,
    reason: str,
    confirm_token: str,
) -> dict[str, Any]:
    """Write the approved patches in as *draft* revisions.

    Every patch forks through ``review.save_draft``: the approved revision it
    came from stays approved and stays the live answer. What lands is a draft
    that still has to clear validation and a human approval, exactly like copy
    someone typed.
    """
    operator = _clean(operator, MAX_OPERATOR_CHARS)
    reason = _clean(reason, MAX_REASON_CHARS)
    if not operator:
        raise CandidateError("missing_operator", "请填写操作人。")
    if not reason:
        raise CandidateError("missing_reason", "请说明应用原因。")

    record = get(candidate_id)
    if record["state"] == "blocked":
        raise CandidateError(
            "candidate_blocked", "该候选因前置条件缺失未生成补丁，无法应用。", status=409
        )
    if record["state"] == "applied":
        raise CandidateError("already_applied", "该候选已应用过。", status=409)

    wanted = [_clean(p, 80) for p in patch_ids if _clean(p, 80)]
    if not wanted:
        raise CandidateError("no_patches", "请至少选择一项要应用的补丁。")

    by_id = {str(p.get("patch_id")): p for p in record.get("patches") or []}
    unknown = sorted(set(wanted) - set(by_id))
    if unknown:
        raise CandidateError(
            "unknown_patch", f"候选中不存在这些补丁：{'、'.join(unknown)}", status=404
        )
    _check_token(candidate_id, wanted, confirm_token)

    # Group by source revision: one revision may carry several field patches,
    # and they must land as one fork rather than a chain of near-identical ones.
    grouped: dict[str, list[dict[str, Any]]] = {}
    for patch_id in wanted:
        patch = by_id[patch_id]
        grouped.setdefault(str(patch.get("artifact_id")), []).append(patch)

    applied: list[dict[str, Any]] = []
    for revision_id, patches in sorted(grouped.items()):
        try:
            source = review.get_revision(revision_id)
        except review.ReviewError as exc:
            raise CandidateError(exc.code, exc.safe_message, status=exc.http_status) from exc

        content = json.loads(json.dumps(source["content"]))
        changed: list[str] = []
        for patch in patches:
            field = str(patch.get("field"))
            value = str(patch.get("candidate_value") or "")
            if field == "title":
                content["title"] = value
                changed.append(field)
                continue
            for entry in content.get("fields") or []:
                if str(entry.get("label")) == field:
                    entry["value"] = value
                    changed.append(field)
                    break

        try:
            draft = review.save_draft(revision_id, content, operator=operator)
        except review.ReviewError as exc:
            raise CandidateError(exc.code, exc.safe_message, status=exc.http_status) from exc

        applied.append(
            {
                "source_revision_id": revision_id,
                "candidate_revision_id": draft["revision_id"],
                "forked": draft["revision_id"] != revision_id,
                "fields": changed,
                "patch_ids": [str(p.get("patch_id")) for p in patches],
                "state": draft["state"],
            }
        )

    with _LOCK:
        ledger = read_ledger()
        stored = ledger["candidates"][record["candidate_id"]]
        stored["state"] = "applied"
        stored["applied"] = applied
        stored["applied_at"] = _now()
        stored["applied_by"] = operator
        stored["apply_reason"] = reason
        stored["updated_at"] = _now()
        _write_ledger(ledger)
    return stored


# --------------------------------------------------------------------------- #
# Rollback                                                                     #
# --------------------------------------------------------------------------- #


def rollback(candidate_id: str, *, operator: str, reason: str) -> dict[str, Any]:
    """Withdraw the draft revisions an apply created.

    Nothing approved was changed by the apply, so there is no approved content
    to restore — undoing a migration means retiring the drafts it produced.
    Each one is marked ``rolled_back`` and stays readable; the history is not
    rewritten.
    """
    operator = _clean(operator, MAX_OPERATOR_CHARS)
    reason = _clean(reason, MAX_REASON_CHARS)
    if not operator:
        raise CandidateError("missing_operator", "请填写操作人。")
    if not reason:
        raise CandidateError("missing_reason", "请说明回滚原因。")

    record = get(candidate_id)
    if record["state"] != "applied":
        raise CandidateError("not_applied", "该候选尚未应用，没有可回滚的内容。", status=409)

    withdrawn: list[str] = []
    for entry in record.get("applied") or []:
        revision_id = entry["candidate_revision_id"]
        if not entry.get("forked"):
            # The patch edited a draft in place; withdrawing it would retire a
            # revision the migration did not create.
            continue
        try:
            review.withdraw_draft(revision_id, operator=operator, reason=reason)
        except review.ReviewError as exc:
            raise CandidateError(exc.code, exc.safe_message, status=exc.http_status) from exc
        withdrawn.append(revision_id)

    with _LOCK:
        ledger = read_ledger()
        stored = ledger["candidates"][record["candidate_id"]]
        stored["state"] = "rolled_back"
        stored["rolled_back_at"] = _now()
        stored["rolled_back_by"] = operator
        stored["rollback_reason"] = reason
        stored["withdrawn_revision_ids"] = withdrawn
        stored["updated_at"] = _now()
        _write_ledger(ledger)
    return stored
