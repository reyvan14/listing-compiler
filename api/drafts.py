"""Local fallback drafts, same shape as the station buildDrafts()."""

from __future__ import annotations

from typing import Any

from checker import apply_checks


def fallback_drafts(product_name: str, points: str, asset_mode: str, platforms: list[str]) -> list[dict[str, Any]]:
    raw = [
        {
            "id": "amazon",
            "title": (
                "Collapsible Silicone Travel Cup 350ml, Leak-Proof Lid, "
                "Heat-Resistant Pocket Cup for Hiking Camping Office"
            ),
            "fields": [
                {"label": "五点 1", "value": "Folds flat to 4cm — slips into a jacket pocket or carry-on side pouch."},
                {"label": "五点 2", "value": "Food-grade silicone body; dishwasher-safe; rated -40°C to 200°C."},
                {"label": "五点 3", "value": "Leak-proof lid with sip hole for commuting and trail breaks."},
                {"label": "五点 4", "value": "350ml / 12oz — one coffee or one refill of water."},
                {"label": "五点 5", "value": "Unexpand the ring stack after wash; air-dry with the lid off."},
                {
                    "label": "搜索词",
                    "value": "collapsible cup; silicone travel mug; hiking cup 350ml; pocket cup leak proof",
                },
                {
                    "label": "详情规划",
                    "value": "Hero 折叠演示 → 防漏测试 → 温度范围 → 尺寸对照 → 清洗 → 场景 → 规格表 → FAQ",
                },
            ],
        },
        {
            "id": "tiktok",
            "title": "350ml foldable silicone travel cup — leak-proof lid, pocket size for hike & commute",
            "fields": [
                {
                    "label": "描述",
                    "value": (
                        "Pack a real cup, not a disposable. Folds to 4cm, 350ml, leak-proof lid. "
                        "Food-grade silicone, -40°C to 200°C. Product card uses a clean main image; "
                        "the 15s clip lives on the ad strip."
                    ),
                },
                {"label": "标题长度", "value": "97 字符（规则 25–200）"},
                {"label": "商品视频位", "value": "1 条货架短视频位，待从投放条回填。不是信息流广告。"},
            ],
        },
        {
            "id": "shopify",
            "title": "Pocket Cup 350",
            "fields": [
                {
                    "label": "长描述",
                    "value": (
                        "A cup that disappears into a pocket. Pocket Cup 350 is a collapsible silicone vessel "
                        "for people who already carry too much. 350ml. Folds to 4cm. Lid that actually seals.\n\n"
                        "The shelf channels want a white card. This page can show the cup on a desk, in a bag, "
                        "at a trailhead."
                    ),
                },
                {
                    "label": "媒体",
                    "value": "生活图可用（无强制白底）。活动竖版可挂品牌站，不可回填 Amazon / TikTok Shop 主图。",
                },
            ],
        },
    ]
    return [
        apply_checks(item, product_name=product_name, points=points, asset_mode=asset_mode)
        for item in raw
        if item["id"] in platforms
    ]
