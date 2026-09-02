"""Versioned policy packs: parsing / validation, deterministic diff, executable rules."""

from __future__ import annotations

import pytest

import policy
from policy.packs import PolicyError, parse_snapshot


# --------------------------------------------------------------------------- #
# 1. snapshot parsing + validation                                             #
# --------------------------------------------------------------------------- #

_GOOD = {
    "platform": "amazon",
    "version": "test-1",
    "status": "current",
    "effective_date": "2025-01-01",
    "excerpt_date": "2025-06-01",
    "source_name": "src",
    "source_url": "https://example.test/policy",
    "rules": [
        {"id": "a.title.max", "kind": "title_max_length", "field": "amazon:title",
         "severity": "warn", "params": {"max": 200}, "description": "d"},
    ],
}


def test_bundled_snapshots_load_and_validate():
    reg = policy.load_snapshots()
    assert {s.platform for s in reg.values()} == {"amazon", "tiktok", "shopify"}
    # exactly one current per platform, plus the amazon candidate
    currents = [s for s in reg.values() if s.status == "current"]
    assert len(currents) == 3
    assert any(s.status == "candidate" and s.platform == "amazon" for s in reg.values())
    for snap in reg.values():
        assert snap.rules
        assert snap.effective_date.count("-") == 2 and snap.excerpt_date.count("-") == 2
        assert snap.source_url.startswith("http")


def test_parse_rejects_unknown_kind():
    bad = {**_GOOD, "rules": [{"id": "x", "kind": "made_up", "params": {}}]}
    with pytest.raises(PolicyError):
        parse_snapshot(bad, where="unit")


def test_parse_rejects_missing_required_param():
    bad = {**_GOOD, "rules": [{"id": "x", "kind": "title_max_length", "params": {}}]}
    with pytest.raises(PolicyError):
        parse_snapshot(bad, where="unit")


def test_parse_rejects_bad_status_and_date():
    with pytest.raises(PolicyError):
        parse_snapshot({**_GOOD, "status": "live"}, where="unit")
    with pytest.raises(PolicyError):
        parse_snapshot({**_GOOD, "effective_date": "2025/01/01"}, where="unit")


def test_parse_rejects_duplicate_rule_ids():
    dup = {**_GOOD, "rules": [_GOOD["rules"][0], dict(_GOOD["rules"][0])]}
    with pytest.raises(PolicyError):
        parse_snapshot(dup, where="unit")


# --------------------------------------------------------------------------- #
# 2. deterministic policy diff                                                 #
# --------------------------------------------------------------------------- #


def test_amazon_current_to_candidate_diff_is_deterministic():
    base = policy.current_snapshot("amazon")
    cand = policy.candidate_snapshot("amazon")
    d1 = policy.diff_snapshots(base, cand).to_dict()
    d2 = policy.diff_snapshots(base, cand).to_dict()
    assert d1 == d2
    assert d1["is_empty"] is False
    assert [r["id"] for r in d1["added"]] == [
        "amazon.title.prohibited_chars",
        "amazon.title.repeated_word_limit",
    ]
    assert d1["removed"] == []
    assert len(d1["changed"]) == 1
    change = d1["changed"][0]
    assert change["rule_id"] == "amazon.title.max_length"
    assert change["old"]["params"]["max"] == 200 and change["old"]["severity"] == "warn"
    assert change["new"]["params"]["max"] == 80 and change["new"]["severity"] == "blocking"
    assert d1["affected_fields"] == ["amazon:title"]


def test_diff_of_snapshot_with_itself_is_empty():
    base = policy.current_snapshot("tiktok")
    d = policy.diff_snapshots(base, base)
    assert d.is_empty and d.added == () and d.removed == () and d.changed == ()


def test_diff_across_platforms_raises():
    with pytest.raises(ValueError):
        policy.diff_snapshots(policy.current_snapshot("amazon"), policy.current_snapshot("tiktok"))


# --------------------------------------------------------------------------- #
# 3 + 4. executable Amazon candidate rules                                     #
# --------------------------------------------------------------------------- #


def _amazon_rule(rule_id: str):
    return policy.candidate_snapshot("amazon").rule_map()[rule_id]


def test_amazon_prohibited_char_rule():
    rule = _amazon_rule("amazon.title.prohibited_chars")
    assert policy.evaluate_rule(rule, {"title": "Clean Travel Cup 300ml"}).ok is True
    bad = policy.evaluate_rule(rule, {"title": "Best Cup!! $10 {deal}"})
    assert bad.ok is False and bad.severity == "blocking"
    assert "!" in bad.detail and "$" in bad.detail


def test_amazon_repeated_word_rule():
    rule = _amazon_rule("amazon.title.repeated_word_limit")
    # "for" is exempt, so three "for" is fine; "cup" three times is not
    ok = policy.evaluate_rule(rule, {"title": "Cup for hiking for camping for office"})
    assert ok.ok is True
    bad = policy.evaluate_rule(rule, {"title": "Cup Cup Cup travel mug"})
    assert bad.ok is False and "cup" in bad.detail


def test_amazon_candidate_title_max_is_80_and_blocking():
    rule = _amazon_rule("amazon.title.max_length")
    assert rule.params["max"] == 80 and rule.severity == "blocking"
    assert policy.evaluate_rule(rule, {"title": "x" * 81}).ok is False
    assert policy.evaluate_rule(rule, {"title": "x" * 80}).ok is True


# --------------------------------------------------------------------------- #
# 5. current TikTok thresholds are correct (locked against drift)              #
# --------------------------------------------------------------------------- #


def test_current_tiktok_title_thresholds_are_25_to_200():
    snap = policy.current_snapshot("tiktok")
    rules = snap.rule_map()
    assert rules["tiktok.title.min_length"].params["min"] == 25
    assert rules["tiktok.title.max_length"].params["max"] == 200
    # and the checker's hard-coded band must not drift from the snapshot
    import checker

    out_ok = checker.apply_checks(
        {"id": "tiktok", "title": "t" * 25, "fields": []},
        product_name="C", points="x", asset_mode="compliant",
    )
    out_bad = checker.apply_checks(
        {"id": "tiktok", "title": "t" * 24, "fields": []},
        product_name="C", points="x", asset_mode="compliant",
    )
    states = lambda o: {c["id"]: c["state"] for c in o["checks"]}
    assert states(out_ok)["title"] == "pass"
    assert states(out_bad)["title"] == "fix"


def test_legacy_rules_endpoint_shape_is_backward_compatible():
    payload = policy.build_legacy_rules()
    assert "excerpt_date" in payload and "platforms" in payload
    amazon = payload["platforms"]["amazon"]
    for key in ("platform_id", "rule_id", "name", "role", "image", "rule", "source", "source_url", "excerpt_date"):
        assert key in amazon, key
    assert amazon["source_url"].startswith("https://") and "amazon.com/" in amazon["source_url"]
    assert payload["platforms"]["tiktok"]["title_min"] == 25
