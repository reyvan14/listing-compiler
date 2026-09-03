"""Stable SKU fact IDs and deterministic fact-reference extraction.

A SKU's facts are its product name (``name``) plus one entry per non-empty
selling-point line (``fact-1``, ``fact-2`` …). Generated listing fields record
which fact IDs they depend on (``factRefs``) so a later fact change can be
turned into a precise blast radius instead of "regenerate everything".

Everything here is deterministic string work — no model, no network.
"""

from __future__ import annotations

import hashlib
import re
from typing import Iterable

_STOPWORDS = {
    "with", "that", "this", "from", "your", "have", "will", "into", "than",
    "them", "then", "they", "and", "the", "for", "not", "但是", "而且", "以及",
    "适合", "可用", "可以",
}

# number + optional known unit. The unit is a whitelist so a number that runs
# straight into the next word ("300mlfoldable") can't swallow letters.
_UNIT = r"(?:°\s*[cf]|℃|℉|ml|cl|l|oz|lbs?|cm|mm|kg|mah|hz|inch(?:es)?|ft|%)"
_NUM_TOKEN_RE = re.compile(r"-?\d+(?:\.\d+)?\s*" + _UNIT + r"?", re.IGNORECASE)
_ASCII_WORD_RE = re.compile(r"[a-z]{4,}")
_CJK_RUN_RE = re.compile(r"[一-鿿]{2,}")
_FACT_ID_RE = re.compile(r"^fact-(\d+)$")


def parse_sku_facts(product_name: str, points: str) -> dict[str, str]:
    """``{"name": ..., "fact-1": <line 1>, "fact-2": <line 2>, ...}``.

    Selling-point lines are split on newlines; blank lines are skipped but do
    *not* shift the numbering of the lines that follow — numbering is by
    surviving line order, which is stable for a given input.
    """
    facts: dict[str, str] = {}
    name = (product_name or "").strip()
    if name:
        facts["name"] = name
    idx = 0
    for raw in (points or "").split("\n"):
        line = raw.strip()
        if not line:
            continue
        idx += 1
        facts[f"fact-{idx}"] = line
    return facts


def fact_sort_key(fact_id: str) -> tuple[int, int, str]:
    if fact_id == "name":
        return (0, 0, "")
    m = _FACT_ID_RE.match(fact_id)
    if m:
        return (1, int(m.group(1)), "")
    return (2, 0, fact_id)


def salient_tokens(text: str) -> set[str]:
    """Distinctive tokens of a fact: measurements, long numbers, meaningful
    words, and short CJK n-grams. Used only for substring matching."""
    if not text:
        return set()
    lowered = text.lower()
    compact = lowered.replace(" ", "")
    tokens: set[str] = set()

    for m in _NUM_TOKEN_RE.finditer(lowered):
        tok = re.sub(r"\s+", "", m.group(0))
        if not re.match(r"-?\d", tok):
            continue
        tokens.add(tok)
        num = re.match(r"-?\d+(?:\.\d+)?", tok)
        if num:
            digits = num.group(0).lstrip("-").split(".")[0]
            if len(digits) >= 2:
                tokens.add(num.group(0).lstrip("-"))

    for m in _ASCII_WORD_RE.finditer(lowered):
        word = m.group(0)
        if word not in _STOPWORDS:
            tokens.add(word)

    # Full CJK runs only (no sub-grams): matching must be a real shared phrase,
    # not an incidental two-character overlap ("防漏盖" vs "防漏测试").
    for m in _CJK_RUN_RE.finditer(text):
        run = m.group(0)
        if run not in _STOPWORDS and len(run) >= 2:
            tokens.add(run)

    if "bpa" in compact:
        tokens.add("bpa")

    return {t for t in tokens if len(t) >= 2}


def _is_cjk(token: str) -> bool:
    return bool(token) and "一" <= token[0] <= "鿿"


def compute_fact_refs(text: str, facts: dict[str, str]) -> list[str]:
    """Fact IDs whose distinctive tokens appear in *text*. Sorted, deduped."""
    if not text:
        return []
    lowered_compact = text.lower().replace(" ", "")
    refs: set[str] = set()
    for fact_id, value in facts.items():
        for token in salient_tokens(value):
            hit = token in text if _is_cjk(token) else token in lowered_compact
            if hit:
                refs.add(fact_id)
                break
    return sorted(refs, key=fact_sort_key)


def validate_fact_refs(refs: Iterable[str], facts: dict[str, str]) -> list[str]:
    """Drop unknown / malformed IDs; keep order stable."""
    valid = set(facts)
    seen: set[str] = set()
    out: list[str] = []
    for ref in refs or []:
        ref = str(ref).strip()
        if ref in valid and ref not in seen:
            seen.add(ref)
            out.append(ref)
    return sorted(out, key=fact_sort_key)


def hash_fact(value: str) -> str:
    return hashlib.sha1(value.strip().encode("utf-8")).hexdigest()[:12]


def fact_hashes(facts: dict[str, str]) -> dict[str, str]:
    return {fid: hash_fact(val) for fid, val in facts.items()}


def sku_revision_hash(facts: dict[str, str]) -> str:
    joined = "\n".join(f"{fid}={facts[fid]}" for fid in sorted(facts, key=fact_sort_key))
    return hashlib.sha1(joined.encode("utf-8")).hexdigest()[:16]


def diff_facts(old: dict[str, str], new: dict[str, str]) -> dict[str, list[str]]:
    """IDs added / removed / changed between two fact maps."""
    old_h = fact_hashes(old)
    new_h = fact_hashes(new)
    added = [k for k in new if k not in old]
    removed = [k for k in old if k not in new]
    changed = [k for k in new if k in old and old_h[k] != new_h[k]]
    return {
        "added": sorted(added, key=fact_sort_key),
        "removed": sorted(removed, key=fact_sort_key),
        "changed": sorted(changed, key=fact_sort_key),
    }
