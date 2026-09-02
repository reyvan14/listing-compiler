"""Execute policy rules against a listing artifact.

Deterministic. ``evaluate_rule`` returns a small structured result; ``pass`` is
``True`` when the rule is satisfied (or not mechanically checkable, e.g. an image
white-background rule — those return ``pass=True`` with ``checkable=False``).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from .packs import PolicyRule, PolicySnapshot

_WORD_RE = re.compile(r"[A-Za-z0-9一-鿿]+")


@dataclass(frozen=True)
class RuleResult:
    rule_id: str
    kind: str
    severity: str
    field: str
    ok: bool
    checkable: bool
    detail: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "rule_id": self.rule_id,
            "kind": self.kind,
            "severity": self.severity,
            "field": self.field,
            "ok": self.ok,
            "checkable": self.checkable,
            "detail": self.detail,
        }


def _title_of(artifact: dict[str, Any]) -> str:
    return str(artifact.get("title") or "")


def evaluate_rule(rule: PolicyRule, artifact: dict[str, Any]) -> RuleResult:
    kind = rule.kind
    params = dict(rule.params or {})

    def result(ok: bool, checkable: bool, detail: str) -> RuleResult:
        return RuleResult(rule.id, kind, rule.severity, rule.field, ok, checkable, detail)

    if kind == "title_max_length":
        title = _title_of(artifact)
        limit = int(params["max"])
        ok = len(title) <= limit
        return result(ok, True, f"标题 {len(title)} 字符，上限 {limit}。")

    if kind == "title_min_length":
        title = _title_of(artifact)
        floor = int(params["min"])
        ok = len(title) >= floor
        return result(ok, True, f"标题 {len(title)} 字符，下限 {floor}。")

    if kind == "prohibited_chars":
        title = _title_of(artifact)
        chars = str(params["chars"])
        hits = sorted({c for c in title if c in chars})
        ok = not hits
        return result(ok, True, "无禁用字符。" if ok else f"包含禁用字符：{' '.join(hits)}")

    if kind == "repeated_word_limit":
        title = _title_of(artifact)
        limit = int(params["limit"])
        exempt = {str(w).lower() for w in (params.get("exempt") or [])}
        counts: dict[str, int] = {}
        for word in _WORD_RE.findall(title.lower()):
            if word in exempt:
                continue
            counts[word] = counts.get(word, 0) + 1
        over = sorted(w for w, n in counts.items() if n > limit)
        ok = not over
        return result(
            ok,
            True,
            f"无重复超限词（上限 {limit}）。" if ok else f"重复超过 {limit} 次：{', '.join(over)}",
        )

    if kind == "image_white_background":
        return result(True, False, "主图规则需人工/像素核验，机械检查不判定。")

    # kind == "text" or any informational rule
    return result(True, False, rule.description or "说明性条款，不做机械判定。")


def evaluate_snapshot(snapshot: PolicySnapshot, artifact: dict[str, Any]) -> list[RuleResult]:
    return [evaluate_rule(rule, artifact) for rule in snapshot.rules]


def blocking_failures(results: list[RuleResult]) -> list[RuleResult]:
    return [r for r in results if r.checkable and not r.ok and r.severity == "blocking"]


def warnings(results: list[RuleResult]) -> list[RuleResult]:
    return [r for r in results if r.checkable and not r.ok and r.severity == "warn"]
