"""Mechanical listing checks. These overwrite any model-reported check states.

Also stamps each draft with the dependency metadata the migration / blast-radius
layer needs: stable SKU fact IDs, per-field ``factRefs``, the SKU revision hash,
and the policy version the draft was compiled against.
"""

from __future__ import annotations

from typing import Any

import skufacts
import tiktok_title

try:  # policy pack is optional at import time (keeps checker importable in isolation)
    import policy as _policy
except Exception:  # pragma: no cover - defensive
    _policy = None

LANE_META = {
    "amazon": {"name": "Amazon", "role": "货架", "image_label": "白底主图 1:1"},
    "tiktok": {"name": "TikTok Shop", "role": "货架 · 连着内容", "image_label": "商品卡主图"},
    "shopify": {"name": "Shopify", "role": "品牌站", "image_label": "品牌站生活图"},
}

_FIELD_SLUGS = {
    "五点 1": "bullet-1",
    "五点 2": "bullet-2",
    "五点 3": "bullet-3",
    "五点 4": "bullet-4",
    "五点 5": "bullet-5",
    "搜索词": "search-terms",
    "详情规划": "detail-plan",
    "描述": "description",
    "标题长度": "title-length",
    "商品视频位": "video-slot",
    "长描述": "long-description",
    "媒体": "media",
}


def _field_slug(label: str, index: int) -> str:
    return _FIELD_SLUGS.get(label.strip(), f"field-{index + 1}")


def _policy_version(platform: str) -> str:
    if _policy is None:
        return ""
    try:
        return _policy.current_snapshot(platform).version
    except Exception:  # pragma: no cover - defensive
        return ""


def _check(
    item_id: str,
    label: str,
    state: str,
    detail: str,
    *,
    suggestion: str = "",
    blocking: bool = False,
    evidence: "list[str] | tuple[str, ...]" = (),
) -> dict[str, Any]:
    """One mechanical check result.

    ``blocking`` marks a violation that must not be silently carried forward:
    the draft is stamped ``needs_human_review`` and cannot be auto-applied.
    """
    out: dict[str, Any] = {"id": item_id, "label": label, "state": state, "detail": detail}
    if suggestion:
        out["suggestion"] = suggestion
    if blocking:
        out["blocking"] = True
    if evidence:
        out["evidence"] = list(evidence)
    return out


def _has_bpa_claim(product_name: str, points: str, title: str) -> bool:
    blob = f"{product_name}\n{points}\n{title}".lower()
    return "bpa-free" in blob or "bpa free" in blob or "不含bpa" in blob


def image_check(platform: str, asset_mode: str) -> dict[str, str]:
    if platform == "shopify":
        return _check(
            "img",
            "品牌站用图",
            "pass",
            "Shopify 不强制白底。这张带字竖版可当生活/活动图，不能回填两台货架主图。"
            if asset_mode == "promo"
            else "生活图可用。无强制白底。",
        )
    if asset_mode == "promo":
        if platform == "amazon":
            return _check(
                "img",
                "主图纯白无加字",
                "fix",
                "带字竖版、非纯白底。Amazon 主图不能贴。请改用白底无字图，或把这张只去投放。",
            )
        return _check(
            "img",
            "商品卡主图无加字",
            "fix",
            "TikTok Shop 商品卡主图不能加字。信息流广告封面是另一套，走投放条。",
        )
    if platform == "amazon":
        return _check(
            "img",
            "主图纯白无加字",
            "pass",
            "纯白底、无加字、主体足够。机械检查通过，不等于平台终审。",
        )
    return _check(
        "img",
        "商品卡主图无加字",
        "pass",
        "商品卡主图无加字。注意：这不是投放封面。",
    )


#: Rule ids whose failures are reported as individual, actionable UI rows.
_TIKTOK_TITLE_RULE_LABELS = {
    "tiktok.title.min_length": "标题长度下限",
    "tiktok.title.max_length": "标题长度上限",
    "tiktok.title.no_hashtags": "标题禁话题标签",
    "tiktok.title.prohibited_chars": "标题禁特殊字符",
    "tiktok.title.no_promotional_language": "标题禁营销用语",
    "tiktok.title.no_emoji": "标题禁表情符号",
    "tiktok.title.structure": "标题结构",
}


def _tiktok_title_checks(title: str) -> list[dict[str, Any]]:
    """Run the TikTok title rules from the current policy snapshot.

    Each failure becomes its own check row carrying the explanation, the
    offending substrings, and a deterministic suggested correction, so the UI
    can show the operator exactly what to fix. Blocking failures are marked so
    the listing cannot be carried forward silently.
    """
    if _policy is None:  # pragma: no cover - defensive
        return []
    try:
        snapshot = _policy.current_snapshot("tiktok")
        results = [
            r
            for r in _policy.evaluate_snapshot(snapshot, {"title": title})
            if r.checkable and r.rule_id.startswith("tiktok.title.")
        ]
    except Exception:  # pragma: no cover - defensive fallback
        return []

    failures = [r for r in results if not r.ok]
    if not failures:
        return [
            _check(
                "title",
                "标题规则",
                "pass",
                "长度合规，无表情、话题标签、特殊字符或营销用语，结构为品类 + 属性 + 规格。",
            )
        ]

    suggested = tiktok_title.suggest_title(title)
    rows: list[dict[str, Any]] = []
    for result in failures:
        rows.append(
            _check(
                result.rule_id.rsplit(".", 1)[-1] if result.rule_id != "tiktok.title" else "title",
                _TIKTOK_TITLE_RULE_LABELS.get(result.rule_id, result.rule_id),
                "fix",
                result.detail,
                suggestion=(
                    f"{result.suggestion} 建议标题：{suggested}"
                    if suggested and suggested != title
                    else result.suggestion
                ),
                blocking=result.severity == "blocking",
                evidence=result.evidence,
            )
        )
    return rows


