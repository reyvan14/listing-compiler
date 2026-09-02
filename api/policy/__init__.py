"""Versioned, executable marketplace policy packs + deterministic policy diff.

Public surface used by the API layer and the migration engine.
"""

from __future__ import annotations

from .compat import build_legacy_rules
from .diff import PolicyDiff, RuleChange, diff_snapshots
from .engine import (
    RuleResult,
    blocking_failures,
    evaluate_rule,
    evaluate_snapshot,
    warnings,
)
from .packs import (
    KNOWN_KINDS,
    PolicyError,
    PolicyRule,
    PolicySnapshot,
    candidate_snapshot,
    current_snapshot,
    get_snapshot,
    list_snapshot_meta,
    load_registry,
    load_snapshots,
    parse_snapshot,
    snapshots_for,
)

__all__ = [
    "KNOWN_KINDS",
    "PolicyError",
    "PolicyRule",
    "PolicySnapshot",
    "PolicyDiff",
    "RuleChange",
    "RuleResult",
    "build_legacy_rules",
    "candidate_snapshot",
    "current_snapshot",
    "diff_snapshots",
    "evaluate_rule",
    "evaluate_snapshot",
    "blocking_failures",
    "warnings",
    "get_snapshot",
    "list_snapshot_meta",
    "load_registry",
    "load_snapshots",
    "parse_snapshot",
    "snapshots_for",
]
