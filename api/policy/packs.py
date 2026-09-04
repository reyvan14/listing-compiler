"""Versioned, executable policy packs.

A *policy snapshot* is a dated excerpt of one marketplace's rules, bundled in the
repo (``policy/snapshots/*.yaml``) so the demo is reproducible offline. Each
snapshot is ``current`` (the rule set in force), ``candidate`` (an announced,
not-yet-adopted rule set), or ``historical`` (a dated replay baseline). Rules are
*executable*: every rule has a
``kind`` that :mod:`policy.engine` knows how to evaluate against an artifact.

Nothing here calls a model or the network.
"""

from __future__ import annotations

from dataclasses import dataclass
from dataclasses import field as dataclass_field
from functools import lru_cache
from pathlib import Path
from typing import Any, Mapping

import yaml

_SNAP_DIR = Path(__file__).resolve().parent / "snapshots"

VALID_STATUS = ("current", "candidate", "historical")
VALID_SEVERITY = ("warn", "blocking")

# kind -> required param names (all params beyond these are allowed but ignored)
KNOWN_KINDS: dict[str, tuple[str, ...]] = {
    "title_max_length": ("max",),
    "title_min_length": ("min",),
    "prohibited_chars": ("chars",),
    "repeated_word_limit": ("limit",),
    "no_emoji": (),
    "no_hashtags": (),
    "promotional_language": (),
    "title_structure": (),
    # Image rules. Everything except the two manual kinds is settled from real
    # pixels by imagecheck.py; the text engine never grades them.
    "image_white_background": (),
    "image_format": ("allowed",),
    "image_min_dimensions": ("min_width", "min_height"),
    "image_max_dimensions": ("max_width", "max_height"),
    "image_max_bytes": ("max",),
    "image_aspect_ratio": ("allowed",),
    "image_no_transparency": (),
    #: Real requirements that need OCR / object detection. imagecheck reports
    #: them as manual_review rather than pretending to have checked them.
    "image_subject_coverage": ("min_ratio",),
    "image_no_overlaid_text": (),
    "text": (),
}


class PolicyError(ValueError):
    """A snapshot file is missing required data or is internally inconsistent."""


def _canon(value: Any) -> Any:
    """Deterministic, hashable-ish representation for stable diffing/serialising."""
    if isinstance(value, Mapping):
        return {str(k): _canon(value[k]) for k in sorted(value, key=str)}
    if isinstance(value, (list, tuple)):
        return [_canon(v) for v in value]
    return value


@dataclass(frozen=True)
class PolicyRule:
    id: str
    kind: str
    severity: str
    description: str
    field: str = ""
    params: Mapping[str, Any] = dataclass_field(default_factory=dict)

    def signature(self) -> dict[str, Any]:
        """The parts that decide whether two rules with the same id 'changed'."""
        return {
            "kind": self.kind,
            "severity": self.severity,
            "field": self.field,
            "params": _canon(dict(self.params)),
        }

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind,
            "severity": self.severity,
            "field": self.field,
            "description": self.description,
            "params": _canon(dict(self.params)),
        }


@dataclass(frozen=True)
class PolicySnapshot:
    platform: str
    market: str
    version: str
    status: str
    effective_date: str
    excerpt_date: str
    source_name: str
    source_url: str
    summary: str
    display: Mapping[str, str]
    rules: tuple[PolicyRule, ...]
    notes: str = ""
    reference_name: str = ""
    reference_url: str = ""

    def rule_map(self) -> dict[str, PolicyRule]:
        return {r.id: r for r in self.rules}

    def meta(self) -> dict[str, Any]:
        return {
            "platform": self.platform,
            "market": self.market,
            "version": self.version,
            "status": self.status,
            "effective_date": self.effective_date,
            "excerpt_date": self.excerpt_date,
            "source_name": self.source_name,
            "source_url": self.source_url,
            "reference_name": self.reference_name,
            "reference_url": self.reference_url,
            "summary": self.summary,
            "notes": self.notes,
            "display": dict(self.display),
            "rule_ids": [r.id for r in self.rules],
        }

    def to_dict(self) -> dict[str, Any]:
        return {**self.meta(), "rules": [r.to_dict() for r in self.rules]}


