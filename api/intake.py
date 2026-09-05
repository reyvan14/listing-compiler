"""Multimodal SKU intake: reading uploads without believing them.

The old behaviour was blunt but safe -- uploads were displayed and never read,
so nothing false could enter a listing. Reading them is more useful and more
dangerous, and this module exists to keep the second from cancelling the first.

Three lines are drawn here.

**Appearance is not evidence.** A photo can show that something is blue, that
it is a cup, that a box has printing on it. It cannot show that the plastic is
BPA-free, food-grade, dishwasher-safe, or 350 ml. Those classes are refused for
image-derived candidates outright (``PROHIBITED_FROM_APPEARANCE``); reading a
printed *number* off packaging via OCR is allowed, because that is reading text,
not inferring from looks -- and it still arrives as ``needs_review``.

**Extraction never verifies.** Every candidate carries value, confidence,
source, locator, method and review state, and the state is always
``needs_review`` no matter how confident the extractor was. Only an operator
moves a fact to ``verified``, through the existing evidence ledger.

**Uploaded text is data, never instruction.** OCR output and document excerpts
are untrusted product content. ``sanitize_for_prompt`` neutralises the shapes an
injected instruction needs, and only *approved* facts -- never raw extracted
text -- are allowed to reach a generation prompt.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import factsregistry
import ocr as ocr_module
from evidence import extract, facts as facts_module, store

_LOCK = threading.RLock()
_SCHEMA = "listing-intake/v1"

# Origins ------------------------------------------------------------------- #

ORIGIN_USER = "user"
ORIGIN_OCR = "ocr"
ORIGIN_DOCUMENT = "document"
ORIGIN_APPEARANCE = "appearance"

ORIGINS = (ORIGIN_USER, ORIGIN_OCR, ORIGIN_DOCUMENT, ORIGIN_APPEARANCE)

# Review states (candidates only; the ledger owns verified facts) ------------ #

NEEDS_REVIEW = "needs_review"
APPROVED = "approved"
REJECTED = "rejected"
CORRECTED = "corrected"

REVIEW_STATES = (NEEDS_REVIEW, APPROVED, REJECTED, CORRECTED)

#: Claim classes that a picture cannot establish. A certificate photographed on
#: a table proves a photo exists, not that the certificate is valid; a cup that
#: looks like silicone is not evidence that it is food-grade silicone.
PROHIBITED_FROM_APPEARANCE = (
    facts_module.CLAIM_CERTIFICATION,
    facts_module.CLAIM_SAFETY,
    facts_module.CLAIM_MATERIAL,
    facts_module.CLAIM_NUMERIC,
    facts_module.CLAIM_PERFORMANCE,
)

#: What an image *can* contribute without reading any text.
OBSERVABLE_FROM_APPEARANCE = ("color",)

MAX_CANDIDATE_CHARS = 400


class IntakeError(ValueError):
    def __init__(self, code: str, message: str, status: int = 400) -> None:
        self.code = code
        self.safe_message = message
        self.http_status = status
        super().__init__(message)


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


# --------------------------------------------------------------------------- #
# Prompt-boundary hygiene                                                      #
# --------------------------------------------------------------------------- #

#: Shapes an injected instruction needs in order to read as one.
_INJECTION_PATTERNS = (
    r"(?i)\bignore\s+(?:all\s+)?(?:previous|prior|above)\b[^\n]*",
    r"(?i)\bdisregard\s+(?:all\s+)?(?:previous|prior|above)\b[^\n]*",
    r"(?i)\byou\s+are\s+now\b[^\n]*",
    r"(?i)\bsystem\s*(?:prompt|message)\s*[:：]",
    r"(?i)\b(?:assistant|system|developer)\s*[:：]",
    r"(?i)</?\s*(?:assistant_reply|agent_plan|system|instructions?)\s*>",
    r"(?i)忽略(?:上面|以上|之前)[^\n]*",
    r"(?i)你现在是[^\n]*",
)


def sanitize_for_prompt(text: str, *, limit: int = 2000) -> str:
    """Neutralise instruction-shaped content in untrusted product text.

    This is defence in depth, not the main defence. The main defence is that raw
    extracted text never reaches a prompt at all -- only approved, typed facts
    do. This exists for the places a human deliberately pastes an excerpt.
    """
    cleaned = str(text or "")
    for pattern in _INJECTION_PATTERNS:
        cleaned = re.sub(pattern, "[已移除疑似指令内容]", cleaned)
    # Fenced blocks and tag delimiters are structural in our own protocol.
    cleaned = cleaned.replace("```", "ˋˋˋ").replace("<", "＜").replace(">", "＞")
    return cleaned[:limit]


def looks_like_injection(text: str) -> bool:
    return any(re.search(pattern, str(text or "")) for pattern in _INJECTION_PATTERNS)


# --------------------------------------------------------------------------- #
# Candidate store                                                              #
# --------------------------------------------------------------------------- #


def _ledger_path() -> Path:
    return store.store_dir() / "intake.json"


def _blank() -> dict[str, Any]:
    return {"schema": _SCHEMA, "seq": 0, "candidates": {}, "conflicts": {}}


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
    data.setdefault("conflicts", {})
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


def _next_id(ledger: dict[str, Any], prefix: str) -> str:
    ledger["seq"] = int(ledger.get("seq") or 0) + 1
    return f"{prefix}-{ledger['seq']:04d}"


# --------------------------------------------------------------------------- #
# Extraction                                                                   #
# --------------------------------------------------------------------------- #


def _candidate(
    *,
    key: str,
    value: str,
    origin: str,
    method: str,
    confidence: float,
    source_id: str,
    page: "int | None" = None,
    box: "dict[str, int] | None" = None,
    excerpt: str = "",
    raw_value: str = "",
    raw_unit: str = "",
) -> dict[str, Any]:
    spec = factsregistry.definition(key)
    return {
        "candidate_id": "",
        "fact_id": facts_module.fact_id_for(key),
        "key": key,
        "label": spec.label if spec else key,
        "value": value,
        "raw_value": raw_value or value,
        "raw_unit": raw_unit,
        "display": factsregistry.display_for(key, value),
        "claim_type": spec.claim_type if spec else facts_module.CLAIM_MARKETING,
        "data_type": spec.data_type if spec else factsregistry.TEXT,
        "origin": origin,
        "method": method,
        # Confidence describes the *extractor*, not the truth of the claim.
        "confidence": round(float(confidence), 3),
        "source_id": source_id,
        "page": page,
        "box": box,
        "excerpt": (excerpt or "")[:MAX_CANDIDATE_CHARS],
        # Always. There is no branch that produces anything else.
        "review_state": NEEDS_REVIEW,
        "created_at": _now(),
        "reviewed_by": "",
        "reviewed_at": "",
        "review_note": "",
    }


def extract_from_text(
    text: str,
    *,
    source_id: str,
    origin: str = ORIGIN_DOCUMENT,
    method: str = "deterministic",
    confidence: float = 1.0,
    page: "int | None" = None,
) -> list[dict[str, Any]]:
    """Candidates from document text. Deterministic parsing, no model."""
    out: list[dict[str, Any]] = []
    for found in factsregistry.detect(text or ""):
        out.append(
            _candidate(
                key=found["key"],
                value=found["value"],
                origin=origin,
                method=method,
                # A deterministic pattern match is certain about what the text
                # *says*; it says nothing about whether the text is true.
                confidence=confidence,
                source_id=source_id,
                page=page,
                excerpt=found["matched"],
                raw_value=found["raw_value"],
                raw_unit=found["raw_unit"],
            )
        )
    return out


def extract_from_image(
    data: bytes,
    *,
    source_id: str,
    languages: "tuple[str, ...] | None" = None,
) -> dict[str, Any]:
    """Read an image: OCR its printed text, and nothing more.

    Returns the OCR result alongside candidates derived from the *text* it read.
    When no engine is installed the result is ``manual_review`` with
    ``ocr_unavailable`` and there are no candidates -- an unread image yields
    nothing, rather than yielding guesses.
    """
    result = ocr_module.run_ocr(data, languages=languages)
    if not result.ok:
        return {"ocr": result.as_dict(), "candidates": [], "readable": False}

    candidates: list[dict[str, Any]] = []
    for found in factsregistry.detect(result.text):
        box = _box_for(result, found["matched"])
        candidates.append(
            _candidate(
                key=found["key"],
                value=found["value"],
                origin=ORIGIN_OCR,
                method=f"{result.provider}:{result.method}",
                # OCR confidence is the engine's, scaled to 0..1. It is low
                # precisely often enough that auto-approval would be reckless.
                confidence=result.mean_confidence() / 100.0,
                source_id=source_id,
                box=box,
                excerpt=found["matched"],
                raw_value=found["raw_value"],
                raw_unit=found["raw_unit"],
            )
        )
    return {"ocr": result.as_dict(), "candidates": candidates, "readable": True}


def _box_for(result: "ocr_module.OcrResult", phrase: str) -> "dict[str, int] | None":
    """Union box of the words that make up *phrase*, when they can be located."""
    wanted = [w for w in re.split(r"\s+", phrase.lower()) if w]
    if not wanted:
        return None
    hits = [w for w in result.words if w.text.lower().strip(",.;:") in wanted]
    if not hits:
        return None
    left = min(w.left for w in hits)
    top = min(w.top for w in hits)
    right = max(w.left + w.width for w in hits)
    bottom = max(w.top + w.height for w in hits)
    return {"left": left, "top": top, "width": right - left, "height": bottom - top}


def appearance_candidates(
    observations: dict[str, str], *, source_id: str
) -> list[dict[str, Any]]:
    """Candidates from what an image visibly shows, with the hard classes barred.

    ``observations`` maps a registry key to a visible value. Anything whose claim
    class cannot be established by looking is dropped, and the drop is reported
    so the caller can say why rather than silently losing it.
    """
    kept: list[dict[str, Any]] = []
    for key, value in (observations or {}).items():
        spec = factsregistry.definition(key)
        if spec is None:
            continue
        if spec.claim_type in PROHIBITED_FROM_APPEARANCE:
            continue
        if key not in OBSERVABLE_FROM_APPEARANCE:
            continue
        kept.append(
            _candidate(
                key=key,
                value=spec.normalized(value),
                origin=ORIGIN_APPEARANCE,
                method="visual-observation",
                confidence=0.5,
                source_id=source_id,
                excerpt=str(value)[:120],
            )
        )
    return kept


def rejected_appearance_keys(observations: dict[str, str]) -> list[dict[str, str]]:
    """Keys refused from appearance, with the reason. Shown, not hidden."""
    out: list[dict[str, str]] = []
    for key in (observations or {}):
        spec = factsregistry.definition(key)
        if spec is None:
            out.append({"key": key, "reason": "未知属性，未纳入。"})
        elif spec.claim_type in PROHIBITED_FROM_APPEARANCE:
            out.append(
                {
                    "key": key,
                    "reason": f"「{spec.label}」属于 {spec.claim_type} 类宣称，看图无法确立，需文档或证书。",
                }
            )
        elif key not in OBSERVABLE_FROM_APPEARANCE:
            out.append({"key": key, "reason": f"「{spec.label}」不在可视觉观察的属性范围内。"})
    return out


# --------------------------------------------------------------------------- #
# Recording and review                                                         #
# --------------------------------------------------------------------------- #


def record(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Persist candidates and recompute conflicts. Idempotent per source+key."""
    stored: list[dict[str, Any]] = []
    with _LOCK:
        ledger = read_ledger()
        for candidate in candidates:
            existing = next(
                (
                    c
                    for c in ledger["candidates"].values()
                    if c["key"] == candidate["key"]
                    and c["source_id"] == candidate["source_id"]
                    and c["origin"] == candidate["origin"]
                ),
                None,
            )
            if existing:
                # Same reading from the same place is not new information.
                if existing["value"] == candidate["value"]:
                    stored.append(dict(existing))
                    continue
                ledger["candidates"].pop(existing["candidate_id"], None)
            row = dict(candidate)
            row["candidate_id"] = _next_id(ledger, "cand")
            ledger["candidates"][row["candidate_id"]] = row
            stored.append(dict(row))
        _recompute_conflicts(ledger)
        _write_ledger(ledger)
    return stored