def tiktok_social_caption_field(title: str) -> "dict[str, Any] | None":
    """The optional social-caption field carrying hashtags lifted out of *title*.

    Returns ``None`` when the title has no hashtags — the field is optional and
    no copy is invented.
    """
    caption = tiktok_title.social_caption(title)
    if not caption:
        return None
    return {
        "label": tiktok_title.SOCIAL_CAPTION_LABEL,
        "value": caption,
        "field": "social-caption",
        "factRefs": [],
    }


def apply_checks(
    draft: dict[str, Any],
    *,
    product_name: str,
    points: str,
    asset_mode: str,
) -> dict[str, Any]:
    platform = draft["id"]
    title = str(draft.get("title") or "")
    facts = skufacts.parse_sku_facts(product_name, points)
    fact_ids = list(facts.keys())

    def _refs(text: str) -> list[str]:
        supplied = draft.get("factRefs") if text == title else None
        if isinstance(supplied, list):
            return skufacts.validate_fact_refs(supplied, facts)
        return skufacts.compute_fact_refs(text, facts)

    fields = []
    for i, item in enumerate(draft.get("fields") or []):
        if not isinstance(item, dict):
            continue
        label = str(item.get("label") or "")
        value = str(item.get("value") or "")
        supplied_refs = item.get("factRefs")
        refs = (
            skufacts.validate_fact_refs(supplied_refs, facts)
            if isinstance(supplied_refs, list)
            else skufacts.compute_fact_refs(f"{label} {value}", facts)
        )
        fields.append(
            {
                "label": label,
                "value": value,
                "field": _field_slug(label, i),
                "factRefs": refs,
            }
        )
    checks: list[dict[str, str]] = []

    if platform == "amazon":
        rule_failures = []
        if _policy is not None:
            try:
                results = _policy.evaluate_snapshot(
                    _policy.current_snapshot("amazon"), {"title": title}
                )
                rule_failures = [
                    result for result in _policy.blocking_failures(results)
                    if result.rule_id.startswith("amazon.title.")
                ]
            except Exception:  # pragma: no cover - defensive fallback
                rule_failures = []
        ok = bool(title) and not rule_failures and len(title) <= 200
        failed_details = "；".join(result.detail for result in rule_failures)
        checks.append(
            _check(
                "title",
                "标题规则",
                "pass" if ok else "fix",
                (
                    "不超过 200 字符，未发现禁用字符或超限重复词。"
                    if ok
                    else failed_details or f"标题 {len(title)} 字符，需落在 1–200。"
                ),
            )
        )
        bullets = [f for f in fields if str(f.get("label", "")).startswith("五点")]
        checks.append(
            _check(
                "bullets",
                "五点齐全",
                "pass" if len(bullets) >= 5 else "fix",
                "五条独立卖点，未塞促销标语。" if len(bullets) >= 5 else f"只收到 {len(bullets)} 条五点。",
            )
        )
    elif platform == "tiktok":
        checks.extend(_tiktok_title_checks(title))
        # Hashtags belong in an optional social caption, never in the product
        # title. Lift them into their own field if the model left them inline
        # and the draft does not already carry one.
        if not any(f["field"] == "social-caption" for f in fields):
            caption = tiktok_social_caption_field(title)
            if caption:
                fields.append(caption)
    else:
        desc = next((str(f.get("value") or "") for f in fields if "描述" in str(f.get("label") or "")), "")
        ok = bool(title.strip()) and len(desc) >= 40
        checks.append(
            _check(
                "copy",
                "品牌标题与长描述",
                "pass" if ok else "fix",
                "站点语气，不是五点模板。" if ok else "品牌标题或长描述偏短。",
            )
        )

    checks.append(image_check(platform, asset_mode))

    if platform != "shopify" and _has_bpa_claim(product_name, points, title):
        checks.append(
            _check(
                "bpa",
                "BPA-Free 宣称",
                "fix",
                "卖点写了 BPA-Free，工位未见证书。标出来，不替平台删，也不担保过审。",
            )
        )

    meta = LANE_META[platform]
    title_refs = _refs(title) or (["name"] if "name" in facts else [])
    blocking = [c for c in checks if c.get("blocking")]
    return {
        "id": platform,
        "name": meta["name"],
        "role": meta["role"],
        "title": title,
        "titleFactRefs": title_refs,
        "fields": fields,
        "imageLabel": draft.get("imageLabel") or meta["image_label"],
        "checks": checks,
        "artifactKind": "listing",
        "policyVersion": _policy_version(platform),
        "factIds": fact_ids,
        "skuRevision": skufacts.sku_revision_hash(facts),
        # A draft with blocking violations must never be carried forward
        # silently; it is held for human review.
        "hasBlockingViolations": bool(blocking),
        "blockingRuleIds": [c["id"] for c in blocking],
        "status": "needs_human_review" if blocking else "current",
        "suggestedTitle": (
            tiktok_title.suggest_title(title) if platform == "tiktok" and blocking else ""
        ),
    }
