"""Blast-radius analysis, shadow compilation, minimal apply, rollback, report."""

from __future__ import annotations

import copy

import migration
import skufacts
from tests.helpers import (
    NAME,
    POINTS_300,
    POINTS_350,
    demo_artifacts,
    demo_facts,
    legacy_artifact,
)

AMAZON_BASE = "amazon-us-pre-2025.01.21"
AMAZON_CAND = "amazon-us-2025.01.21"


# --------------------------------------------------------------------------- #
# 6. an Amazon-only policy change marks Amazon only                            #
# --------------------------------------------------------------------------- #


def test_amazon_policy_change_affects_amazon_only():
    arts = demo_artifacts(legacy_policy_violation=True)
    facts = demo_facts()
    impact = migration.analyze_impact(
        arts,
        facts_before=facts,
        facts_after=facts,
        base_policy_version=AMAZON_BASE,
        candidate_policy_version=AMAZON_CAND,
    )
    affected = {r["artifact_id"] for r in impact["affected"]}
    unaffected = {r["artifact_id"] for r in impact["unaffected"]}
    assert affected == {"amazon"}
    assert unaffected == {"tiktok", "shopify"}
    reason_types = {rr["type"] for r in impact["affected"] for rr in r["reasons"]}
    assert reason_types == {"policy"}
    amazon = impact["affected"][0]
    assert amazon["cause"] == "policy"
    assert amazon["fields_to_regenerate"] == ["title"]  # legacy title has ! and Cup x3


def test_policy_change_with_no_fact_change_leaves_media_untouched():
    arts = demo_artifacts(legacy_policy_violation=True)
    arts.append(
        {"artifact_id": "amz-img", "platform": "amazon", "kind": "image",
         "revision": 1, "status": "current", "asset_refs": ["name"]}
    )
    facts = demo_facts()
    impact = migration.analyze_impact(
        arts, facts_before=facts, facts_after=facts,
        base_policy_version=AMAZON_BASE, candidate_policy_version=AMAZON_CAND,
    )
    assert "amz-img" in {r["artifact_id"] for r in impact["unaffected"]}


# --------------------------------------------------------------------------- #
# 7. a SKU fact change produces the correct impact set                         #
# --------------------------------------------------------------------------- #


def test_capacity_change_marks_only_capacity_dependent_fields():
    arts = demo_artifacts(POINTS_350)
    fb = demo_facts(POINTS_350)
    fa = demo_facts(POINTS_300)
    impact = migration.analyze_impact(arts, facts_before=fb, facts_after=fa)

    assert impact["fact_delta"]["changed"] == ["fact-3"]
    affected = {r["artifact_id"]: r for r in impact["affected"]}
    assert set(affected) == {"amazon", "tiktok", "shopify"}
    # amazon: title + the "350ml / 12oz" bullet + search terms reference capacity
    assert "title" in affected["amazon"]["fields_to_regenerate"]
    assert "bullet-4" in affected["amazon"]["fields_to_regenerate"]
    # the temperature bullet does NOT reference capacity -> reusable
    assert "bullet-2" in affected["amazon"]["reusable_fields"]
    assert "bullet-2" not in affected["amazon"]["fields_to_regenerate"]
    for row in impact["affected"]:
        assert row["cause"] == "sku"


def test_unrelated_fact_change_marks_nothing():
    arts = demo_artifacts(POINTS_350)
    fb = demo_facts(POINTS_350)
    fa = demo_facts(POINTS_350.replace("适合徒步、办公、出差", "适合露营、通勤"))
    impact = migration.analyze_impact(arts, facts_before=fb, facts_after=fa)
    assert impact["fact_delta"]["changed"] == ["fact-5"]
    assert impact["summary"]["affected_count"] == 0


# --------------------------------------------------------------------------- #
# 8. conservative fallback for legacy artifacts (no dependency metadata)       #
# --------------------------------------------------------------------------- #