def _recompute_conflicts(ledger: dict[str, Any]) -> None:
    """Explicit conflict records wherever origins disagree about one attribute."""
    ledger["conflicts"] = {}
    by_key: dict[str, list[dict[str, Any]]] = {}
    for candidate in ledger["candidates"].values():
        if candidate["review_state"] == REJECTED:
            continue
        by_key.setdefault(candidate["key"], []).append(candidate)

    for key, rows in by_key.items():
        values = {r["value"] for r in rows}
        if not factsregistry.conflicts_among(key, values):
            continue
        conflict_id = f"conf-{facts_module.fact_id_for(key)}"
        ledger["conflicts"][conflict_id] = {
            "conflict_id": conflict_id,
            "key": key,
            "label": factsregistry.label_for(key),
            "readings": [
                {
                    "candidate_id": r["candidate_id"],
                    "value": r["value"],
                    "display": r["display"],
                    "origin": r["origin"],
                    "method": r["method"],
                    "confidence": r["confidence"],
                    "source_id": r["source_id"],
                    "review_state": r["review_state"],
                }
                for r in sorted(rows, key=lambda r: r["candidate_id"])
            ],
            "origins": sorted({r["origin"] for r in rows}),
            "detected_at": _now(),
            "resolved": False,
        }


def list_candidates(*, key: str = "", origin: str = "") -> list[dict[str, Any]]:
    rows = [
        c
        for c in read_ledger()["candidates"].values()
        if (not key or c["key"] == key) and (not origin or c["origin"] == origin)
    ]
    return sorted(rows, key=lambda c: c["candidate_id"])


