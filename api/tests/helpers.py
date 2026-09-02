"""Shared builders for the migration / policy tests (not collected by pytest)."""

from __future__ import annotations

from typing import Any

import skufacts
from drafts import fallback_drafts

POINTS_350 = (
    "折叠到 4cm，口袋能装\n"
    "食品级硅胶，-40°C 到 200°C\n"
    "防漏盖，350ml\n"
    "BPA-Free\n"
    "适合徒步、办公、出差"
)
POINTS_300 = POINTS_350.replace("350ml", "300ml")
NAME = "折叠硅胶水杯 350ml"


def draft_to_artifact(draft: dict[str, Any]) -> dict[str, Any]:
    return {
        "artifact_id": draft["id"],
        "platform": draft["id"],
        "kind": "listing",
        "revision": 1,
        "status": "current",
        "policy_version": draft["policyVersion"],
        "sku_revision": draft["skuRevision"],
        "title": draft["title"],
        "title_fact_refs": draft["titleFactRefs"],
        "fields": [
            {
                "name": f["field"],
                "label": f["label"],
                "value": f["value"],
                "fact_refs": f["factRefs"],
            }
            for f in draft["fields"]
        ],
    }


def demo_artifacts(points: str = POINTS_350, name: str = NAME) -> list[dict[str, Any]]:
    drafts = fallback_drafts(name, points, "compliant", ["amazon", "tiktok", "shopify"])
    return [draft_to_artifact(d) for d in drafts]


def demo_facts(points: str = POINTS_350, name: str = NAME) -> dict[str, str]:
    return skufacts.parse_sku_facts(name, points)


def legacy_artifact(artifact_id: str = "legacy-amazon", platform: str = "amazon") -> dict[str, Any]:
    """An old artifact with NO dependency metadata (no fact_refs anywhere)."""
    return {
        "artifact_id": artifact_id,
        "platform": platform,
        "kind": "listing",
        "revision": 1,
        "status": "current",
        "title": "Old Collapsible Cup 350ml",
        "fields": [{"name": "bullet-1", "label": "五点 1", "value": "folds to 4cm"}],
    }