def test_legacy_artifact_without_metadata_uses_conservative_fallback():
    legacy = legacy_artifact()
    fb = demo_facts(POINTS_350)
    fa = demo_facts(POINTS_300)
    impact = migration.analyze_impact([legacy], facts_before=fb, facts_after=fa)
    assert impact["summary"]["affected_count"] == 1
    row = impact["affected"][0]
    assert row["has_dependency_metadata"] is False
    reason = row["reasons"][0]
    assert reason["type"] == "sku_fact_conservative"
    assert "保守" in reason["detail"]
    # with metadata present, the same artifact would NOT be flagged conservatively
    with_meta = {**legacy, "title_fact_refs": [], "fields": [
        {"name": "bullet-1", "label": "五点 1", "value": "folds to 4cm", "fact_refs": ["fact-1"]}
    ]}
    impact2 = migration.analyze_impact([with_meta], facts_before=fb, facts_after=fa)
    # fact-1 (4cm) unchanged between the two point sets -> not affected
    assert impact2["summary"]["affected_count"] == 0


# --------------------------------------------------------------------------- #
# candidate patches (shadow compilation) — current artifact never mutated      #
# --------------------------------------------------------------------------- #


def test_candidate_patches_do_not_touch_the_input_artifacts():
    arts = demo_artifacts(POINTS_350)
    snapshot = copy.deepcopy(arts)
    fb, fa = demo_facts(POINTS_350), demo_facts(POINTS_300)
    impact = migration.analyze_impact(arts, facts_before=fb, facts_after=fa)
    out = migration.build_candidate_patches(arts, impact, facts_before=fb, facts_after=fa)
    assert arts == snapshot  # inputs untouched
    titles = {p["artifact_id"]: p for p in out["patches"] if p["field"] == "title"}
    assert titles["amazon"]["previous_value"] != titles["amazon"]["candidate_value"]
    assert "300ml" in titles["amazon"]["candidate_value"]
    # the 350ml/12oz bullet cannot be safely auto-patched -> human review
    hr = {(h["artifact_id"], h["field"]) for h in out["human_review"]}
    assert ("amazon", "bullet-4") in hr


def test_candidate_patches_reject_targets_outside_impact_set():
    arts = demo_artifacts(POINTS_350)
    fb, fa = demo_facts(POINTS_350), demo_facts(POINTS_300)
    impact = migration.analyze_impact(arts, facts_before=fb, facts_after=fa)
    try:
        migration.build_candidate_patches(
            arts, impact, facts_before=fb, facts_after=fa,
            targets=[("shopify", "media")],  # 'media' never references capacity
        )
    except ValueError as exc:
        assert "影响集" in str(exc)
    else:
        raise AssertionError("expected ValueError for an unrelated target")


def test_policy_title_patch_is_trimmed_and_passes_candidate_validation():
    arts = demo_artifacts(legacy_policy_violation=True)
    facts = demo_facts()
    impact = migration.analyze_impact(
        arts, facts_before=facts, facts_after=facts,
        base_policy_version=AMAZON_BASE, candidate_policy_version=AMAZON_CAND,
    )
    out = migration.build_candidate_patches(
        arts, impact, facts_before=facts, facts_after=facts,
        base_policy_version=AMAZON_BASE, candidate_policy_version=AMAZON_CAND,
    )
    patch = next(p for p in out["patches"] if p["artifact_id"] == "amazon")
    assert "!" not in patch["candidate_value"]
    assert patch["candidate_value"].lower().count("cup") <= 2
    assert patch["validation"]["ok"] is True
    assert patch["triggering"]["kind"] == "policy"


# --------------------------------------------------------------------------- #
# 10. apply preserves every untouched field byte-for-byte                      #
# --------------------------------------------------------------------------- #


def test_apply_only_changes_approved_fields():
    arts = demo_artifacts(POINTS_350)
    fb, fa = demo_facts(POINTS_350), demo_facts(POINTS_300)
    impact = migration.analyze_impact(arts, facts_before=fb, facts_after=fa)
    out = migration.build_candidate_patches(arts, impact, facts_before=fb, facts_after=fa)

    approved = [
        p for p in out["patches"]
        if p["artifact_id"] == "amazon" and p["field"] == "title" and not p["needs_human_review"]
    ]
    assert approved, "expected an auto-approvable amazon title patch"

    before_amazon = copy.deepcopy(next(a for a in arts if a["artifact_id"] == "amazon"))
    before_tiktok = copy.deepcopy(next(a for a in arts if a["artifact_id"] == "tiktok"))
    res = migration.apply_patches(arts, approved, facts_after=fa)

    after = {a["artifact_id"]: a for a in res["artifacts"]}
    # tiktok untouched entirely
    assert after["tiktok"] == before_tiktok
    # amazon: only the title changed; bullets identical; revision bumped
    assert after["amazon"]["title"] == approved[0]["candidate_value"]
    assert after["amazon"]["revision"] == before_amazon["revision"] + 1
    for i, field in enumerate(after["amazon"]["fields"]):
        assert field["value"] == before_amazon["fields"][i]["value"]
    assert after["amazon"]["status"] == "applied"
    assert res["applied_artifact_ids"] == ["amazon"]