def list_conflicts() -> list[dict[str, Any]]:
    return sorted(read_ledger()["conflicts"].values(), key=lambda c: c["conflict_id"])


def review_candidate(
    candidate_id: str,
    decision: str,
    *,
    operator: str,
    value: "str | None" = None,
    note: str = "",
) -> dict[str, Any]:
    """Approve, correct or reject one candidate.

    Approving is what promotes a reading into the evidence ledger; it is the
    only path, and it requires a named operator. Correcting records the human's
    value and marks the candidate ``corrected`` -- the original reading stays
    visible so a wrong OCR is auditable rather than overwritten.
    """
    operator = (operator or "").strip()[:120]
    if not operator:
        raise IntakeError("missing_operator", "请填写审核人。")
    if decision not in (APPROVED, REJECTED, CORRECTED):
        raise IntakeError("bad_decision", f"未知的审核动作：{decision}")

    with _LOCK:
        ledger = read_ledger()
        candidate = ledger["candidates"].get(candidate_id)
        if candidate is None:
            raise IntakeError("unknown_candidate", "找不到该候选事实。", status=404)

        if decision == CORRECTED:
            if value is None or not str(value).strip():
                raise IntakeError("missing_value", "更正时必须给出新的取值。")
            spec = factsregistry.definition(candidate["key"])
            candidate["corrected_from"] = candidate["value"]
            candidate["value"] = spec.normalized(value) if spec else str(value).strip()
            candidate["display"] = factsregistry.display_for(
                candidate["key"], candidate["value"]
            )
        candidate["review_state"] = decision
        candidate["reviewed_by"] = operator
        candidate["reviewed_at"] = _now()
        candidate["review_note"] = str(note or "")[:500]
        _recompute_conflicts(ledger)
        _write_ledger(ledger)
        result = dict(candidate)

    if decision in (APPROVED, CORRECTED):
        _promote(result, operator=operator)
    return result


