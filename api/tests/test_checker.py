"""Regression lock on checker.apply_checks (unchanged by this integration)."""

from __future__ import annotations

import checker


def amazon_draft(title, n_bullets):
    return {
        "id": "amazon",
        "title": title,
        "fields": [{"label": f"五点 {i + 1}", "value": f"point {i + 1}"} for i in range(n_bullets)],
    }


def states(result):
    return {c["id"]: c["state"] for c in result["checks"]}


def test_amazon_all_pass():
    out = checker.apply_checks(amazon_draft("A" * 120, 5), product_name="Cup", points="folds", asset_mode="compliant")
    s = states(out)
    assert s["title"] == "pass"
    assert s["bullets"] == "pass"
    assert s["img"] == "pass"
    assert out["name"] == "Amazon"


def test_amazon_fix_when_too_few_bullets():
    out = checker.apply_checks(amazon_draft("ok title", 2), product_name="Cup", points="x", asset_mode="compliant")
    assert states(out)["bullets"] == "fix"


def test_amazon_title_fix_when_over_200():
    out = checker.apply_checks(amazon_draft("A" * 201, 5), product_name="Cup", points="x", asset_mode="compliant")
    assert states(out)["title"] == "fix"


def test_tiktok_title_range():
    ok = checker.apply_checks({"id": "tiktok", "title": "t" * 40, "fields": []}, product_name="C", points="x", asset_mode="compliant")
    bad = checker.apply_checks({"id": "tiktok", "title": "short", "fields": []}, product_name="C", points="x", asset_mode="compliant")
    assert states(ok)["title"] == "pass"
    assert states(bad)["title"] == "fix"


def test_shopify_copy_needs_title_and_long_description():
    ok = checker.apply_checks(
        {"id": "shopify", "title": "Pocket Cup", "fields": [{"label": "长描述", "value": "y" * 60}]},
        product_name="C", points="x", asset_mode="compliant",
    )
    short = checker.apply_checks(
        {"id": "shopify", "title": "Pocket Cup", "fields": [{"label": "长描述", "value": "too short"}]},
        product_name="C", points="x", asset_mode="compliant",
    )
    assert states(ok)["copy"] == "pass"
    assert states(short)["copy"] == "fix"


def test_promo_mode_flags_shelf_images_but_not_shopify():
    amz = checker.apply_checks(amazon_draft("t", 5), product_name="C", points="x", asset_mode="promo")
    shop = checker.apply_checks(
        {"id": "shopify", "title": "Brand", "fields": [{"label": "长描述", "value": "y" * 60}]},
        product_name="C", points="x", asset_mode="promo",
    )
    assert states(amz)["img"] == "fix"
    assert states(shop)["img"] == "pass"


def test_bpa_claim_adds_fix_for_non_shopify_only():
    amz = checker.apply_checks(amazon_draft("t", 5), product_name="Cup BPA-Free", points="x", asset_mode="compliant")
    shop = checker.apply_checks(
        {"id": "shopify", "title": "Brand", "fields": [{"label": "长描述", "value": "y" * 60}]},
        product_name="Cup BPA-Free", points="x", asset_mode="compliant",
    )
    assert any(c["id"] == "bpa" and c["state"] == "fix" for c in amz["checks"])
    assert not any(c["id"] == "bpa" for c in shop["checks"])
