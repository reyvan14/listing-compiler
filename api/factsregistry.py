"""Extensible product-fact ontology.

``evidence/facts.py`` used to carry three hand-written pattern lists, so adding
an attribute meant editing regex tuples in three places and hoping the
conflict-comparison logic downstream happened to suit it. This registry makes an
attribute a *declaration*: what it is called, what kind of value it holds, which
units it accepts, how to read it out of text, how to decide two readings
disagree, and whether a claim about it needs evidence before it may ship.

One rule outranks everything here: **knowing what an attribute is never makes a
fact true.** The registry can normalise ``0.35 L`` to ``350 ml`` and can tell
you that ``350 ml`` and ``300 ml`` conflict, but nothing in this module returns
a ``verified`` state. Verification remains a human act, recorded in the ledger.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable

from evidence.facts import (
    CLAIM_CERTIFICATION,
    CLAIM_ENVIRONMENTAL,
    CLAIM_MARKETING,
    CLAIM_MATERIAL,
    CLAIM_NUMERIC,
    CLAIM_PERFORMANCE,
    CLAIM_SAFETY,
)

# --------------------------------------------------------------------------- #
# Data types                                                                   #
# --------------------------------------------------------------------------- #

NUMBER = "number"
RANGE = "range"
BOOLEAN = "boolean"
TEXT = "text"
DIMENSION = "dimension"

DATA_TYPES = (NUMBER, RANGE, BOOLEAN, TEXT, DIMENSION)

#: Unit families and the canonical unit each normalises to. A family exists so
#: two readings in different units can be compared without pretending that a
#: length and a volume are the same kind of thing.
UNIT_FAMILIES: dict[str, str] = {
    "volume": "ml",
    "length": "cm",
    "mass": "g",
    "temperature": "°C",
    "energy": "mAh",
    "voltage": "V",
    "power": "W",
    "count": "",
    "duration": "month",
    "": "",
}

#: alias -> (family, factor to canonical unit)
UNIT_ALIASES: dict[str, tuple[str, float]] = {
    # volume
    "ml": ("volume", 1.0),
    "毫升": ("volume", 1.0),
    "cc": ("volume", 1.0),
    "l": ("volume", 1000.0),
    "升": ("volume", 1000.0),
    "fl oz": ("volume", 29.5735),
    "floz": ("volume", 29.5735),
    # length
    "cm": ("length", 1.0),
    "厘米": ("length", 1.0),
    "mm": ("length", 0.1),
    "毫米": ("length", 0.1),
    "m": ("length", 100.0),
    "米": ("length", 100.0),
    "in": ("length", 2.54),
    "inch": ("length", 2.54),
    "inches": ("length", 2.54),
    '"': ("length", 2.54),
    # mass
    "g": ("mass", 1.0),
    "克": ("mass", 1.0),
    "kg": ("mass", 1000.0),
    "千克": ("mass", 1000.0),
    "公斤": ("mass", 1000.0),
    "oz": ("mass", 28.3495),
    "lb": ("mass", 453.592),
    "lbs": ("mass", 453.592),
    # temperature (offsets handled separately; °F is not a linear factor)
    "°c": ("temperature", 1.0),
    "c": ("temperature", 1.0),
    "摄氏度": ("temperature", 1.0),
    # energy / electrical
    "mah": ("energy", 1.0),
    "ah": ("energy", 1000.0),
    "v": ("voltage", 1.0),
    "伏": ("voltage", 1.0),
    "w": ("power", 1.0),
    "瓦": ("power", 1.0),
    "kw": ("power", 1000.0),
    # duration
    "month": ("duration", 1.0),
    "months": ("duration", 1.0),
    "个月": ("duration", 1.0),
    "year": ("duration", 12.0),
    "years": ("duration", 12.0),
    "年": ("duration", 12.0),
}


class UnitError(ValueError):
    """A unit that is not in the registry, or not in the expected family."""


def normalize_unit(value: float, unit: str, *, family: str = "") -> tuple[float, str]:
    """Convert *value* in *unit* to its family's canonical unit.

    Deterministic and traceable: the caller keeps the original reading and this
    returns the canonical one, so a converted number never loses its provenance.
    """
    key = (unit or "").strip().lower()
    if not key:
        if family and family != "count":
            raise UnitError(f"missing unit for family {family!r}")
        return value, UNIT_FAMILIES.get(family, "")
    if key not in UNIT_ALIASES:
        raise UnitError(f"unknown unit {unit!r}")
    found_family, factor = UNIT_ALIASES[key]
    if family and found_family != family:
        raise UnitError(f"unit {unit!r} is {found_family}, expected {family}")
    return value * factor, UNIT_FAMILIES[found_family]


def fahrenheit_to_celsius(value: float) -> float:
    """Temperature is affine, not scalar, so it gets its own conversion."""
    return (value - 32.0) * 5.0 / 9.0


# --------------------------------------------------------------------------- #
# Definitions                                                                  #
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class FactDefinition:
    """One attribute the product may assert."""

    key: str
    #: Chinese label shown in the UI, and an English one for exports.
    label: str
    label_en: str
    claim_type: str
    data_type: str
    unit_family: str = ""
    #: Regexes over lowercased text. Group 1 is the value; group 2 the unit when
    #: the pattern captures one; ``RANGE`` types use groups 1 and 2 as bounds.
    patterns: tuple[str, ...] = ()
    #: Negative patterns turn a boolean fact false rather than absent.
    negative_patterns: tuple[str, ...] = ()
    #: Whether a listing claim about this attribute must be evidence-backed.
    evidence_required: bool = True
    #: Tolerance for numeric conflict comparison, in canonical units.
    tolerance: float = 0.0
    #: Free-text attributes compare case-insensitively after collapsing spaces.
    notes: str = ""

    def normalized(self, raw_value: str, unit: str = "") -> str:
        """Canonical, comparable representation of one reading."""
        return _normalize_value(self, raw_value, unit)

    def conflicts_with(self, a: str, b: str) -> bool:
        """Do two normalised readings disagree?"""
        return _conflicts(self, a, b)


def _collapse(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip().lower()


def _normalize_value(definition: FactDefinition, raw_value: str, unit: str = "") -> str:
    raw = str(raw_value or "").strip()
    if definition.data_type == BOOLEAN:
        return "true" if raw.lower() in ("true", "yes", "1", "是") else "false"
    if definition.data_type in (NUMBER, DIMENSION):
        try:
            number = float(raw)
        except (TypeError, ValueError):
            return _collapse(raw)
        if definition.unit_family:
            try:
                number, _ = normalize_unit(number, unit, family=definition.unit_family)
            except UnitError:
                # An unrecognised unit is preserved verbatim rather than being
                # silently treated as the canonical one.
                return f"{_trim(number)} {_collapse(unit)}".strip()
        return _trim(number)
    if definition.data_type == RANGE:
        parts = re.split(r"\.\.|~|to", raw, maxsplit=1)
        if len(parts) != 2:
            return _collapse(raw)
        try:
            low, high = float(parts[0]), float(parts[1])
        except ValueError:
            return _collapse(raw)
        return f"{_trim(low)}..{_trim(high)}"
    return _collapse(raw)


def _trim(number: float) -> str:
    return str(int(number)) if float(number).is_integer() else format(number, "g")


def _conflicts(definition: FactDefinition, a: str, b: str) -> bool:
    left, right = _collapse(a), _collapse(b)
    if not left or not right:
        return False
    if left == right:
        return False
    if definition.data_type in (NUMBER, DIMENSION):
        try:
            return abs(float(left.split()[0]) - float(right.split()[0])) > definition.tolerance
        except (ValueError, IndexError):
            return True
    if definition.data_type == RANGE:
        return left != right
    return left != right


# --------------------------------------------------------------------------- #
# The registry                                                                 #
# --------------------------------------------------------------------------- #

_DEFS: list[FactDefinition] = [
    # ---- attributes carried over from the original hardcoded patterns ------ #
    FactDefinition(
        key="capacity",
        label="容量",
        label_en="Capacity",
        claim_type=CLAIM_NUMERIC,
        data_type=NUMBER,
        unit_family="volume",
        patterns=(r"(?:capacity|容量|volume)\D{0,12}?(\d+(?:\.\d+)?)\s*(ml|毫升|l|升|cc|fl\s?oz)\b",),
        tolerance=0.5,
    ),
    FactDefinition(
        key="folded_height",
        label="折叠尺寸",
        label_en="Folded height",
        claim_type=CLAIM_NUMERIC,
        data_type=NUMBER,
        unit_family="length",
        patterns=(r"(?:folded|折叠|collapsed)\D{0,16}?(\d+(?:\.\d+)?)\s*(cm|厘米|mm|毫米|in|inch)\b",),
        tolerance=0.05,
    ),
    FactDefinition(
        key="weight",
        label="重量",
        label_en="Weight",
        claim_type=CLAIM_NUMERIC,
        data_type=NUMBER,
        unit_family="mass",
        patterns=(r"(?:weight|重量|net weight)\D{0,12}?(\d+(?:\.\d+)?)\s*(g|克|kg|千克|oz|lbs?)\b",),
        tolerance=0.5,
    ),
    FactDefinition(
        key="temperature_range",
        label="耐温范围",
        label_en="Temperature range",
        claim_type=CLAIM_PERFORMANCE,
        data_type=RANGE,
        unit_family="temperature",
        patterns=(r"(-?\d+)\s*°?\s*c\s*(?:to|~|-|–|至)\s*(-?\d+)\s*°?\s*c",),
    ),
    FactDefinition(
        key="bpa_free",
        label="BPA-Free",
        label_en="BPA free",
        claim_type=CLAIM_CERTIFICATION,
        data_type=BOOLEAN,
        patterns=(r"bpa[\s-]*free", r"不含\s*bpa"),
        negative_patterns=(r"contains\s+bpa", r"检出\s*bpa"),
    ),
    FactDefinition(
        key="food_grade_silicone",
        label="食品级硅胶",
        label_en="Food-grade silicone",
        claim_type=CLAIM_MATERIAL,
        data_type=BOOLEAN,
        patterns=(r"food[\s-]*grade\s+silicone", r"食品级\s*硅胶"),
    ),
    FactDefinition(
        key="dishwasher_safe",
        label="可用洗碗机",
        label_en="Dishwasher safe",
        claim_type=CLAIM_PERFORMANCE,
        data_type=BOOLEAN,
        patterns=(r"dishwasher[\s-]*safe", r"可用洗碗机"),
    ),
    # ---- generic attributes added by the registry -------------------------- #
    FactDefinition(
        key="dimensions",
        label="外形尺寸",
        label_en="Dimensions",
        claim_type=CLAIM_NUMERIC,
        data_type=TEXT,
        patterns=(
            r"(?:dimensions?|尺寸|size)\D{0,10}?"
            r"(\d+(?:\.\d+)?\s*[x×*]\s*\d+(?:\.\d+)?(?:\s*[x×*]\s*\d+(?:\.\d+)?)?\s*"
            r"(?:cm|mm|厘米|毫米|in|inch)?)",
        ),
    ),
    FactDefinition(
        key="material",
        label="材质",
        label_en="Material",
        claim_type=CLAIM_MATERIAL,
        data_type=TEXT,
        patterns=(
            r"(?:material|材质|材料)\s*[:：]?\s*([a-z0-9一-鿿][a-z0-9一-鿿 /-]{1,40})",
        ),
    ),
    FactDefinition(
        key="color",
        label="颜色",
        label_en="Colour",
        claim_type=CLAIM_MARKETING,
        data_type=TEXT,
        evidence_required=False,
        patterns=(r"(?:colou?r|颜色)\s*[:：]?\s*([a-z一-鿿][a-z一-鿿 /-]{1,24})",),
    ),
    FactDefinition(
        key="model_number",
        label="型号",
        label_en="Model number",
        claim_type=CLAIM_NUMERIC,
        data_type=TEXT,
        patterns=(r"(?:model(?:\s*(?:no\.?|number))?|型号)\s*[:：]?\s*([a-z0-9][a-z0-9._/-]{1,30})",),
    ),
    FactDefinition(
        key="manufacturer",
        label="制造商",
        label_en="Manufacturer",
        claim_type=CLAIM_CERTIFICATION,
        data_type=TEXT,
        patterns=(
            r"(?:manufacturer|manufactured by|制造商|生产商)\s*[:：]?\s*"
            r"([a-z0-9一-鿿][a-z0-9一-鿿 .,&-]{1,50})",
        ),
    ),
    FactDefinition(
        key="country_of_origin",
        label="原产地",
        label_en="Country of origin",
        claim_type=CLAIM_CERTIFICATION,
        data_type=TEXT,
        patterns=(
            r"(?:country of origin|made in|原产地|产地)\s*[:：]?\s*"
            r"([a-z一-鿿][a-z一-鿿 ]{1,30})",
        ),
    ),
    FactDefinition(
        key="package_quantity",
        label="包装数量",
        label_en="Package quantity",
        claim_type=CLAIM_NUMERIC,
        data_type=NUMBER,
        unit_family="count",
        patterns=(
            r"(?:pack(?:age)? of|package quantity|包装数量|每包)\D{0,6}?(\d+)",
            r"(\d+)\s*(?:pcs|pieces|件|个)\s*(?:/|per\s+)?(?:pack|包)",
        ),
    ),
    FactDefinition(
        key="battery_capacity",
        label="电池容量",
        label_en="Battery capacity",
        claim_type=CLAIM_SAFETY,
        data_type=NUMBER,
        unit_family="energy",
        patterns=(r"(?:battery|电池)\D{0,12}?(\d+(?:\.\d+)?)\s*(mah|ah)\b",),
        tolerance=1.0,
    ),
    FactDefinition(
        key="voltage",
        label="电压",
        label_en="Voltage",
        claim_type=CLAIM_SAFETY,
        data_type=NUMBER,
        unit_family="voltage",
        patterns=(r"(?:voltage|电压)\D{0,10}?(\d+(?:\.\d+)?)\s*(v|伏)\b",),
        tolerance=0.1,
    ),
    FactDefinition(
        key="power",
        label="功率",
        label_en="Power",
        claim_type=CLAIM_SAFETY,
        data_type=NUMBER,
        unit_family="power",
        patterns=(r"(?:power|功率)\D{0,10}?(\d+(?:\.\d+)?)\s*(w|瓦|kw)\b",),
        tolerance=0.5,
    ),
    FactDefinition(
        key="age_restriction",
        label="适用年龄",
        label_en="Age restriction",
        claim_type=CLAIM_SAFETY,
        data_type=TEXT,
        patterns=(
            r"(?:ages?|适用年龄|年龄)\s*[:：]?\s*(\d+\s*\+?(?:\s*(?:-|–|to|至)\s*\d+)?)",
            r"(\d+\s*\+)\s*(?:years|岁)",
        ),
    ),
    FactDefinition(
        key="recyclable",
        label="可回收",
        label_en="Recyclable",
        claim_type=CLAIM_ENVIRONMENTAL,
        data_type=BOOLEAN,
        patterns=(r"\brecyclable\b", r"可回收"),
        negative_patterns=(r"not\s+recyclable", r"不可回收"),
    ),
    FactDefinition(
        key="warranty",
        label="保修期",
        label_en="Warranty",
        claim_type=CLAIM_PERFORMANCE,
        data_type=NUMBER,
        unit_family="duration",
        patterns=(r"(?:warranty|保修)\D{0,10}?(\d+)\s*(months?|years?|个月|年)\b",),
    ),
]

REGISTRY: dict[str, FactDefinition] = {d.key: d for d in _DEFS}

#: Keys that existed before the registry. Their behaviour must not change.
LEGACY_KEYS = (
    "capacity",
    "folded_height",
    "weight",
    "temperature_range",
    "bpa_free",
    "food_grade_silicone",
    "dishwasher_safe",
)


def definition(key: str) -> "FactDefinition | None":
    return REGISTRY.get(key)


def keys() -> list[str]:
    return sorted(REGISTRY)


def evidence_required(key: str) -> bool:
    found = REGISTRY.get(key)
    return found.evidence_required if found else True


def label_for(key: str) -> str:
    found = REGISTRY.get(key)
    return found.label if found else key


# --------------------------------------------------------------------------- #
# Detection                                                                    #
# --------------------------------------------------------------------------- #


def detect(text: str, *, only: "Iterable[str] | None" = None) -> list[dict[str, Any]]:
    """Attributes *text* deterministically states.

    Returns readings, not verdicts: each entry carries the raw match, the
    canonical value, and the definition it came from. Nothing is marked
    verified, and the caller decides what the reading means.
    """
    if not text:
        return []
    lowered = text.lower()
    wanted = set(only) if only is not None else None
    found: dict[str, dict[str, Any]] = {}

    for key, spec in REGISTRY.items():
        if wanted is not None and key not in wanted:
            continue

        if spec.data_type == BOOLEAN:
            hit = _detect_boolean(spec, lowered)
            if hit:
                found[key] = hit
            continue

        for pattern in spec.patterns:
            match = re.search(pattern, lowered, re.IGNORECASE)
            if not match:
                continue
            if spec.data_type == RANGE:
                raw = f"{match.group(1)}..{match.group(2)}"
                unit = UNIT_FAMILIES.get(spec.unit_family, "")
            else:
                raw = match.group(1).strip()
                unit = match.group(2).strip() if match.lastindex and match.lastindex >= 2 else ""
            value = spec.normalized(raw, unit)
            found[key] = {
                "key": key,
                "value": value,
                "raw_value": raw,
                "raw_unit": unit,
                "unit": UNIT_FAMILIES.get(spec.unit_family, ""),
                "display": _display(spec, value),
                "claim_type": spec.claim_type,
                "data_type": spec.data_type,
                "matched": match.group(0).strip(),
            }
            break

    return [found[k] for k in sorted(found)]


def _detect_boolean(spec: FactDefinition, lowered: str) -> "dict[str, Any] | None":
    for pattern in spec.negative_patterns:
        match = re.search(pattern, lowered, re.IGNORECASE)
        if match:
            return {
                "key": spec.key, "value": "false", "raw_value": "false", "raw_unit": "",
                "unit": "", "display": f"{spec.key} = false", "claim_type": spec.claim_type,
                "data_type": BOOLEAN, "matched": match.group(0).strip(),
            }
    for pattern in spec.patterns:
        match = re.search(pattern, lowered, re.IGNORECASE)
        if match:
            return {
                "key": spec.key, "value": "true", "raw_value": "true", "raw_unit": "",
                "unit": "", "display": f"{spec.key} = true", "claim_type": spec.claim_type,
                "data_type": BOOLEAN, "matched": match.group(0).strip(),
            }
    return None


def _display(spec: FactDefinition, value: str) -> str:
    if spec.data_type == BOOLEAN:
        return f"{spec.key} = {value}"
    unit = UNIT_FAMILIES.get(spec.unit_family, "")
    if spec.data_type == RANGE and unit:
        low, _, high = value.partition("..")
        return f"{low}{unit} to {high}{unit}"
    return f"{value} {unit}".strip()


def conflicts(key: str, a: str, b: str) -> bool:
    """Whether two stored values for *key* genuinely disagree."""
    spec = REGISTRY.get(key)
    if spec is None:
        return _collapse(a) != _collapse(b)
    return spec.conflicts_with(a, b)


def conflicts_among(key: str, values: "Iterable[str]") -> bool:
    """Whether any pair of readings for *key* disagrees."""
    distinct = [v for v in dict.fromkeys(str(v) for v in values) if v]
    for i, left in enumerate(distinct):
        for right in distinct[i + 1:]:
            if conflicts(key, left, right):
                return True
    return False


def display_for(key: str, value: str) -> str:
    """Human-readable rendering of a normalised value for *key*."""
    spec = REGISTRY.get(key)
    return _display(spec, value) if spec else str(value)
