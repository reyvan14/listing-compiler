"""Evidence release gate.

Platform policy validation asks "does this text satisfy the marketplace's
formatting rules?". This gate asks a different question: **is every commercial
claim in this text backed by evidence we actually hold?** The two are kept
separate everywhere — separate check ids, separate UI sections — because a
title can be perfectly policy-compliant and still assert an uncertified
BPA-Free claim.

Deterministic throughout: claim detection is pattern matching over the generated
copy, and the verdict is a lookup against the fact ledger. No model is involved,
so the same draft always gates the same way.
"""

from __future__ import annotations

import re
from typing import Any

from .facts import (
    CLAIM_CERTIFICATION,
    CLAIM_ENVIRONMENTAL,
    CLAIM_MATERIAL,
    CLAIM_NUMERIC,
    CLAIM_PERFORMANCE,
    CLAIM_SAFETY,
    CONFLICTING,
    EXPIRED,
    NEEDS_REVIEW,
    UNSUPPORTED,
    VERIFIED,
    fact_id_for,
)

#: Claim detectors run over generated copy. Each maps a phrase in the text to
#: the ledger attribute that would have to back it.
#: (fact key, regex, claim class, human label)
CLAIM_PATTERNS: list[tuple[str, str, str, str]] = [
    ("bpa_free", r"bpa[\s-]*free|不含\s*bpa", CLAIM_CERTIFICATION, "BPA-Free"),
    (
        "food_grade_silicone",
        r"food[\s-]*grade\s+silicone|食品级\s*硅胶",
        CLAIM_MATERIAL,
        "食品级硅胶",
    ),
    ("dishwasher_safe", r"dishwasher[\s-]*safe|可用洗碗机", CLAIM_PERFORMANCE, "可用洗碗机"),
    (
        "temperature_range",
        r"-?\d+\s*°?\s*C\s*(?:to|~|-|–|至)\s*-?\d+\s*°?\s*C",
        CLAIM_PERFORMANCE,
        "耐温范围",
    ),
    ("capacity", r"\b\d+(?:\.\d+)?\s*ml\b|\d+\s*毫升", CLAIM_NUMERIC, "容量"),
    ("folded_height", r"folds?\s+(?:flat\s+)?to\s+\d+(?:\.\d+)?\s*cm|折叠到\s*\d+", CLAIM_NUMERIC, "折叠尺寸"),
    (
        "recyclable",
        r"\brecyclable\b|\bbiodegradable\b|\beco[\s-]*friendly\b|可回收|可降解|环保",
        CLAIM_ENVIRONMENTAL,
        "环保宣称",
    ),
    (
        "child_safe",
        r"child[\s-]*safe|non[\s-]*toxic|无毒|儿童安全",
        CLAIM_SAFETY,
        "安全宣称",
    ),
]

#: Verdicts.
OK = "ok"
BLOCKED = "blocked"
REVIEW = "needs_review"

#: Fact states that let a claim ship.
_PASSING = (VERIFIED,)
#: Fact states that hard-block a dependent claim.
_BLOCKING = (UNSUPPORTED, CONFLICTING, EXPIRED)


def detect_claims(text: str) -> list[dict[str, str]]:
    """Evidence-bearing claims asserted by *text*, deduplicated by fact key."""
    if not text:
        return []
    seen: dict[str, dict[str, str]] = {}
    for key, pattern, claim_type, label in CLAIM_PATTERNS:
        m = re.search(pattern, text, re.IGNORECASE)
        if m and key not in seen:
            seen[key] = {
                "fact_key": key,
                "fact_id": fact_id_for(key),
                "claim_type": claim_type,
                "label": label,
                "matched": m.group(0).strip(),
                "claimed_value": _claimed_value(key, m.group(0)),
            }
    return [seen[k] for k in sorted(seen)]


def _claimed_value(key: str, matched: str) -> str:
    """Normalised value asserted by a matched claim, when it is explicit."""
    numbers = re.findall(r"-?\d+(?:\.\d+)?", matched)
    if key == "temperature_range" and len(numbers) >= 2:
        return f"{_normal_number(numbers[0])}..{_normal_number(numbers[1])}"
    if key in ("capacity", "folded_height") and numbers:
        return _normal_number(numbers[0])
    if key in ("bpa_free", "food_grade_silicone", "dishwasher_safe", "recyclable", "child_safe"):
        return "true"
    return ""


def _normal_number(value: str) -> str:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return str(value).strip().lower()
    return str(int(number)) if number.is_integer() else format(number, "g")


def _normal_fact_value(value: Any) -> str:
    raw = str(value or "").strip().lower()
    if ".." in raw:
        return "..".join(_normal_number(v) for v in raw.split("..", 1))
    if re.fullmatch(r"-?\d+(?:\.\d+)?", raw):
        return _normal_number(raw)
    return raw


