"""Self-healing Listing CI/CD — blast radius, shadow compilation, apply, rollback.

Everything here is deterministic unless a model JSON-patch is explicitly
requested *and* Token Plan is configured. Automated tests never trigger a real
provider call: ``request_model_patch`` returns ``None`` immediately when no key
is configured, and the deterministic fallback is always able to produce a patch.

Vocabulary (kept truthful — never "published"):
    current | stale | candidate | applied | rolled_back | needs_human_review
"""

from __future__ import annotations

import copy
import hashlib
import json
import re
from datetime import datetime, timezone
from typing import Any, Callable, Iterable

import policy
import skufacts

# --------------------------------------------------------------------------- #
# Artifact helpers                                                             #
# --------------------------------------------------------------------------- #

_STATUS_ORDER = (
    "current",
    "stale",
    "candidate",
    "applied",
    "rolled_back",
    "needs_human_review",
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _artifact_fields(artifact: dict[str, Any]) -> list[dict[str, Any]]:
    return [f for f in (artifact.get("fields") or []) if isinstance(f, dict)]


def _all_field_entries(artifact: dict[str, Any]) -> list[dict[str, Any]]:
    """title + body fields, as uniform ``{name, value, fact_refs}`` dicts."""
    entries: list[dict[str, Any]] = []
    if "title" in artifact:
        entries.append(
            {
                "name": "title",
                "value": str(artifact.get("title") or ""),
                "fact_refs": list(artifact.get("title_fact_refs") or []),
            }
        )
    for f in _artifact_fields(artifact):
        entries.append(
            {
                "name": str(f.get("name") or f.get("field") or f.get("label") or ""),
                "value": str(f.get("value") or ""),
                "fact_refs": list(f.get("fact_refs") or f.get("factRefs") or []),
            }
        )
    return entries


def _has_dependency_metadata(artifact: dict[str, Any]) -> bool:
    # A present-but-empty array still counts as "we computed dependencies and
    # nothing matched" — only a truly absent key is legacy / unknown.
    if isinstance(artifact.get("asset_refs"), list):
        return True
    if isinstance(artifact.get("title_fact_refs"), list):
        return True
    return any(
        isinstance(f.get("fact_refs"), list) or isinstance(f.get("factRefs"), list)
        for f in _artifact_fields(artifact)
    )


def _field_value(artifact: dict[str, Any], field_name: str) -> str | None:
    if field_name == "title":
        return str(artifact.get("title") or "")
    for f in _artifact_fields(artifact):
        if str(f.get("name") or f.get("field") or f.get("label")) == field_name:
            return str(f.get("value") or "")
    return None


def _set_field_value(artifact: dict[str, Any], field_name: str, value: str) -> bool:
    if field_name == "title":
        artifact["title"] = value
        return True
    for f in _artifact_fields(artifact):
        if str(f.get("name") or f.get("field") or f.get("label")) == field_name:
            f["value"] = value
            return True
    return False


# --------------------------------------------------------------------------- #
# D. Blast-radius analysis                                                     #
# --------------------------------------------------------------------------- #

_POLICY_FIELD_RE = re.compile(r"^([a-z]+):(.+)$")


def _policy_field_targets(pol_diff_dict: dict[str, Any]) -> dict[str, set[str]]:
    """``{"amazon": {"title"}}`` from the diff's affected_fields."""
    out: dict[str, set[str]] = {}
    for token in pol_diff_dict.get("affected_fields", []):
        m = _POLICY_FIELD_RE.match(str(token))
        if not m:
            continue
        platform, field = m.group(1), m.group(2)
        field = {"main_image": "image", "description": "long-description"}.get(field, field)
        out.setdefault(platform, set()).add(field)
    return out


def analyze_impact(
    artifacts: list[dict[str, Any]],
    *,
    facts_before: dict[str, str] | None = None,
    facts_after: dict[str, str] | None = None,
    base_policy_version: str | None = None,
    candidate_policy_version: str | None = None,
) -> dict[str, Any]:
    facts_before = facts_before or {}
    facts_after = facts_after or {}
    fact_delta = skufacts.diff_facts(facts_before, facts_after)
    changed_facts = set(fact_delta["changed"]) | set(fact_delta["removed"])

    pol_diff_dict: dict[str, Any] | None = None
    pol_platform = ""
    pol_targets: dict[str, set[str]] = {}
    candidate_snap = None
    if base_policy_version and candidate_policy_version:
        base_snap = policy.get_snapshot(base_policy_version)
        candidate_snap = policy.get_snapshot(candidate_policy_version)
        pol_diff = policy.diff_snapshots(base_snap, candidate_snap)
        pol_diff_dict = pol_diff.to_dict()
        pol_platform = pol_diff.platform
        pol_targets = _policy_field_targets(pol_diff_dict)

    affected: list[dict[str, Any]] = []
    unaffected: list[dict[str, Any]] = []
    by_cause = {"sku": 0, "policy": 0, "both": 0}

    for artifact in artifacts:
        aid = str(artifact.get("artifact_id") or artifact.get("id") or "")
        platform = str(artifact.get("platform") or "")
        kind = str(artifact.get("kind") or "listing")
        reasons: list[dict[str, Any]] = []
        regen_fields: set[str] = set()
        touched_fields: set[str] = set()
        has_meta = _has_dependency_metadata(artifact)

        # ---- SKU fact cause -------------------------------------------------
        if changed_facts:
            if kind in ("image", "video"):
                asset_hit = sorted(set(artifact.get("asset_refs") or []) & changed_facts)
                if asset_hit:
                    reasons.append(
                        {
                            "type": "sku_fact",
                            "fact_ids": asset_hit,
                            "fields": ["asset"],
                            "detail": f"素材依赖的 SKU 事实发生变化：{', '.join(asset_hit)}",
                        }
                    )
                    regen_fields.add("asset")
                    touched_fields.add("asset")
                elif not has_meta:
                    reasons.append(
                        {
                            "type": "sku_fact_conservative",
                            "fact_ids": sorted(changed_facts),
                            "fields": ["asset"],
                            "detail": "该素材缺少依赖元数据，保守起见按受影响处理。",
                        }
                    )
                    regen_fields.add("asset")
                    touched_fields.add("asset")
            else:
                per_field_hits: list[dict[str, Any]] = []
                for entry in _all_field_entries(artifact):
                    hit = sorted(set(entry["fact_refs"]) & changed_facts)
                    if hit:
                        per_field_hits.append({"field": entry["name"], "fact_ids": hit})
                        regen_fields.add(entry["name"])
                        touched_fields.add(entry["name"])
                if per_field_hits:
                    reasons.append(
                        {
                            "type": "sku_fact",
                            "fact_ids": sorted({f for h in per_field_hits for f in h["fact_ids"]}),
                            "fields": [h["field"] for h in per_field_hits],
                            "per_field": per_field_hits,
                            "detail": "以下字段引用了发生变化的 SKU 事实。",
                        }
                    )
                elif not has_meta:
                    all_names = [e["name"] for e in _all_field_entries(artifact)] or ["*"]
                    reasons.append(
                        {
                            "type": "sku_fact_conservative",
                            "fact_ids": sorted(changed_facts),
                            "fields": all_names,
                            "detail": "该产物缺少 factRefs 依赖元数据，保守起见按全字段受影响处理。",
                        }
                    )
                    regen_fields.update(all_names)
                    touched_fields.update(all_names)

        # ---- Policy cause -------------------------------------------------
        if pol_diff_dict and platform == pol_platform and kind == "listing":
            wanted = pol_targets.get(platform, set())
            if wanted:
                rule_ids = sorted(
                    {r["rule_id"] for r in pol_diff_dict["changed"]}
                    | {r["id"] for r in pol_diff_dict["added"]}
                    | {r["id"] for r in pol_diff_dict["removed"]}
                )
                pol_fields: list[str] = []
                requires_regen = False
                for field_name in sorted(wanted):
                    value = _field_value(artifact, field_name)
                    if value is None and field_name != "title":
                        continue
                    pol_fields.append(field_name)
                    touched_fields.add(field_name)
                    if field_name == "title" and candidate_snap is not None:
                        results = policy.evaluate_snapshot(candidate_snap, {"title": value or ""})
                        if policy.blocking_failures(results):
                            requires_regen = True
                            regen_fields.add(field_name)
                if pol_fields:
                    reasons.append(
                        {
                            "type": "policy",
                            "rule_ids": rule_ids,
                            "fields": pol_fields,
                            "policy_from": base_policy_version,
                            "policy_to": candidate_policy_version,
                            "requires_regen": requires_regen,
                            "detail": (
                                "候选政策收紧了该字段的强制校验，当前内容不满足，需要重编译。"
                                if requires_regen
                                else "候选政策变化涉及该字段；当前内容仍合规，只需重新校验并更新政策版本。"
                            ),
                        }
                    )

        has_sku = any(r["type"].startswith("sku_fact") for r in reasons)
        has_policy = any(r["type"] == "policy" for r in reasons)
        entry = {
            "artifact_id": aid,
            "platform": platform,
            "kind": kind,
            "affected": bool(reasons),
            "reasons": reasons,
            "fields_to_regenerate": sorted(regen_fields),
            "reusable_fields": sorted(
                {e["name"] for e in _all_field_entries(artifact)} - touched_fields
            ),
            "has_dependency_metadata": has_meta,
        }
        if reasons:
            cause = "both" if (has_sku and has_policy) else ("sku" if has_sku else "policy")
            entry["cause"] = cause
            by_cause[cause] += 1
            affected.append(entry)
        else:
            entry["cause"] = None
            entry["reason"] = "无依赖重叠：未引用变化的 SKU 事实，且不在本次政策变更范围内。"
            unaffected.append(entry)

    return {
        "generated_at": _now_iso(),
        "fact_delta": fact_delta,
        "policy_diff": pol_diff_dict,
        "affected": affected,
        "unaffected": unaffected,
        "summary": {
            "affected_count": len(affected),
            "unaffected_count": len(unaffected),
            "by_cause": by_cause,
        },
    }


def impacted_targets(impact: dict[str, Any]) -> set[tuple[str, str]]:
    """``{(artifact_id, field)}`` the impact analysis flagged for regeneration."""
    out: set[tuple[str, str]] = set()
    for row in impact.get("affected", []):
        aid = row["artifact_id"]
        for field_name in row.get("fields_to_regenerate", []):
            out.add((aid, field_name))
    return out


# --------------------------------------------------------------------------- #
# F. Shadow compilation (candidate patches; current artifact untouched)        #
# --------------------------------------------------------------------------- #

_NUM_ONLY_RE = re.compile(r"^-?\d+(?:\.\d+)?$")


def _numeric_token_swaps(old_value: str, new_value: str) -> list[tuple[str, str]]:
    """Pairs of pure numeric/measurement tokens that were replaced 1:1."""
    old_tokens = sorted(skufacts.salient_tokens(old_value))
    new_tokens = sorted(skufacts.salient_tokens(new_value))
    old_only = [t for t in old_tokens if t not in new_tokens]
    new_only = [t for t in new_tokens if t not in old_tokens]

    def unit_of(tok: str) -> str:
        m = re.match(r"-?\d+(?:\.\d+)?(.*)$", tok)
        return m.group(1) if m else ""

    swaps: list[tuple[str, str]] = []
    for o in old_only:
        for n in new_only:
            if unit_of(o) == unit_of(n) and unit_of(o) != "" or (
                _NUM_ONLY_RE.match(o) and _NUM_ONLY_RE.match(n)
            ):
                swaps.append((o, n))
                break
    return swaps


def _apply_token_swaps(text: str, swaps: Iterable[tuple[str, str]]) -> tuple[str, list[str]]:
    """Replace numeric tokens case-insensitively; report tokens actually changed."""
    changed: list[str] = []
    out = text
    for old_tok, new_tok in swaps:
        pattern = re.compile(re.escape(old_tok), re.IGNORECASE)
        if pattern.search(out):
            out = pattern.sub(new_tok, out)
            changed.append(f"{old_tok}→{new_tok}")
    return out, changed


def _residual_stale_tokens(text: str, changed_fact_old: str, changed_fact_new: str) -> list[str]:
    """Old-fact tokens still present after the swap that we did NOT safely fix
    (e.g. an imperial equivalent like 12oz alongside 350ml)."""
    old_tokens = skufacts.salient_tokens(changed_fact_old)
    new_tokens = skufacts.salient_tokens(changed_fact_new)
    lowered = text.lower()
    residual: list[str] = []
    for tok in sorted(old_tokens - new_tokens):
        if _NUM_ONLY_RE.match(tok):
            continue
        if re.match(r"-?\d+(?:\.\d+)?[a-z°]+", tok) and tok in lowered:
            residual.append(tok)
    return residual


def _trim_title_to(value: str, max_len: int) -> str:
    if len(value) <= max_len:
        return value
    cut = value[:max_len]
    # step back to a word / punctuation boundary
    m = re.search(r"[\s,;:\-–—/|]+\S*$", cut)
    if m and m.start() >= int(max_len * 0.5):
        cut = cut[: m.start()]
    return cut.rstrip(" ,;:-–—/|")


def _strip_prohibited_chars(value: str, chars: str) -> str:
    table = {ord(c): None for c in chars}
    return re.sub(r"\s{2,}", " ", value.translate(table)).strip()


def _limit_repeated_words(value: str, limit: int, exempt: set[str]) -> str:
    counts: dict[str, int] = {}
    out_tokens: list[str] = []
    for tok in re.findall(r"\S+|\s+", value):
        if tok.isspace():
            out_tokens.append(tok)
            continue
        key = re.sub(r"[^0-9a-z一-鿿]+", "", tok.lower())
        if key and key not in exempt:
            counts[key] = counts.get(key, 0) + 1
            if counts[key] > limit:
                continue
        out_tokens.append(tok)
    return re.sub(r"\s{2,}", " ", "".join(out_tokens)).strip(" ,;-–—")


async def request_model_patch(
    artifacts: list[dict[str, Any]],
    targets: Iterable[tuple[str, str]],
    *,
    facts_after: dict[str, str],
    candidate_policy_version: str | None = None,
) -> dict[str, dict[str, str]] | None:
    """Ask the model for a **JSON patch** (changed fields only, never a rewrite).

    Returns ``{artifact_id: {field: new_value}}`` restricted to *targets*, or
    ``None`` on any problem. Never called with a real provider from tests:
    returns ``None`` immediately when Token Plan is not configured.
    """
    try:
        import token_plan
    except Exception:  # pragma: no cover
        return None
    if not token_plan.is_configured():
        return None

    target_set = {(str(a), str(f)) for a, f in targets}
    if not target_set:
        return None
    by_id = {str(a.get("artifact_id") or a.get("id")): a for a in artifacts}
    ask: list[dict[str, Any]] = []
    for aid, field_name in sorted(target_set):
        art = by_id.get(aid)
        if not art:
            continue
        ask.append(
            {
                "artifact_id": aid,
                "platform": art.get("platform", ""),
                "field": field_name,
                "current_value": _field_value(art, field_name) or "",
            }
        )
    if not ask:
        return None

    prompt = (
        "You are patching cross-border listing fields. Update ONLY the listed "
        "fields to satisfy the new constraints. Do not rewrite unrelated copy. "
        "Keep every fact that is supported by these SKU facts; add no new facts.\n"
        f"SKU facts: {json.dumps(facts_after, ensure_ascii=False)}\n"
        f"Fields to patch: {json.dumps(ask, ensure_ascii=False)}\n"
        'Reply with ONLY JSON: {"patches":[{"artifact_id":"","field":"","value":""}]}'
    )
    try:
        raw = await token_plan.chat_completion(
            [{"role": "user", "content": prompt}],
            model=(
                token_plan.text_model()
                if hasattr(token_plan, "text_model")
                else None
            ),
        )
        text = raw.strip()
        fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
        if fence:
            text = fence.group(1).strip()
        data = json.loads(text)
    except Exception:
        return None

    out: dict[str, dict[str, str]] = {}
    for item in data.get("patches", []) if isinstance(data, dict) else []:
        if not isinstance(item, dict):
            continue
        aid = str(item.get("artifact_id") or "")
        field_name = str(item.get("field") or "")
        value = item.get("value")
        if (aid, field_name) in target_set and isinstance(value, str) and value.strip():
            out.setdefault(aid, {})[field_name] = value
    return out or None


VerifierFn = Callable[[str, dict[str, str]], dict[str, Any]]


def build_candidate_patches(
    artifacts: list[dict[str, Any]],
    impact: dict[str, Any],
    *,
    facts_before: dict[str, str],
    facts_after: dict[str, str],
    base_policy_version: str | None = None,
    candidate_policy_version: str | None = None,
    targets: Iterable[tuple[str, str]] | None = None,
    model_patch: dict[str, dict[str, str]] | None = None,
    verifier: VerifierFn | None = None,
) -> dict[str, Any]:
    by_id = {
        str(a.get("artifact_id") or a.get("id")): a for a in artifacts
    }
    allowed = impacted_targets(impact)
    wanted = set(targets) if targets is not None else set(allowed)
    unrelated = sorted(wanted - allowed)
    if unrelated:
        raise ValueError(
            "候选补丁目标不在影响集内: "
            + ", ".join(f"{aid}:{field}" for aid, field in unrelated)
        )

    fact_delta = skufacts.diff_facts(facts_before, facts_after)
    changed_ids = fact_delta["changed"]
    candidate_snap = (
        policy.get_snapshot(candidate_policy_version) if candidate_policy_version else None
    )
    verifier = verifier or _deterministic_verifier

    patches: list[dict[str, Any]] = []
    human_review: list[dict[str, Any]] = []

    for aid, field_name in sorted(wanted):
        artifact = by_id.get(aid)
        if artifact is None:
            continue
        previous = _field_value(artifact, field_name)
        if previous is None:
            continue

        model_value = (model_patch or {}).get(aid, {}).get(field_name)
        candidate_value = previous
        reason_bits: list[str] = []
        triggering: dict[str, Any] = {}
        needs_human = False
        note = ""

        # -- SKU-fact driven ------------------------------------------------
        entry_refs: list[str] = []
        for entry in _all_field_entries(artifact):
            if entry["name"] == field_name:
                entry_refs = entry["fact_refs"]
        sku_hit = sorted(set(entry_refs) & set(changed_ids))
        if sku_hit and not model_value:
            triggering = {"kind": "sku_fact", "fact_ids": sku_hit}
            for fid in sku_hit:
                old_v = facts_before.get(fid, "")
                new_v = facts_after.get(fid, "")
                swaps = _numeric_token_swaps(old_v, new_v)
                candidate_value, changed = _apply_token_swaps(candidate_value, swaps)
                if changed:
                    reason_bits.append("；".join(changed))
                residual = _residual_stale_tokens(candidate_value, old_v, new_v)
                if residual:
                    needs_human = True
                    note = (
                        f"字段仍包含未能安全替换的旧数值 {', '.join(residual)}"
                        f"（与 {old_v!r} → {new_v!r} 单位不一致），需人工确认。"
                    )
            if candidate_value == previous and not needs_human:
                needs_human = True
                note = "SKU 事实变化无法用确定性规则改写该字段，需人工重写。"

        # -- Policy driven (title) ---------------------------------------
        elif field_name == "title" and candidate_snap is not None and not model_value:
            triggering = {
                "kind": "policy",
                "policy_from": base_policy_version,
                "policy_to": candidate_policy_version,
                "rule_ids": [],
            }
            fixed = candidate_value
            applied_rule_ids: list[str] = []
            for rule in candidate_snap.rules:
                if rule.kind == "title_max_length":
                    new_fixed = _trim_title_to(fixed, int(rule.params["max"]))
                    if new_fixed != fixed:
                        applied_rule_ids.append(rule.id)
                        reason_bits.append(
                            f"标题超出 {rule.params['max']} 字符，按词边界截断"
                        )
                    fixed = new_fixed
                elif rule.kind == "prohibited_chars":
                    new_fixed = _strip_prohibited_chars(fixed, str(rule.params["chars"]))
                    if new_fixed != fixed:
                        applied_rule_ids.append(rule.id)
                        reason_bits.append("移除禁用字符")
                    fixed = new_fixed
                elif rule.kind == "repeated_word_limit":
                    exempt = {str(w).lower() for w in (rule.params.get("exempt") or [])}
                    new_fixed = _limit_repeated_words(fixed, int(rule.params["limit"]), exempt)
                    if new_fixed != fixed:
                        applied_rule_ids.append(rule.id)
                        reason_bits.append("删除超限的重复词")
                    fixed = new_fixed
            candidate_value = fixed
            triggering["rule_ids"] = applied_rule_ids
            if candidate_value == previous:
                needs_human = True
                note = "候选政策涉及该标题，但确定性规则未产生改写；如仍不合规需人工处理。"

        # -- Model-supplied value -------------------------------------------
        if model_value is not None:
            candidate_value = str(model_value)
            triggering = triggering or {"kind": "model"}
            reason_bits.append("模型返回的 JSON patch")

        # -- Validation ---------------------------------------------------
        validation: dict[str, Any] = {"checkable": False, "ok": True, "rule_results": []}
        if field_name == "title" and candidate_snap is not None:
            results = policy.evaluate_snapshot(candidate_snap, {"title": candidate_value})
            validation = {
                "checkable": True,
                "ok": not policy.blocking_failures(results),
                "rule_results": [r.to_dict() for r in results if r.checkable],
            }
        source_facts = {k: facts_after.get(k, "") for k in (entry_refs or facts_after)}
        semantic = verifier(candidate_value, source_facts)
        validation["semantic"] = semantic
        if not semantic.get("ok", True):
            needs_human = True
            note = note or "语义保真度校验未通过：候选文案可能引入了无来源的事实。"

        patch = {
            "artifact_id": aid,
            "platform": artifact.get("platform", ""),
            "field": field_name,
            "previous_value": previous,
            "candidate_value": candidate_value,
            "reason": "；".join(b for b in reason_bits if b) or "需要重新编译",
            "triggering": triggering,
            "fact_refs": entry_refs,
            "validation": validation,
            "needs_human_review": needs_human,
            "note": note,
        }
        patches.append(patch)
        if needs_human:
            human_review.append(
                {"artifact_id": aid, "field": field_name, "note": note, "candidate_value": candidate_value}
            )

    return {
        "generated_at": _now_iso(),
        "base_policy_version": base_policy_version,
        "candidate_policy_version": candidate_policy_version,
        "fact_delta": fact_delta,
        "patches": patches,
        "human_review": human_review,
        "counts": {"patches": len(patches), "human_review": len(human_review)},
    }


# --------------------------------------------------------------------------- #
# P1. Semantic-fidelity gate                                                   #
# --------------------------------------------------------------------------- #

from semantic_gate import check_fidelity as _semantic_check_fidelity  # noqa: E402


def _deterministic_verifier(candidate_text: str, source_facts: dict[str, str]) -> dict[str, Any]:
    return _semantic_check_fidelity(candidate_text, source_facts)


# --------------------------------------------------------------------------- #
# G. Minimal apply                                                             #
# --------------------------------------------------------------------------- #


def apply_patches(
    artifacts: list[dict[str, Any]],
    approved_patches: list[dict[str, Any]],
    *,
    facts_after: dict[str, str] | None = None,
    candidate_policy_version: str | None = None,
) -> dict[str, Any]:
    facts_after = facts_after or {}
    result = copy.deepcopy(artifacts)
    by_id = {str(a.get("artifact_id") or a.get("id")): a for a in result}

    approved_by_artifact: dict[str, list[dict[str, Any]]] = {}
    rejected: list[dict[str, Any]] = []
    for patch in approved_patches:
        aid = str(patch.get("artifact_id") or "")
        field_name = str(patch.get("field") or "")
        artifact = by_id.get(aid)
        if artifact is None or _field_value(artifact, field_name) is None:
            rejected.append({"artifact_id": aid, "field": field_name, "reason": "unknown target"})
            continue
        approved_by_artifact.setdefault(aid, []).append(patch)

    candidate_snap = (
        policy.get_snapshot(candidate_policy_version) if candidate_policy_version else None
    )

    applied_ids: list[str] = []
    needs_review_ids: list[str] = []
    checks: dict[str, Any] = {}

    for aid, artifact in by_id.items():
        patch_list = approved_by_artifact.get(aid)
        if not patch_list:
            # untouched — byte-for-byte identical, status unchanged
            continue
        for patch in patch_list:
            _set_field_value(artifact, patch["field"], str(patch["candidate_value"]))
        artifact["revision"] = int(artifact.get("revision", 1)) + 1
        if candidate_policy_version and artifact.get("platform") == (
            candidate_snap.platform if candidate_snap else None
        ):
            artifact["policy_version"] = candidate_policy_version
        if facts_after:
            artifact["sku_revision"] = skufacts.sku_revision_hash(facts_after)
            # refresh fact_refs against the new facts
            if "title" in artifact:
                artifact["title_fact_refs"] = skufacts.compute_fact_refs(
                    str(artifact["title"]), facts_after
                )
            for f in _artifact_fields(artifact):
                text = f"{f.get('label', '')} {f.get('value', '')}"
                f["fact_refs"] = skufacts.compute_fact_refs(text, facts_after)

        # Re-run deterministic checks. The artifact is always validated against
        # the snapshot in force for its OWN platform, and additionally against
        # the candidate snapshot when this migration targets that platform.
        # Without the own-platform pass, a listing carrying a blocking violation
        # unrelated to the migration (e.g. an emoji in a TikTok title during a
        # SKU-drift migration) would be marked 'applied' and carried forward
        # silently.
        artifact_checks: list[dict[str, Any]] = []
        blocking = False
        platform = artifact.get("platform")
        # The candidate snapshot *replaces* the current one for the platform the
        # migration targets — that is what the migration adopts. Every other
        # platform is still judged by the snapshot in force for it.
        snap = None
        if candidate_snap is not None and platform == candidate_snap.platform:
            snap = candidate_snap
        elif platform:
            try:
                snap = policy.current_snapshot(platform)
            except policy.PolicyError:  # pragma: no cover - unknown platform
                snap = None
        if snap is not None:
            results = policy.evaluate_snapshot(snap, {"title": artifact.get("title", "")})
            artifact_checks = [r.to_dict() for r in results if r.checkable]
            blocking = bool(policy.blocking_failures(results))
        checks[aid] = artifact_checks

        unresolved = any(p.get("needs_human_review") for p in patch_list)
        if blocking or unresolved:
            artifact["status"] = "needs_human_review"
            needs_review_ids.append(aid)
        else:
            artifact["status"] = "applied"
            applied_ids.append(aid)

    return {
        "generated_at": _now_iso(),
        "artifacts": result,
        "applied_artifact_ids": applied_ids,
        "needs_human_review_ids": needs_review_ids,
        "rejected_patches": rejected,
        "checks": checks,
    }


# --------------------------------------------------------------------------- #
# H. Rollback                                                                  #
# --------------------------------------------------------------------------- #


def snapshot_state(artifacts: list[dict[str, Any]], *, label: str = "") -> dict[str, Any]:
    payload = copy.deepcopy(artifacts)
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    return {
        "snapshot_id": hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16],
        "taken_at": _now_iso(),
        "label": label,
        "artifacts": payload,
    }


