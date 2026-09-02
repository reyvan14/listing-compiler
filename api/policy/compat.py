"""Build the legacy ``GET /api/rules`` payload from the current policy snapshots.

Keeps the exact response shape the frontend (``web/src/station/rulesApi.ts``)
already parses, so the endpoint stays backward compatible after the refactor to
versioned policy packs.
"""

from __future__ import annotations

from typing import Any

from .packs import PolicySnapshot, load_registry

_ORDER = ("amazon", "tiktok", "shopify")

# Preserve the rule_id values the pre-refactor rules.yaml exposed on /api/rules,
# so existing consumers (and E2E) keep matching.
_LEGACY_RULE_ID = {
    "amazon": "amazon.main-image",
    "tiktok": "tiktok.listing-basics",
    "shopify": "shopify.product-media",
}


def _title_bounds(snap: PolicySnapshot) -> dict[str, int]:
    out: dict[str, int] = {}
    for rule in snap.rules:
        if rule.kind == "title_max_length":
            out["title_max"] = int(rule.params["max"])
        elif rule.kind == "title_min_length":
            out["title_min"] = int(rule.params["min"])
    return out


def _platform_row(snap: PolicySnapshot) -> dict[str, Any]:
    display = dict(snap.display)
    primary_rule_id = _LEGACY_RULE_ID.get(
        snap.platform, snap.rules[0].id if snap.rules else f"{snap.platform}.rules"
    )
    row: dict[str, Any] = {
        "platform_id": snap.platform,
        "rule_id": primary_rule_id,
        "policy_version": snap.version,
        "name": display.get("name", snap.platform.title()),
        "role": display.get("role", ""),
        "image_label": display.get("image_label", ""),
        "image": display.get("image_summary", ""),
        "rule": snap.summary,
        "source": snap.source_name,
        "source_url": snap.source_url,
        "excerpt_date": snap.excerpt_date,
    }
    row.update(_title_bounds(snap))
    if snap.reference_name:
        row["reference"] = snap.reference_name
    if snap.reference_url:
        row["reference_url"] = snap.reference_url
    return row


def build_legacy_rules() -> dict[str, Any]:
    registry = load_registry()
    currents = {
        s.platform: s for s in registry.values() if s.status == "current"
    }
    excerpt = max((s.excerpt_date for s in currents.values()), default="")
    platforms: dict[str, Any] = {}
    for platform in _ORDER:
        snap = currents.get(platform)
        if snap:
            platforms[platform] = _platform_row(snap)
    # include any platform not in the fixed order, too
    for platform, snap in currents.items():
        if platform not in platforms:
            platforms[platform] = _platform_row(snap)
    return {"excerpt_date": excerpt, "platforms": platforms}
