"""TikTok Shop title compliance — built around a real production failure.

The FAILED_TITLE below is the exact string a production API test generated and
that the old validator waved through: emoji, hashtags, a clickbait opening, and
social-caption phrasing instead of a product title.
"""

from __future__ import annotations

import checker
import policy
import tiktok_title
from policy import text_rules

# The actual generated title that passed validation but should not have.
FAILED_TITLE = (
    "Stop carrying bulky mugs! 🧘‍♀️✨ Meet the AeroFold Silicone Travel Cup. "
    "Folds to just 4.5cm! Fits anywhere. ☕🎒 "
    "#travelhacks #campinggear #ecofriendly #coffeehack"
)

CLEAN_TITLE = "AeroFold Collapsible Silicone Travel Cup, Leak-Proof Lid, Folds to 4.5cm, 350ml"


def _tiktok_results(title: str):
    return policy.evaluate_snapshot(policy.current_snapshot("tiktok"), {"title": title})


def _by_rule(title: str):
    return {r.rule_id: r for r in _tiktok_results(title)}


# --------------------------------------------------------------------------- #
# 1. emoji detection                                                           #
# --------------------------------------------------------------------------- #


def test_detects_every_emoji_in_the_failed_title():
    assert text_rules.find_emojis(FAILED_TITLE) == ["🧘‍♀️", "✨", "☕", "🎒"]


def test_emoji_rule_blocks_the_failed_title():
    result = _by_rule(FAILED_TITLE)["tiktok.title.no_emoji"]
    assert result.ok is False
    assert result.severity == "blocking"
    assert "表情符号" in result.detail
    assert result.suggestion
    assert "🧘‍♀️" in result.evidence


def test_emoji_rule_passes_a_clean_title():
    assert _by_rule(CLEAN_TITLE)["tiktok.title.no_emoji"].ok is True
    assert text_rules.find_emojis("Silicone Travel Cup 350ml") == []


def test_zwj_sequence_counted_once_not_per_codepoint():
    # 🧘 + ZWJ + ♀ + VS16 is ONE emoji, and ✨ after it is a separate one.
    assert text_rules.find_emojis("a 🧘‍♀️✨ b") == ["🧘‍♀️", "✨"]


# --------------------------------------------------------------------------- #
# 2. hashtag detection                                                         #
# --------------------------------------------------------------------------- #


def test_detects_every_hashtag_in_the_failed_title():
    assert text_rules.find_hashtags(FAILED_TITLE) == [
        "#travelhacks",
        "#campinggear",
        "#ecofriendly",
        "#coffeehack",
    ]


def test_hashtag_rule_blocks_the_failed_title():
    result = _by_rule(FAILED_TITLE)["tiktok.title.no_hashtags"]
    assert result.ok is False
    assert result.severity == "blocking"
    assert "社交文案" in result.suggestion
    assert "#travelhacks" in result.evidence


def test_hash_before_a_digit_is_not_a_hashtag():
    """'Size #2' is a prohibited symbol, not a hashtag — no double counting."""
    assert text_rules.find_hashtags("Travel Cup Size #2") == []


# --------------------------------------------------------------------------- #
# 3. clickbait / promotional openings                                          #
# --------------------------------------------------------------------------- #


def test_detects_the_clickbait_opening_of_the_failed_title():
    found = text_rules.find_promotional(FAILED_TITLE)
    assert {"kind": "opening", "phrase": "stop carrying"} in found


def test_promotional_rule_blocks_the_failed_title():
    result = _by_rule(FAILED_TITLE)["tiktok.title.no_promotional_language"]
    assert result.ok is False
    assert result.severity == "blocking"
    assert "stop carrying" in result.evidence


def test_flags_each_named_clickbait_opening():
    for opening in (
        "Stop carrying bulky mugs, Silicone Cup 350ml",
        "You won't believe this Silicone Cup 350ml",
        "Must-have Silicone Travel Cup 350ml",
        "Best ever Silicone Travel Cup 350ml",
    ):
        result = _by_rule(opening)["tiktok.title.no_promotional_language"]
        assert result.ok is False, opening


def test_promotional_phrases_are_caught_anywhere_in_the_title():
    result = _by_rule("Silicone Travel Cup 350ml, Best Seller, free shipping")
    assert result["tiktok.title.no_promotional_language"].ok is False