def _promote(candidate: dict[str, Any], *, operator: str) -> None:
    """Write an approved candidate into the evidence ledger.

    Two deliberate outcomes, neither of them ``verified``:

    * with a real document behind it, the fact gains that document as a source
      and lands at ``needs_review`` -- supported, awaiting confirmation;
    * without one, it stays ``unsupported``, because an operator agreeing that
      OCR read a number correctly is not a certificate proving the number.

    The second case is not a failure. The release gate blocks unsupported
    claims, which is exactly right for a value nobody has documented.
    """
    fact = facts_module.declare_fact(
        candidate["key"],
        candidate["claim_type"],
        value=candidate["value"],
        state=facts_module.NEEDS_REVIEW,
        note=f"由 {candidate['origin']} 提取，{operator} 于 {candidate['reviewed_at']} 确认读数。",
    )
    known = {s["source_id"] for s in store.list_sources()}
    if candidate.get("source_id") in known:
        facts_module.link_source(
            fact["fact_id"],
            candidate["source_id"],
            value=candidate["value"],
            method=candidate["method"],
            excerpt=candidate.get("excerpt", ""),
            page=candidate.get("page"),
            box=candidate.get("box"),
        )


def approved_facts() -> list[dict[str, Any]]:
    """Facts the ledger has verified. The only ones allowed near a prompt."""
    return [f for f in facts_module.list_facts() if f["state"] == facts_module.VERIFIED]


def prompt_facts() -> list[dict[str, str]]:
    """Typed, approved facts formatted for a generation prompt.

    Note what this returns: labels and normalised values from the registry. It
    never returns OCR text, document excerpts, or anything else a stranger wrote
    -- so there is no string here that an injected instruction could ride in on.
    """
    out: list[dict[str, str]] = []
    for fact in approved_facts():
        spec = factsregistry.definition(fact["key"])
        out.append(
            {
                "key": fact["key"],
                "label": spec.label if spec else fact["key"],
                "value": str(fact.get("display") or fact.get("value") or ""),
            }
        )
    return out


def ingest_source(source_id: str) -> dict[str, Any]:
    """Run the whole intake pipeline over one stored evidence document."""
    source = store.get_source(source_id)
    data = store.read_blob(source_id)
    family = source.get("family", "")

    if family == "image":
        read = extract_from_image(data, source_id=source_id)
        recorded = record(read["candidates"])
        return {
            "source": source,
            "ocr": read["ocr"],
            "candidates": recorded,
            "conflicts": list_conflicts(),
            "note": (
                "已按 OCR 读出的文字提取候选事实，全部需人工确认。"
                if read["readable"]
                else "未读取到图片文字，未产生任何候选事实。"
            ),
        }

    locations = extract.extract_locations(family, data)
    candidates: list[dict[str, Any]] = []
    for location in locations:
        candidates.extend(
            extract_from_text(
                location.get("excerpt", ""),
                source_id=source_id,
                origin=ORIGIN_DOCUMENT,
                method=location.get("method", "deterministic"),
                page=location.get("page"),
            )
        )
    recorded = record(candidates)
    return {
        "source": source,
        "ocr": None,
        "candidates": recorded,
        "conflicts": list_conflicts(),
        "note": "已按文档文本确定性提取候选事实，全部需人工确认。",
    }