def rollback(snapshot: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(snapshot, dict) or "artifacts" not in snapshot:
        raise ValueError("rollback 需要包含 'artifacts' 的快照对象")
    artifacts = copy.deepcopy(snapshot["artifacts"])
    if not isinstance(artifacts, list):
        raise ValueError("快照 'artifacts' 必须是数组")
    return {
        "generated_at": _now_iso(),
        "restored_from": snapshot.get("snapshot_id", ""),
        "artifacts": artifacts,
    }


# --------------------------------------------------------------------------- #
# I. Migration report                                                          #
# --------------------------------------------------------------------------- #


def build_report(
    *,
    impact: dict[str, Any],
    candidate: dict[str, Any] | None = None,
    apply_result: dict[str, Any] | None = None,
    status: str = "candidate",
    base_policy_version: str | None = None,
    candidate_policy_version: str | None = None,
    validation_before: list[dict[str, Any]] | None = None,
    validation_after: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    if status not in _STATUS_ORDER and status not in ("candidate", "applied", "rolled_back"):
        raise ValueError(f"unknown report status {status!r}")

    pol_diff = impact.get("policy_diff")
    policy_block: dict[str, Any] = {}
    if base_policy_version and candidate_policy_version:
        base_snap = policy.get_snapshot(base_policy_version)
        cand_snap = policy.get_snapshot(candidate_policy_version)
        policy_block = {
            "platform": base_snap.platform,
            "base_version": base_snap.version,
            "candidate_version": cand_snap.version,
            "base_effective_date": base_snap.effective_date,
            "candidate_effective_date": cand_snap.effective_date,
            "source_name": cand_snap.source_name,
            "source_url": cand_snap.source_url,
        }

    patched_fields: list[dict[str, Any]] = []
    preserved_fields: list[dict[str, Any]] = []
    human_review: list[dict[str, Any]] = []
    if candidate:
        approved_targets = {
            (p["artifact_id"], p["field"]) for p in candidate.get("patches", [])
        }
        for patch in candidate.get("patches", []):
            patched_fields.append(
                {
                    "artifact_id": patch["artifact_id"],
                    "field": patch["field"],
                    "previous_value": patch["previous_value"],
                    "candidate_value": patch["candidate_value"],
                    "reason": patch["reason"],
                    "triggering": patch["triggering"],
                    "applied": bool(
                        apply_result
                        and patch["artifact_id"] in apply_result.get("applied_artifact_ids", [])
                    ),
                }
            )
        human_review = list(candidate.get("human_review", []))
        for row in impact.get("affected", []):
            for field_name in row.get("reusable_fields", []):
                if (row["artifact_id"], field_name) not in approved_targets:
                    preserved_fields.append(
                        {"artifact_id": row["artifact_id"], "field": field_name}
                    )
        for row in impact.get("unaffected", []):
            preserved_fields.append({"artifact_id": row["artifact_id"], "field": "*"})

    return {
        "schema": "listing-migration-report/v1",
        "generated_at": _now_iso(),
        "migration_id": hashlib.sha1(
            f"{base_policy_version}|{candidate_policy_version}|{impact.get('generated_at')}".encode()
        ).hexdigest()[:16],
        "status": status,
        "policy": policy_block,
        "rule_diff": pol_diff,
        "fact_delta": impact.get("fact_delta"),
        "impact": {
            "affected_count": impact["summary"]["affected_count"],
            "unaffected_count": impact["summary"]["unaffected_count"],
            "by_cause": impact["summary"]["by_cause"],
            "affected": impact.get("affected", []),
            "unaffected": impact.get("unaffected", []),
        },
        "patches": {
            "patched_fields": patched_fields,
            "preserved_fields": preserved_fields,
            "human_review": human_review,
        },
        "validation": {
            "before": validation_before or [],
            "after": validation_after or [],
        },
        "counts": {
            "patched": len(patched_fields),
            "preserved": len(preserved_fields),
            "human_review": len(human_review),
        },
    }


def render_report_html(report: dict[str, Any]) -> str:
    """Optional readable rendering of a migration report (JSON stays canonical)."""
    esc = lambda s: (  # noqa: E731
        str(s)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )
    pol = report.get("policy", {})
    rows = "".join(
        f"<tr><td>{esc(p['artifact_id'])}</td><td>{esc(p['field'])}</td>"
        f"<td>{esc(p['previous_value'])}</td><td>{esc(p['candidate_value'])}</td>"
        f"<td>{esc(p['reason'])}</td><td>{'✓' if p.get('applied') else '—'}</td></tr>"
        for p in report.get("patches", {}).get("patched_fields", [])
    )
    review = "".join(
        f"<li>{esc(r['artifact_id'])} · {esc(r['field'])} — {esc(r.get('note', ''))}</li>"
        for r in report.get("patches", {}).get("human_review", [])
    )
    return f"""<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>迁移报告 {esc(report.get('migration_id', ''))}</title>
<style>body{{font:14px/1.6 system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem;color:#1c1c1c}}
h1{{font-size:1.3rem}} table{{border-collapse:collapse;width:100%;margin:1rem 0}}
td,th{{border:1px solid #ddd;padding:.4rem .6rem;text-align:left;vertical-align:top}}
.meta{{color:#666}}</style>
<h1>迁移报告 · {esc(report.get('status', ''))}</h1>
<p class="meta">{esc(report.get('generated_at', ''))} · migration_id {esc(report.get('migration_id', ''))}</p>
<p>政策：{esc(pol.get('platform', '—'))} {esc(pol.get('base_version', '—'))} →
{esc(pol.get('candidate_version', '—'))}
（生效日 {esc(pol.get('base_effective_date', '—'))} → {esc(pol.get('candidate_effective_date', '—'))}）<br>
出处：<a href="{esc(pol.get('source_url', ''))}">{esc(pol.get('source_name', ''))}</a></p>
<p>受影响产物 {report.get('impact', {}).get('affected_count', 0)} ·
未受影响 {report.get('impact', {}).get('unaffected_count', 0)} ·
改写字段 {report.get('counts', {}).get('patched', 0)} ·
保留字段 {report.get('counts', {}).get('preserved', 0)} ·
待人工 {report.get('counts', {}).get('human_review', 0)}</p>
<table><thead><tr><th>产物</th><th>字段</th><th>原值</th><th>候选值</th><th>原因</th><th>已应用</th></tr></thead>
<tbody>{rows or '<tr><td colspan="6">无</td></tr>'}</tbody></table>
{'<h2>待人工复核</h2><ul>' + review + '</ul>' if review else ''}
</html>"""
