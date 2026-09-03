"""Execute policy rules against a listing artifact.

Deterministic. ``evaluate_rule`` returns a small structured result; ``pass`` is
``True`` when the rule is satisfied (or not mechanically checkable, e.g. an image
white-background rule — those return ``pass=True`` with ``checkable=False``).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from . import text_rules
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
    #: What the operator should do about it. Empty when the rule passed.
    suggestion: str = ""
    #: The offending substrings, so the UI can point at them.
    evidence: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "rule_id": self.rule_id,
            "kind": self.kind,
            "severity": self.severity,
            "field": self.field,
            "ok": self.ok,
            "checkable": self.checkable,
            "detail": self.detail,
            "suggestion": self.suggestion,
            "evidence": list(self.evidence),
        }


def _title_of(artifact: dict[str, Any]) -> str:
    return str(artifact.get("title") or "")


def evaluate_rule(rule: PolicyRule, artifact: dict[str, Any]) -> RuleResult:
    kind = rule.kind
    params = dict(rule.params or {})

    def result(
        ok: bool,
        checkable: bool,
        detail: str,
        suggestion: str = "",
        evidence: "list[str] | tuple[str, ...]" = (),
    ) -> RuleResult:
        return RuleResult(
            rule.id,
            kind,
            rule.severity,
            rule.field,
            ok,
            checkable,
            detail,
            "" if ok else suggestion,
            tuple(evidence),
        )

    if kind == "title_max_length":
        title = _title_of(artifact)
        limit = int(params["max"])
        ok = len(title) <= limit
        return result(
            ok,
            True,
            f"标题 {len(title)} 字符，上限 {limit}。",
            f"删减到 {limit} 字符以内，优先保留品牌、品类、关键属性与规格。",
        )

    if kind == "title_min_length":
        title = _title_of(artifact)
        floor = int(params["min"])
        ok = len(title) >= floor
        return result(
            ok,
            True,
            f"标题 {len(title)} 字符，下限 {floor}。",
            f"补足到 {floor} 字符以上，补充品类、材质、规格等事实属性。",
        )

    if kind == "prohibited_chars":
        title = _title_of(artifact)
        chars = str(params["chars"])
        hits = sorted({c for c in title if c in chars})
        ok = not hits
        return result(
            ok,
            True,
            "无禁用字符。" if ok else f"包含禁用字符：{' '.join(hits)}",
            f"删除这些符号：{' '.join(hits)}。",
            hits,
        )

    if kind == "no_emoji":
        title = _title_of(artifact)
        hits = text_rules.find_emojis(title)
        ok = not hits
        return result(
            ok,
            True,
            "标题无表情符号。" if ok else f"标题包含 {len(hits)} 个表情符号：{' '.join(hits)}",
            "从商品标题中删除全部表情符号；表情属于社交文案，不属于商品标题。",
            hits,
        )

    if kind == "no_hashtags":
        title = _title_of(artifact)
        hits = text_rules.find_hashtags(title)
        ok = not hits
        return result(
            ok,
            True,
            "标题无话题标签。" if ok else f"标题包含话题标签：{' '.join(hits)}",
            f"把 {' '.join(hits)} 移到单独的「社交文案」字段，商品标题里不要出现 # 标签。",
            hits,
        )

    if kind == "promotional_language":
        title = _title_of(artifact)
        hits = text_rules.find_promotional(
            title,
            openers=params.get("openers"),
            phrases=params.get("phrases"),
        )
        ok = not hits
        openers = [h["phrase"] for h in hits if h["kind"] == "opening"]
        phrases = [h["phrase"] for h in hits if h["kind"] == "phrase"]
        bits = []
        if openers:
            bits.append(f"标题以促销/标题党开头：{'、'.join(openers)}")
        if phrases:
            bits.append(f"含营销用语：{'、'.join(phrases)}")
        return result(
            ok,
            True,
            "标题无促销/主观营销用语。" if ok else "；".join(bits),
            "删掉这些促销/主观表述，改成对商品本身的客观描述（品牌 + 品类 + 关键属性 + 规格）。",
            openers + phrases,
        )

    if kind == "title_structure":
        title = _title_of(artifact)
        problems: list[str] = []
        evidence: list[str] = []

        emojis = text_rules.find_emojis(title)
        hashtags = text_rules.find_hashtags(title)
        promos = [h["phrase"] for h in text_rules.find_promotional(title)]
        sizes = text_rules.find_size_tokens(title)

        lead = text_rules.collapse_whitespace(
            text_rules.strip_hashtags(text_rules.strip_emojis(title))
        )
        # The title must LEAD with product information, not with a hook.
        if promos:
            problems.append("开头是促销/主观表述，不是品牌或品类")
            evidence.extend(promos)
        if emojis or hashtags:
            problems.append("标题混入了表情或话题标签")
            evidence.extend(emojis + hashtags)
        if params.get("require_size", True) and not sizes:
            problems.append("缺少规格/容量等事实属性")
        if not lead:
            problems.append("去掉装饰后没有可用的商品信息")

        ok = not problems
        return result(
            ok,
            True,
            "标题结构合规：以品牌/品类开头，含事实属性与规格。"
            if ok
            else "；".join(problems),
            "标题按「品牌/品类 + 关键事实属性 + 规格/容量」组织，例如"
            "「AeroFold Collapsible Silicone Travel Cup, Leak-Proof Lid, Folds to 4.5cm, 350ml」。",
            evidence,
        )

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
            f"把重复的 {', '.join(over)} 精简到最多 {limit} 次。",
            over,
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