def test_a_factual_title_is_not_flagged_as_promotional():
    assert _by_rule(CLEAN_TITLE)["tiktok.title.no_promotional_language"].ok is True


# --------------------------------------------------------------------------- #
# 5. required title structure                                                  #
# --------------------------------------------------------------------------- #


def test_structure_rule_rejects_the_failed_title():
    result = _by_rule(FAILED_TITLE)["tiktok.title.structure"]
    assert result.ok is False
    assert "促销" in result.detail or "表情" in result.detail
    assert "品牌/品类" in result.suggestion


def test_structure_rule_accepts_brand_attributes_size():
    assert _by_rule(CLEAN_TITLE)["tiktok.title.structure"].ok is True


def test_structure_rule_wants_a_size_or_capacity_attribute():
    result = _by_rule("Collapsible Silicone Travel Cup With A Leak Proof Lid")
    assert result["tiktok.title.structure"].ok is False
    assert "规格" in result["tiktok.title.structure"].detail


# --------------------------------------------------------------------------- #
# 4. hashtags live in a separate optional social-caption field                 #
# --------------------------------------------------------------------------- #


def test_social_caption_carries_the_hashtags_out_of_the_title():
    split = tiktok_title.split_title(FAILED_TITLE)
    assert split["social_caption"] == (
        "#travelhacks #campinggear #ecofriendly #coffeehack"
    )
    assert "#" not in str(split["title"])


def test_social_caption_field_is_omitted_when_there_are_no_hashtags():
    assert checker.tiktok_social_caption_field(CLEAN_TITLE) is None


def test_checker_lifts_hashtags_into_the_social_caption_field():
    out = checker.apply_checks(
        {"id": "tiktok", "title": FAILED_TITLE, "fields": []},
        product_name="AeroFold Silicone Travel Cup",
        points="折叠到 4.5cm\n350ml",
        asset_mode="compliant",
    )
    caption = next(f for f in out["fields"] if f["field"] == "social-caption")
    assert caption["label"] == "社交文案"
    assert caption["value"] == "#travelhacks #campinggear #ecofriendly #coffeehack"


# --------------------------------------------------------------------------- #
# suggested correction                                                         #
# --------------------------------------------------------------------------- #


def test_suggested_title_is_clean_and_leads_with_brand_and_product_type():
    suggested = tiktok_title.suggest_title(FAILED_TITLE)
    assert suggested.startswith("AeroFold Silicone Travel Cup")
    assert "4.5cm" in suggested  # the factual attribute survives
    assert text_rules.find_emojis(suggested) == []
    assert text_rules.find_hashtags(suggested) == []
    assert text_rules.find_promotional(suggested) == []


def test_the_suggested_correction_actually_passes_every_blocking_rule():
    suggested = tiktok_title.suggest_title(FAILED_TITLE)
    assert policy.blocking_failures(_tiktok_results(suggested)) == []


def test_suggest_title_leaves_an_already_clean_title_untouched():
    assert tiktok_title.suggest_title(CLEAN_TITLE) == CLEAN_TITLE


def test_suggest_title_never_discards_a_sentence_carrying_product_facts():
    # 'Meet the ...' is a lead-in, not a throwaway: the brand must survive.
    assert tiktok_title.suggest_title(
        "Meet the AeroFold Travel Cup. 350ml."
    ).startswith("AeroFold Travel Cup")


# --------------------------------------------------------------------------- #
# 6 + 8. the failed example is caught, and never carried forward silently      #
# --------------------------------------------------------------------------- #


def test_the_real_failed_title_raises_four_blocking_violations():
    failures = policy.blocking_failures(_tiktok_results(FAILED_TITLE))
    assert {f.rule_id for f in failures} == {
        "tiktok.title.no_emoji",
        "tiktok.title.no_hashtags",
        "tiktok.title.no_promotional_language",
        "tiktok.title.prohibited_chars",
    }


def test_checker_holds_the_failed_draft_for_human_review():
    out = checker.apply_checks(
        {"id": "tiktok", "title": FAILED_TITLE, "fields": []},
        product_name="AeroFold Silicone Travel Cup",
        points="折叠到 4.5cm\n350ml",
        asset_mode="compliant",
    )
    assert out["hasBlockingViolations"] is True
    assert out["status"] == "needs_human_review"
    assert set(out["blockingRuleIds"]) == {
        "no_emoji",
        "no_hashtags",
        "no_promotional_language",
        "prohibited_chars",
    }