def test_apply_marks_needs_human_review_when_an_approved_patch_is_unresolved():
    arts = demo_artifacts(POINTS_350)
    fb, fa = demo_facts(POINTS_350), demo_facts(POINTS_300)
    impact = migration.analyze_impact(arts, facts_before=fb, facts_after=fa)
    out = migration.build_candidate_patches(arts, impact, facts_before=fb, facts_after=fa)
    bullet = next(
        p for p in out["patches"]
        if p["artifact_id"] == "amazon" and p["field"] == "bullet-4"
    )
    res = migration.apply_patches(arts, [bullet], facts_after=fa)
    assert "amazon" in res["needs_human_review_ids"]
    assert next(a for a in res["artifacts"] if a["artifact_id"] == "amazon")["status"] == "needs_human_review"


# --------------------------------------------------------------------------- #
# 11. rollback restores the exact previous revision                            #
# --------------------------------------------------------------------------- #


def test_rollback_restores_exact_previous_state():
    arts = demo_artifacts(POINTS_350)
    fb, fa = demo_facts(POINTS_350), demo_facts(POINTS_300)
    snap = migration.snapshot_state(arts, label="pre")

    impact = migration.analyze_impact(arts, facts_before=fb, facts_after=fa)
    out = migration.build_candidate_patches(arts, impact, facts_before=fb, facts_after=fa)
    approved = [p for p in out["patches"] if not p["needs_human_review"]]
    applied = migration.apply_patches(arts, approved, facts_after=fa)
    assert applied["applied_artifact_ids"]  # something changed

    restored = migration.rollback(snap)
    assert restored["artifacts"] == arts
    assert restored["restored_from"] == snap["snapshot_id"]
    # titles are back to the 350ml originals
    for a in restored["artifacts"]:
        assert "300ml" not in a["title"]


def test_rollback_rejects_a_malformed_snapshot():
    for bad in ({}, {"artifacts": "nope"}, "x"):
        try:
            migration.rollback(bad)
        except ValueError:
            pass
        else:
            raise AssertionError(f"expected ValueError for {bad!r}")


# --------------------------------------------------------------------------- #
# migration report                                                             #
# --------------------------------------------------------------------------- #


def test_build_report_serialises_the_full_migration():
    arts = demo_artifacts(legacy_policy_violation=True)
    facts = demo_facts()
    impact = migration.analyze_impact(
        arts, facts_before=facts, facts_after=facts,
        base_policy_version=AMAZON_BASE, candidate_policy_version=AMAZON_CAND,
    )
    cand = migration.build_candidate_patches(
        arts, impact, facts_before=facts, facts_after=facts,
        base_policy_version=AMAZON_BASE, candidate_policy_version=AMAZON_CAND,
    )
    approved = [p for p in cand["patches"] if not p["needs_human_review"]]
    applied = migration.apply_patches(arts, approved, candidate_policy_version=AMAZON_CAND)
    report = migration.build_report(
        impact=impact, candidate=cand, apply_result=applied, status="applied",
        base_policy_version=AMAZON_BASE, candidate_policy_version=AMAZON_CAND,
    )
    import json

    json.dumps(report)  # must be JSON-serialisable
    assert report["status"] == "applied"
    assert report["policy"]["base_version"] == AMAZON_BASE
    assert report["policy"]["candidate_version"] == AMAZON_CAND
    assert report["policy"]["source_url"].startswith("https://")
    assert report["rule_diff"]["affected_fields"] == ["amazon:title"]
    assert report["impact"]["affected_count"] == 1
    assert report["impact"]["unaffected_count"] == 2
    assert report["counts"]["patched"] >= 1
    assert report["counts"]["preserved"] >= 1
    html = migration.render_report_html(report)
    assert "<table" in html and AMAZON_CAND in html
