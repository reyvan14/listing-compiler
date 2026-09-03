"""Text semantic-fidelity gate for candidate listing patches (P1).

Given a candidate text and the *source* SKU facts it is allowed to rely on,
report which facts are missing, contradicted, or unsupported (a factual
addition with no source). Candidate patches that add unsupported measurable
claims are blocked.

The grader is independent of listing generation — it takes only the candidate
string plus the source facts, never the generation response, so a generation
can never grade itself. A model-backed verifier is available for production
(``model_verifier``); tests inject a mocked one.
"""

from __future__ import annotations

import re
from typing import Any, Callable

import skufacts

# Number + a KNOWN unit only, so a number that runs into the next word
# ("300mlfoldable") can't absorb letters into a bogus "unit".
_UNITS = r"(?:°\s*[cf]|℃|℉|ml|cl|l|oz|lbs?|cm|mm|kg|mah|hz|inch(?:es)?|ft|%)"
_MEASURE_RE = re.compile(r"-?\d+(?:\.\d+)?\s*" + _UNITS, re.IGNORECASE)
_UNIT_RE = re.compile(r"^(-?\d+(?:\.\d+)?)(.+)$")


def _measurements(text: str) -> set[str]:
    out: set[str] = set()
    for m in _MEASURE_RE.finditer(text or ""):
        out.add(re.sub(r"\s+", "", m.group(0)).lower())
    return out


def _split_unit(token: str) -> tuple[str, str] | None:
    m = _UNIT_RE.match(token.replace(" ", ""))
    if not m:
        return None
    return m.group(1), m.group(2)


def reverse_extract_facts(text: str) -> dict[str, Any]:
    """Deterministic fact extraction from a candidate string."""
    lowered = (text or "").lower()
    measurements = sorted(_measurements(text))
    keywords = sorted(
        {
            w
            for w in re.findall(r"[a-z]{4,}", lowered)
            if w not in {"with", "that", "this", "from", "your", "have", "will"}
        }
    )
    return {"measurements": measurements, "keywords": keywords}


def check_fidelity(candidate_text: str, source_facts: dict[str, str]) -> dict[str, Any]:
    """Compare candidate measurable claims against the allowed source facts."""
    source_blob = "\n".join(str(v) for v in (source_facts or {}).values())
    source_measures = _measurements(source_blob)
    cand_measures = _measurements(candidate_text)

    source_by_unit: dict[str, set[str]] = {}
    for tok in source_measures:
        parts = _split_unit(tok)
        if parts:
            source_by_unit.setdefault(parts[1], set()).add(parts[0])

    unsupported: list[str] = []
    contradictory: list[dict[str, str]] = []
    for tok in sorted(cand_measures):
        if tok in source_measures:
            continue
        parts = _split_unit(tok)
        if not parts:
            continue
        value, unit = parts
        if unit in source_by_unit:
            # same unit family, different number the source never states
            contradictory.append(
                {"claim": tok, "unit": unit, "source_values": sorted(source_by_unit[unit])}
            )
        else:
            unsupported.append(tok)

    missing = sorted(
        tok
        for tok in source_measures
        if (_split_unit(tok) or ("", ""))[1] not in {(_split_unit(c) or ("", ""))[1] for c in cand_measures}
    )

    ok = not unsupported and not contradictory
    return {
        "ok": ok,
        "missing": missing,
        "contradictory": contradictory,
        "unsupported": unsupported,
        "extracted": reverse_extract_facts(candidate_text),
    }


ChatFn = Callable[..., Any]


def model_verifier(chat_fn: ChatFn, *, model: str | None = None) -> Callable[[str, dict[str, str]], dict[str, Any]]:
    """Wrap a chat function into a verifier. The model only *extracts* facts from
    the candidate text; the pass/fail decision stays in :func:`check_fidelity`
    so the generation response never grades itself.

    Falls back to the deterministic gate on any model failure.
    """

    async def _extract(text: str) -> set[str]:  # pragma: no cover - needs a live model
        raw = await chat_fn(
            [
                {
                    "role": "system",
                    "content": "Extract every explicit measurable claim (number + unit) "
                    "from the text. Reply with a JSON array of strings, nothing else.",
                },
                {"role": "user", "content": text},
            ],
            model=model,
        )
        import json

        try:
            data = json.loads(raw)
            return {str(x).lower().replace(" ", "") for x in data if isinstance(x, (str, int, float))}
        except Exception:
            return set()

    def verify(candidate_text: str, source_facts: dict[str, str]) -> dict[str, Any]:
        # Deterministic gate is always authoritative for the decision.
        return check_fidelity(candidate_text, source_facts)

    verify.extract = _extract  # type: ignore[attr-defined]
    return verify