_DATE_KEYS = ("effective_date", "excerpt_date")


def _require(raw: Mapping[str, Any], key: str, where: str) -> Any:
    if key not in raw or raw[key] in (None, ""):
        raise PolicyError(f"{where}: missing required field '{key}'")
    return raw[key]


def _valid_date(value: str) -> bool:
    parts = str(value).split("-")
    return (
        len(parts) == 3
        and len(parts[0]) == 4
        and all(p.isdigit() for p in parts)
        and 1 <= int(parts[1]) <= 12
        and 1 <= int(parts[2]) <= 31
    )


def _parse_rule(raw: Mapping[str, Any], where: str) -> PolicyRule:
    if not isinstance(raw, Mapping):
        raise PolicyError(f"{where}: each rule must be a mapping")
    rid = str(_require(raw, "id", where)).strip()
    kind = str(_require(raw, "kind", where)).strip()
    if kind not in KNOWN_KINDS:
        raise PolicyError(f"{where}: rule '{rid}' has unknown kind '{kind}'")
    severity = str(raw.get("severity", "warn")).strip()
    if severity not in VALID_SEVERITY:
        raise PolicyError(f"{where}: rule '{rid}' severity must be one of {VALID_SEVERITY}")
    params = raw.get("params") or {}
    if not isinstance(params, Mapping):
        raise PolicyError(f"{where}: rule '{rid}' params must be a mapping")
    for required in KNOWN_KINDS[kind]:
        if required not in params:
            raise PolicyError(
                f"{where}: rule '{rid}' (kind '{kind}') missing param '{required}'"
            )
    if kind in ("title_max_length", "title_min_length"):
        bound_key = "max" if kind == "title_max_length" else "min"
        if not isinstance(params[bound_key], int) or params[bound_key] <= 0:
            raise PolicyError(f"{where}: rule '{rid}' param '{bound_key}' must be a positive int")
    if kind == "repeated_word_limit":
        if not isinstance(params["limit"], int) or params["limit"] <= 0:
            raise PolicyError(f"{where}: rule '{rid}' param 'limit' must be a positive int")
        if "exempt" in params and not isinstance(params["exempt"], (list, tuple)):
            raise PolicyError(f"{where}: rule '{rid}' param 'exempt' must be a list")
    if kind == "prohibited_chars" and not str(params["chars"]):
        raise PolicyError(f"{where}: rule '{rid}' param 'chars' must be a non-empty string")
    if kind == "promotional_language":
        for key in ("openers", "phrases"):
            if key in params and not isinstance(params[key], (list, tuple)):
                raise PolicyError(f"{where}: rule '{rid}' param '{key}' must be a list")
    if kind == "title_structure" and "require_size" in params:
        if not isinstance(params["require_size"], bool):
            raise PolicyError(f"{where}: rule '{rid}' param 'require_size' must be a boolean")
    return PolicyRule(
        id=rid,
        kind=kind,
        severity=severity,
        description=str(raw.get("description", "")).strip(),
        field=str(raw.get("field", "")).strip(),
        params=_canon(dict(params)),
    )