def _verdict_for(claim: dict[str, str], fact: "dict[str, Any] | None") -> dict[str, Any]:
    label = claim["label"]
    if fact is None or fact.get("state") == UNSUPPORTED:
        return {
            "verdict": BLOCKED,
            "state": UNSUPPORTED,
            "detail": f"「{label}」缺少任何证据来源。",
            "suggestion": f"上传支撑「{label}」的证据文件，或从文案中删除该宣称。",
        }
    state = fact.get("state")
    if state == CONFLICTING:
        return {
            "verdict": BLOCKED,
            "state": state,
            "detail": f"「{label}」的证据来源相互矛盾。",
            "suggestion": "人工判定以哪份文件为准，再重新编译该字段。",
        }
    if state == EXPIRED:
        return {
            "verdict": BLOCKED,
            "state": state,
            "detail": f"「{label}」所依据的证据已过期。",
            "suggestion": "上传在有效期内的证书，或从文案中删除该宣称。",
        }
    if state == NEEDS_REVIEW:
        return {
            "verdict": REVIEW,
            "state": state,
            "detail": f"「{label}」已提取到证据，但尚未人工确认。",
            "suggestion": "在「证据」标签页确认该事实后即可放行。",
        }
    if state in _PASSING:
        asserted = _normal_fact_value(claim.get("claimed_value"))
        evidenced = _normal_fact_value(fact.get("value"))
        if asserted and evidenced and asserted != evidenced:
            return {
                "verdict": BLOCKED,
                "state": CONFLICTING,
                "detail": f"「{label}」宣称值 {claim.get('matched')} 与已核实证据值 {fact.get('display') or fact.get('value')} 不一致。",
                "suggestion": "修正文案中的数值，或上传并核实能支撑该数值的新证据。",
            }
        return {
            "verdict": OK,
            "state": state,
            "detail": f"「{label}」由已核实的证据支撑。",
            "suggestion": "",
        }
    return {
        "verdict": REVIEW,
        "state": str(state),
        "detail": f"「{label}」的证据状态未知。",
        "suggestion": "请在「证据」标签页复核。",
    }


def evaluate_field(
    field_name: str,
    text: str,
    ledger: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    """Gate one generated field. Returns its worst verdict plus every claim."""
    claims: list[dict[str, Any]] = []
    for claim in detect_claims(text):
        fact = ledger.get(claim["fact_id"])
        verdict = _verdict_for(claim, fact)
        claims.append(
            {
                **claim,
                **verdict,
                "supporting_sources": [
                    {
                        "source_id": s.get("source_id"),
                        "page": s.get("page"),
                        "sheet": s.get("sheet", ""),
                        "cell": s.get("cell", ""),
                        "excerpt": s.get("excerpt", ""),
                        "method": s.get("method", ""),
                        "expires_on": s.get("expires_on", ""),
                    }
                    for s in (fact or {}).get("sources", [])
                ],
            }
        )

    if any(c["verdict"] == BLOCKED for c in claims):
        worst = BLOCKED
    elif any(c["verdict"] == REVIEW for c in claims):
        worst = REVIEW
    else:
        worst = OK

    return {"field": field_name, "verdict": worst, "claims": claims}


#: Pseudo-field for claims the operator asserted in the SKU source of truth.
SOURCE_FIELD = "sku:selling-points"


def evaluate_draft(
    draft: dict[str, Any],
    ledger: dict[str, dict[str, Any]],
    *,
    source_points: str = "",
) -> dict[str, Any]:
    """Gate every field of one platform draft, plus the SKU source of truth.

    Returns per-field verdicts and the ids of the fields that must not ship.
    Marketing copy with no measurable claim yields no findings at all — the gate
    only speaks about statements it can tie to a fact.

    ``source_points`` is gated as its own pseudo-field because a claim the
    operator typed into the product truth source has to be answerable even when
    a platform's generated copy happens to paraphrase it away. The whole point
    of one truth source is that the claim does not escape scrutiny by not being
    echoed on a particular marketplace.
    """
    results: list[dict[str, Any]] = []

    if source_points:
        results.append(evaluate_field(SOURCE_FIELD, source_points, ledger))

    title = str(draft.get("title") or "")
    if title:
        results.append(evaluate_field("title", title, ledger))

    for i, field in enumerate(draft.get("fields") or []):
        if not isinstance(field, dict):
            continue
        name = str(field.get("field") or field.get("label") or f"field-{i + 1}")
        value = str(field.get("value") or "")
        if value:
            results.append(evaluate_field(name, value, ledger))

    fields_with_claims = [r for r in results if r["claims"]]
    blocked = [r["field"] for r in fields_with_claims if r["verdict"] == BLOCKED]
    review = [r["field"] for r in fields_with_claims if r["verdict"] == REVIEW]

    return {
        "platform": draft.get("id") or draft.get("platform") or "",
        "fields": fields_with_claims,
        "blocked_fields": blocked,
        "review_fields": review,
        "verdict": BLOCKED if blocked else (REVIEW if review else OK),
        "claim_count": sum(len(r["claims"]) for r in fields_with_claims),
    }


def to_checks(result: dict[str, Any]) -> list[dict[str, Any]]:
    """Render gate findings as checker-style rows.

    They carry ``kind: "evidence"`` so the UI can keep evidence validation
    visually separate from platform policy validation.
    """
    rows: list[dict[str, Any]] = []
    for field in result.get("fields", []):
        for claim in field["claims"]:
            if claim["verdict"] == OK:
                continue
            rows.append(
                {
                    "id": f"evidence.{field['field']}.{claim['fact_key']}",
                    "label": f"证据 · {claim['label']}",
                    "state": "fix",
                    "detail": f"{field['field']}：{claim['detail']}",
                    "suggestion": claim["suggestion"],
                    "blocking": claim["verdict"] == BLOCKED,
                    "evidence": [claim["matched"]],
                    "kind": "evidence",
                }
            )
    return rows
