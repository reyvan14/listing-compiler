"""Atomic product facts and their links to evidence locations.

A *fact* is one measurable or checkable statement about the product
(``capacity = 350 ml``, ``bpa_free = true``) with a stable id, a lifecycle
state, and zero or more links into evidence documents.

The central rule of this module: **extraction never produces a `verified`
fact.** Deterministic parsing of a document produces `needs_review`; a human
confirms it into `verified`. A fact nobody has evidence for is `unsupported`.
Two sources disagreeing makes it `conflicting`. An expired source demotes the
facts that depend on it to `expired`. Nothing here silently upgrades certainty.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import threading
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

from . import store

# --------------------------------------------------------------------------- #
# States and claim classes                                                     #
# --------------------------------------------------------------------------- #

VERIFIED = "verified"
NEEDS_REVIEW = "needs_review"
UNSUPPORTED = "unsupported"
CONFLICTING = "conflicting"
EXPIRED = "expired"

FACT_STATES = (VERIFIED, NEEDS_REVIEW, UNSUPPORTED, CONFLICTING, EXPIRED)

#: What kind of commercial claim a fact underwrites. Drives the release gate:
#: everything except `marketing` needs evidence before a claim may ship.
CLAIM_NUMERIC = "numeric"
CLAIM_MATERIAL = "material"
CLAIM_CERTIFICATION = "certification"
CLAIM_SAFETY = "safety"
CLAIM_PERFORMANCE = "performance"
CLAIM_ENVIRONMENTAL = "environmental"
CLAIM_MARKETING = "marketing"

EVIDENCE_REQUIRED_CLAIMS = (
    CLAIM_NUMERIC,
    CLAIM_MATERIAL,
    CLAIM_CERTIFICATION,
    CLAIM_SAFETY,
    CLAIM_PERFORMANCE,
    CLAIM_ENVIRONMENTAL,
)


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _today() -> date:
    return datetime.now(timezone.utc).date()


# --------------------------------------------------------------------------- #
# Deterministic fact detection                                                 #
# --------------------------------------------------------------------------- #

#: Attribute definitions now live in ``factsregistry``, which declares each
#: attribute's units, patterns, data type and conflict rule in one place. This
#: module keeps the ledger; it no longer keeps the ontology.
#:
#: The import is deferred inside the function because ``factsregistry`` imports
#: the claim-type constants from this module.


def detect_facts(text: str) -> list[dict[str, Any]]:
    """Facts a document deterministically states. Values only — no verdicts.

    Returns ``{key, value, unit, display, claim_type}`` entries. The caller
    decides state; this function never marks anything verified.

    Detection is delegated to the fact registry so a new attribute is a
    declaration rather than an edit to three parallel pattern lists.
    """
    import factsregistry

    return [
        {
            "key": found["key"],
            "value": found["value"],
            "unit": found["unit"],
            "display": found["display"],
            "claim_type": found["claim_type"],
        }
        for found in factsregistry.detect(text)
    ]


def values_conflict(key: str, values: "set[str] | list[str]") -> bool:
    """Whether readings for *key* genuinely disagree.

    Exact string inequality was the old rule, which called ``350`` and ``350.0``
    a conflict and made a re-scan of the same document look like contradictory
    evidence. The registry knows each attribute's data type and tolerance, so
    the comparison is now the attribute's own.
    """
    import factsregistry

    distinct = [v for v in dict.fromkeys(str(v) for v in values) if v]
    for i, left in enumerate(distinct):
        for right in distinct[i + 1:]:
            if factsregistry.conflicts(key, left, right):
                return True
    return False


def fact_id_for(key: str) -> str:
    """Stable id for an attribute. Same attribute ⇒ same id, across uploads."""
    return f"ev-{re.sub(r'[^a-z0-9]+', '-', key.lower()).strip('-')}"


# --------------------------------------------------------------------------- #
# Ledger persistence                                                           #
# --------------------------------------------------------------------------- #

_LOCK = threading.Lock()


def _ledger_path() -> Path:
    return store.store_dir() / "facts.json"


def read_ledger() -> dict[str, Any]:
    path = _ledger_path()
    if not path.exists():
        return {"schema": "listing-evidence-facts/v1", "facts": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"schema": "listing-evidence-facts/v1", "facts": {}}
    if not isinstance(data, dict) or not isinstance(data.get("facts"), dict):
        return {"schema": "listing-evidence-facts/v1", "facts": {}}
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


def _blank_fact(key: str, claim_type: str) -> dict[str, Any]:
    return {
        "fact_id": fact_id_for(key),
        "key": key,
        "value": "",
        "unit": "",
        "display": "",
        "claim_type": claim_type,
        "state": UNSUPPORTED,
        "sources": [],
        "updated_at": _now(),
        "note": "",
    }


def ingest_document(
    source_id: str,
    locations: list[dict[str, Any]],
    *,
    expires_on: str = "",
) -> list[dict[str, Any]]:
    """Fold one document's extractions into the ledger.

    Facts land in ``needs_review`` — deterministic parsing establishes what a
    document *says*, not that the claim is true. Two documents stating different
    values for the same attribute make it ``conflicting``.
    """
    touched: list[dict[str, Any]] = []
    live_sources = {s["source_id"] for s in store.list_sources()}
    with _LOCK:
        ledger = read_ledger()
        facts = ledger["facts"]

        # Self-heal: drop links to documents that no longer exist before
        # computing anything. An orphaned link would otherwise keep
        # contradicting new uploads forever.
        for fact in facts.values():
            fact["sources"] = [
                s for s in fact.get("sources", []) if s.get("source_id") in live_sources
            ]

        for loc in locations:
            excerpt = str(loc.get("excerpt") or "")
            if not excerpt:
                continue
            for detected in detect_facts(excerpt):
                fid = fact_id_for(detected["key"])
                fact = facts.get(fid) or _blank_fact(detected["key"], detected["claim_type"])
                link = {
                    "source_id": source_id,
                    "page": loc.get("page"),
                    "sheet": loc.get("sheet", ""),
                    "cell": loc.get("cell", ""),
                    "excerpt": excerpt[:400],
                    "method": loc.get("method", "deterministic"),
                    "value": detected["value"],
                    "expires_on": expires_on,
                }
                # replace any prior link from the same source, keep others
                fact["sources"] = [
                    s for s in fact["sources"] if s.get("source_id") != source_id
                ] + [link]

                values = {s.get("value") for s in fact["sources"] if s.get("value")}
                if values_conflict(detected["key"], values):
                    fact["state"] = CONFLICTING
                    fact["note"] = "多个来源给出不同数值，需人工判定。"
                else:
                    # An operator-verified fact stays verified when a second
                    # source agrees; anything else needs a human look.
                    if fact["state"] != VERIFIED:
                        fact["state"] = NEEDS_REVIEW
                        fact["note"] = ""
                    fact["value"] = detected["value"]
                    fact["unit"] = detected["unit"]
                    fact["display"] = detected["display"]
                fact["claim_type"] = detected["claim_type"]
                fact["updated_at"] = _now()
                facts[fid] = fact
                touched.append(dict(fact))

        _write_ledger(ledger)
    return touched


def set_fact_state(
    fact_id: str,
    state: str,
    *,
    value: "str | None" = None,
    note: str = "",
) -> dict[str, Any]:
    """Operator confirmation or correction. The only path to ``verified``."""
    if state not in FACT_STATES:
        raise store.EvidenceError("bad_state", f"未知的事实状态：{state}")
    with _LOCK:
        ledger = read_ledger()
        fact = ledger["facts"].get(fact_id)
        if fact is None:
            raise store.EvidenceError("unknown_fact", "找不到该产品事实。", status=404)
        if state == VERIFIED and not fact["sources"]:
            raise store.EvidenceError(
                "no_evidence",
                "没有任何证据来源，无法标记为已核实。",
            )
        source_values = {str(s.get("value")) for s in fact["sources"] if s.get("value") is not None}
        if state == VERIFIED and values_conflict(fact.get("key", ""), source_values):
            raise store.EvidenceError(
                "conflicting_evidence",
                "证据来源仍有冲突；请先移除错误来源，再确认事实。",
            )
        fact["state"] = state
        if value is not None:
            fact["value"] = value
            fact["display"] = f"{value} {fact['unit']}".strip()
        fact["note"] = note
        fact["updated_at"] = _now()
        _write_ledger(ledger)
        return dict(fact)


def declare_fact(
    key: str,
    claim_type: str,
    *,
    value: str = "",
    state: str = UNSUPPORTED,
    note: str = "",
) -> dict[str, Any]:
    """Register an attribute the operator intends to claim, evidence or not.

    Used to make an *unsupported* claim explicit — e.g. the copy says BPA-Free
    but no certificate has been uploaded — so the release gate has something to
    point at instead of failing silently.
    """
    if state not in FACT_STATES:
        raise store.EvidenceError("bad_state", f"未知的事实状态：{state}")
    with _LOCK:
        ledger = read_ledger()
        fid = fact_id_for(key)
        fact = ledger["facts"].get(fid) or _blank_fact(key, claim_type)
        fact["claim_type"] = claim_type or fact["claim_type"]
        if value:
            fact["value"] = value
            fact["display"] = f"{value} {fact['unit']}".strip()
        if state == VERIFIED and not fact["sources"]:
            raise store.EvidenceError(
                "no_evidence", "没有任何证据来源，无法标记为已核实。"
            )
        fact["state"] = state
        fact["note"] = note
        fact["updated_at"] = _now()
        ledger["facts"][fid] = fact
        _write_ledger(ledger)
        return dict(fact)


def purge_source(source_id: str) -> int:
    """Remove every link to *source_id* from the stored ledger.

    ``list_facts`` already hides links whose document is gone, but hiding is not
    enough: the stored links still take part in conflict detection, so a deleted
    document would keep contradicting new uploads forever. Deleting a source has
    to actually erase its contribution.

    Returns the number of facts touched.
    """
    touched = 0
    with _LOCK:
        ledger = read_ledger()
        for fact in ledger["facts"].values():
            kept = [s for s in fact.get("sources", []) if s.get("source_id") != source_id]
            if len(kept) == len(fact.get("sources", [])):
                continue
            fact["sources"] = kept
            touched += 1
            values = {s.get("value") for s in kept if s.get("value")}
            if not kept:
                fact["state"] = UNSUPPORTED
                fact["note"] = "支撑该事实的证据文件已被移除。"
            elif values_conflict(fact.get("key", ""), values):
                fact["state"] = CONFLICTING
                fact["note"] = "多个来源给出不同数值，需人工判定。"
            else:
                # The remaining sources now agree; an operator must re-confirm
                # rather than inherit a verdict formed against removed evidence.
                fact["state"] = NEEDS_REVIEW
                fact["note"] = ""
                if values:
                    fact["value"] = next(iter(values))
                    fact["display"] = f"{fact['value']} {fact['unit']}".strip()
            fact["updated_at"] = _now()
        if touched:
            _write_ledger(ledger)
    return touched


def delete_fact(fact_id: str) -> bool:
    with _LOCK:
        ledger = read_ledger()
        if fact_id not in ledger["facts"]:
            return False
        ledger["facts"].pop(fact_id)
        _write_ledger(ledger)
        return True


def _expiry_of(link: dict[str, Any], sources_by_id: dict[str, dict[str, Any]]) -> str:
    return str(
        # The source record is authoritative because an operator may correct
        # its expiry after ingestion.  The copied link value is only a legacy
        # fallback for older ledgers.
        sources_by_id.get(str(link.get("source_id")), {}).get("expires_on")
        or link.get("expires_on")
        or ""
    )


def _is_expired(value: str) -> bool:
    if not value:
        return False
    try:
        return date.fromisoformat(value) < _today()
    except ValueError:
        return False


def list_facts() -> list[dict[str, Any]]:
    """The ledger with expiry applied at read time.

    Expiry is derived rather than stored: a certificate lapses by the passage of
    time, not by an event anyone writes down, so it has to be recomputed on
    every read or the ledger would go quietly stale.
    """
    sources_by_id = {s["source_id"]: s for s in store.list_sources()}
    live_ids = set(sources_by_id)
    out: list[dict[str, Any]] = []

    for fact in read_ledger()["facts"].values():
        fact = dict(fact)
        # drop links whose document was deleted
        fact["sources"] = [
            dict(s, expires_on=_expiry_of(s, sources_by_id))
            for s in fact.get("sources", [])
            if str(s.get("source_id")) in live_ids
        ]
        if not fact["sources"] and fact["state"] in (VERIFIED, NEEDS_REVIEW, CONFLICTING):
            fact["state"] = UNSUPPORTED
            fact["note"] = "支撑该事实的证据文件已被移除。"
        elif fact["sources"] and all(
            _is_expired(s.get("expires_on", "")) for s in fact["sources"]
        ):
            fact["state"] = EXPIRED
            fact["note"] = "全部支撑证据已过期。"
        out.append(fact)

    return sorted(out, key=lambda f: f["fact_id"])


def facts_by_id() -> dict[str, dict[str, Any]]:
    return {f["fact_id"]: f for f in list_facts()}


def link_source(
    fact_id: str,
    source_id: str,
    *,
    value: str,
    method: str = "deterministic",
    excerpt: str = "",
    page: "int | None" = None,
    box: "dict[str, Any] | None" = None,
) -> dict[str, Any]:
    """Attach one document location to an existing fact.

    Intake needs this: an operator confirming an extracted reading should carry
    the document it came from into the ledger, so the fact is *supported* rather
    than a bare assertion. Linking still does not verify — the state lands at
    ``needs_review`` and a human confirms separately.
    """
    with _LOCK:
        ledger = read_ledger()
        fact = ledger["facts"].get(fact_id)
        if fact is None:
            raise store.EvidenceError("unknown_fact", "找不到该产品事实。", status=404)
        link = {
            "source_id": source_id,
            "page": page,
            "sheet": "",
            "cell": "",
            "excerpt": (excerpt or "")[:400],
            "method": method,
            "value": value,
            "expires_on": "",
        }
        if box:
            link["box"] = dict(box)
        fact["sources"] = [
            s for s in fact.get("sources", []) if s.get("source_id") != source_id
        ] + [link]

        values = {s.get("value") for s in fact["sources"] if s.get("value")}
        if values_conflict(fact.get("key", ""), values):
            fact["state"] = CONFLICTING
            fact["note"] = "多个来源给出不同数值，需人工判定。"
        elif fact["state"] != VERIFIED:
            fact["state"] = NEEDS_REVIEW
            fact["note"] = ""
        fact["value"] = value
        fact["display"] = f"{value} {fact.get('unit', '')}".strip()
        fact["updated_at"] = _now()
        _write_ledger(ledger)
        return dict(fact)
