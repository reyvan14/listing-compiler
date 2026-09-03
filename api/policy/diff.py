"""Deterministic diff between two policy snapshots.

No model is involved: two rules with the same ``id`` are 'changed' iff their
:meth:`PolicyRule.signature` differs. Rules present on only one side are
added / removed.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .packs import PolicyRule, PolicySnapshot


@dataclass(frozen=True)
class RuleChange:
    rule_id: str
    field: str
    old: dict[str, Any]
    new: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "rule_id": self.rule_id,
            "field": self.field,
            "old": self.old,
            "new": self.new,
        }


@dataclass(frozen=True)
class PolicyDiff:
    platform: str
    base_version: str
    candidate_version: str
    base_effective_date: str
    candidate_effective_date: str
    source_name: str
    source_url: str
    added: tuple[PolicyRule, ...]
    removed: tuple[PolicyRule, ...]
    changed: tuple[RuleChange, ...]

    @property
    def is_empty(self) -> bool:
        return not (self.added or self.removed or self.changed)

    def affected_fields(self) -> list[str]:
        fields: list[str] = []
        for rule in (*self.added, *self.removed):
            if rule.field and rule.field not in fields:
                fields.append(rule.field)
        for change in self.changed:
            fld = change.field or change.new.get("field") or change.old.get("field") or ""
            if fld and fld not in fields:
                fields.append(fld)
        return fields

    def to_dict(self) -> dict[str, Any]:
        return {
            "platform": self.platform,
            "base_version": self.base_version,
            "candidate_version": self.candidate_version,
            "base_effective_date": self.base_effective_date,
            "candidate_effective_date": self.candidate_effective_date,
            "source_name": self.source_name,
            "source_url": self.source_url,
            "added": [r.to_dict() for r in self.added],
            "removed": [r.to_dict() for r in self.removed],
            "changed": [c.to_dict() for c in self.changed],
            "affected_fields": self.affected_fields(),
            "is_empty": self.is_empty,
        }


def diff_snapshots(base: PolicySnapshot, candidate: PolicySnapshot) -> PolicyDiff:
    if base.platform != candidate.platform:
        raise ValueError(
            f"cannot diff across platforms: {base.platform!r} vs {candidate.platform!r}"
        )
    base_rules = base.rule_map()
    cand_rules = candidate.rule_map()

    added = tuple(
        cand_rules[rid] for rid in sorted(cand_rules) if rid not in base_rules
    )
    removed = tuple(
        base_rules[rid] for rid in sorted(base_rules) if rid not in cand_rules
    )
    changed: list[RuleChange] = []
    for rid in sorted(set(base_rules) & set(cand_rules)):
        old_rule = base_rules[rid]
        new_rule = cand_rules[rid]
        if old_rule.signature() != new_rule.signature():
            changed.append(
                RuleChange(
                    rule_id=rid,
                    field=new_rule.field or old_rule.field,
                    old=old_rule.to_dict(),
                    new=new_rule.to_dict(),
                )
            )

    return PolicyDiff(
        platform=base.platform,
        base_version=base.version,
        candidate_version=candidate.version,
        base_effective_date=base.effective_date,
        candidate_effective_date=candidate.effective_date,
        source_name=candidate.source_name,
        source_url=candidate.source_url,
        added=added,
        removed=removed,
        changed=tuple(changed),
    )