def test_a_clean_tiktok_draft_is_not_held():
    out = checker.apply_checks(
        {"id": "tiktok", "title": CLEAN_TITLE, "fields": []},
        product_name="AeroFold", points="350ml", asset_mode="compliant",
    )
    assert out["hasBlockingViolations"] is False
    assert out["status"] == "current"
    assert out["suggestedTitle"] == ""


# --------------------------------------------------------------------------- #
# 7. every violation carries an explanation AND a suggested correction         #
# --------------------------------------------------------------------------- #


def test_every_violation_row_has_an_explanation_and_a_suggestion():
    out = checker.apply_checks(
        {"id": "tiktok", "title": FAILED_TITLE, "fields": []},
        product_name="AeroFold", points="350ml", asset_mode="compliant",
    )
    violations = [c for c in out["checks"] if c["state"] == "fix" and c["id"] != "img"]
    assert len(violations) >= 4
    for row in violations:
        assert row["detail"], row
        assert row["suggestion"], row
        assert row["label"], row
    assert out["suggestedTitle"].startswith("AeroFold Silicone Travel Cup")


# --------------------------------------------------------------------------- #
# 8 + 9. the migration apply gate holds it, and rollback still works           #
# --------------------------------------------------------------------------- #


def test_apply_will_not_mark_a_blocking_tiktok_title_as_applied():
    """A TikTok artifact whose title carries a blocking violation must come out
    of apply() as needs_human_review even when the migration is a SKU drift
    that has nothing to do with the title rules."""
    import migration

    artifacts = [
        {
            "artifact_id": "tiktok",
            "platform": "tiktok",
            "kind": "listing",
            "revision": 1,
            "status": "current",
            "title": CLEAN_TITLE,
            "title_fact_refs": ["fact-3"],
            "fields": [],
        }
    ]
    patch = {
        "artifact_id": "tiktok",
        "field": "title",
        "candidate_value": FAILED_TITLE,  # a caption-style title sneaking in
        "needs_human_review": False,
    }
    out = migration.apply_patches(artifacts, [patch])
    assert out["applied_artifact_ids"] == []
    assert out["needs_human_review_ids"] == ["tiktok"]
    assert out["artifacts"][0]["status"] == "needs_human_review"


def test_a_clean_tiktok_patch_still_applies_normally():
    import migration

    artifacts = [
        {
            "artifact_id": "tiktok",
            "platform": "tiktok",
            "kind": "listing",
            "revision": 1,
            "status": "current",
            "title": "Silicone Travel Cup, Leak-Proof Lid, 350ml",
            "title_fact_refs": ["fact-3"],
            "fields": [],
        }
    ]
    patch = {
        "artifact_id": "tiktok",
        "field": "title",
        "candidate_value": CLEAN_TITLE,
        "needs_human_review": False,
    }
    out = migration.apply_patches(artifacts, [patch])
    assert out["applied_artifact_ids"] == ["tiktok"]
    assert out["artifacts"][0]["title"] == CLEAN_TITLE


def test_rollback_still_restores_a_held_artifact_exactly():
    """The human-review gate must not break rollback (requirement 9)."""
    import migration

    artifacts = [
        {
            "artifact_id": "tiktok",
            "platform": "tiktok",
            "kind": "listing",
            "revision": 1,
            "status": "current",
            "title": CLEAN_TITLE,
            "title_fact_refs": [],
            "fields": [],
        }
    ]
    snapshot = migration.snapshot_state(artifacts, label="pre")
    held = migration.apply_patches(
        artifacts,
        [{
            "artifact_id": "tiktok",
            "field": "title",
            "candidate_value": FAILED_TITLE,
            "needs_human_review": True,
        }],
    )
    assert held["artifacts"][0]["status"] == "needs_human_review"

    restored = migration.rollback(snapshot)
    assert restored["artifacts"] == artifacts
    assert restored["artifacts"][0]["title"] == CLEAN_TITLE
    assert restored["artifacts"][0]["status"] == "current"