def parse_snapshot(raw: Mapping[str, Any], *, where: str) -> PolicySnapshot:
    if not isinstance(raw, Mapping):
        raise PolicyError(f"{where}: snapshot must be a mapping")
    status = str(_require(raw, "status", where)).strip()
    if status not in VALID_STATUS:
        raise PolicyError(f"{where}: status must be one of {VALID_STATUS}")
    for date_key in _DATE_KEYS:
        if not _valid_date(_require(raw, date_key, where)):
            raise PolicyError(f"{where}: '{date_key}' must be YYYY-MM-DD")
    raw_rules = raw.get("rules") or []
    if not isinstance(raw_rules, list) or not raw_rules:
        raise PolicyError(f"{where}: 'rules' must be a non-empty list")
    rules = tuple(_parse_rule(r, where=where) for r in raw_rules)
    seen: set[str] = set()
    for r in rules:
        if r.id in seen:
            raise PolicyError(f"{where}: duplicate rule id '{r.id}'")
        seen.add(r.id)
    display = raw.get("display") or {}
    if not isinstance(display, Mapping):
        raise PolicyError(f"{where}: 'display' must be a mapping")
    return PolicySnapshot(
        platform=str(_require(raw, "platform", where)).strip(),
        market=str(raw.get("market", "US")).strip(),
        version=str(_require(raw, "version", where)).strip(),
        status=status,
        effective_date=str(raw["effective_date"]).strip(),
        excerpt_date=str(raw["excerpt_date"]).strip(),
        source_name=str(_require(raw, "source_name", where)).strip(),
        source_url=str(_require(raw, "source_url", where)).strip(),
        summary=" ".join(str(raw.get("summary", "")).split()),
        display={str(k): str(v) for k, v in display.items()},
        rules=rules,
        notes=" ".join(str(raw.get("notes", "")).split()),
        reference_name=str(raw.get("reference_name", "")).strip(),
        reference_url=str(raw.get("reference_url", "")).strip(),
    )


@lru_cache(maxsize=1)
def load_registry() -> dict[str, PolicySnapshot]:
    """version -> snapshot, loaded and validated once from ``snapshots/``."""
    registry: dict[str, PolicySnapshot] = {}
    for path in sorted(_SNAP_DIR.glob("*.yaml")):
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
        snap = parse_snapshot(raw, where=path.name)
        if snap.version in registry:
            raise PolicyError(f"duplicate snapshot version '{snap.version}' ({path.name})")
        registry[snap.version] = snap
    if not registry:
        raise PolicyError(f"no policy snapshots found in {_SNAP_DIR}")
    # exactly one 'current' per platform
    by_platform: dict[str, list[PolicySnapshot]] = {}
    for snap in registry.values():
        by_platform.setdefault(snap.platform, []).append(snap)
    for platform, snaps in by_platform.items():
        currents = [s for s in snaps if s.status == "current"]
        if len(currents) != 1:
            raise PolicyError(
                f"platform '{platform}' must have exactly one 'current' snapshot, found {len(currents)}"
            )
    return registry


def load_snapshots() -> dict[str, PolicySnapshot]:
    return dict(load_registry())


def get_snapshot(version: str) -> PolicySnapshot:
    try:
        return load_registry()[version]
    except KeyError:
        raise PolicyError(f"unknown policy version '{version}'") from None


def snapshots_for(platform: str) -> list[PolicySnapshot]:
    return [s for s in load_registry().values() if s.platform == platform]


def current_snapshot(platform: str) -> PolicySnapshot:
    for snap in load_registry().values():
        if snap.platform == platform and snap.status == "current":
            return snap
    raise PolicyError(f"no current snapshot for platform '{platform}'")


def candidate_snapshot(platform: str) -> PolicySnapshot | None:
    for snap in load_registry().values():
        if snap.platform == platform and snap.status == "candidate":
            return snap
    return None


def historical_snapshot(platform: str) -> PolicySnapshot | None:
    for snap in load_registry().values():
        if snap.platform == platform and snap.status == "historical":
            return snap
    return None


def list_snapshot_meta() -> list[dict[str, Any]]:
    order = {"amazon": 0, "tiktok": 1, "shopify": 2}
    snaps = sorted(
        load_registry().values(),
        key=lambda s: (order.get(s.platform, 9), s.status != "current", s.version),
    )
    return [s.meta() for s in snaps]
