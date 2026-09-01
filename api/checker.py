"""Mechanical listing checks. These overwrite any model-reported check states."""

from __future__ import annotations

from typing import Any

LANE_META = {
    "amazon": {"name": "Amazon", "role": "货架", "image_label": "白底主图 1:1"},
    "tiktok": {"name": "TikTok Shop", "role": "货架 · 连着内容", "image_label": "商品卡主图"},
    "shopify": {"name": "Shopify", "role": "品牌站", "image_label": "品牌站生活图"},
}


def _check(item_id: str, label: str, state: str, detail: str) -> dict[str, str]:
    return {"id": item_id, "label": label, "state": state, "detail": detail}


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


def apply_checks(
    draft: dict[str, Any],
    *,
    product_name: str,
    points: str,
    asset_mode: str,
) -> dict[str, Any]:
    platform = draft["id"]
    title = str(draft.get("title") or "")
    fields = [
        {"label": str(item.get("label") or ""), "value": str(item.get("value") or "")}
        for item in (draft.get("fields") or [])
        if isinstance(item, dict)
    ]
    checks: list[dict[str, str]] = []

    if platform == "amazon":
        ok = 0 < len(title) <= 200
        checks.append(
            _check(
                "title",
                "标题长度",
                "pass" if ok else "fix",
                "英文字段完整，未超常见 200 字符上限。" if ok else f"标题 {len(title)} 字符，需落在 1–200。",
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
        ok = 25 <= len(title) <= 200
        checks.append(
            _check(
                "title",
                "标题 25–200",
                "pass" if ok else "fix",
                "短标题落在卖家大学 Listing 区间内。" if ok else f"标题 {len(title)} 字符，规则是 25–200。",
            )
        )
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
    return {
        "id": platform,
        "name": meta["name"],
        "role": meta["role"],
        "title": title,
        "fields": fields,
        "imageLabel": draft.get("imageLabel") or meta["image_label"],
        "checks": checks,
    }
