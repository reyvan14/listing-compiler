"""Stored migration candidates: real analysis, two decisions, no placeholders.

The Agent action that builds a migration candidate used to return a note saying
it had built nothing. These tests pin the properties that make the real version
trustworthy: the analysis is the engine's own, the record carries enough to
audit it, applying is a separate confirmed decision, the approved revision
survives it, and a missing prerequisite produces a named blocker rather than an
empty candidate that looks like success.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import agent_actions as actions
import migration_candidates as candidates
import review
from app import app

client = TestClient(app)

SKU = "AERO-350"
# 212 characters: over the 2025.01.21 200-character cap, but still clean by the
# review checker's own rules, so it can genuinely be approved and then genuinely
# need migrating. That gap is the situation this whole workflow exists for.
LONG_TITLE = (
    "Collapsible Silicone Travel Cup 350ml Leakproof Lid Carry Loop Dishwasher Safe "
    "BPA Free Food Grade Foldable Camping Office Water Bottle Reusable Outdoor Hiking "
    "Gym Portable Drinkware Set Compact Design Easy Clean"
)


def bullets() -> list[dict[str, str]]:
    return [{"label": f"五点 {i}", "value": f"point {i}"} for i in range(1, 6)]


def approved(title: str = LONG_TITLE, platform: str = "amazon", sku_id: str = SKU) -> dict:
    revision = review.create_revision(
        sku_id=sku_id, platform=platform, content={"title": title, "fields": bullets()}
    )
    review.submit_for_validation(revision["revision_id"])
    try:
        review.approve(revision["revision_id"], operator="lottie")
    except review.ReviewError:
        # A blocker means the fixture copy is wrong, not that the test may skip
        # the approval it depends on.
        raise
    return review.get_revision(revision["revision_id"])


# --------------------------------------------------------------------------- #
# Blockers, not placeholders                                                   #
# --------------------------------------------------------------------------- #


def test_no_approved_revision_is_a_named_blocker_and_builds_nothing():
    record = candidates.build("amazon")
    assert record["state"] == "blocked"
    assert record["patches"] == []
    assert [b["code"] for b in record["blockers"]] == ["no_approved_revision"]


def test_a_platform_without_a_baseline_snapshot_says_so():
    approved(title="折叠硅胶水杯 350ml 便携旅行杯", platform="tiktok")
    record = candidates.build("tiktok")
    assert record["state"] == "blocked"
    assert "no_baseline_policy" in [b["code"] for b in record["blockers"]]


def test_an_unknown_platform_is_refused_rather_than_guessed():
    record = candidates.build("ebay")
    assert record["state"] == "blocked"
    assert [b["code"] for b in record["blockers"]] == ["unknown_platform"]


# --------------------------------------------------------------------------- #
# Building                                                                     #
# --------------------------------------------------------------------------- #


def test_a_built_candidate_carries_everything_needed_to_audit_it():
    revision = approved()
    record = candidates.build("amazon", source_action="build_migration_candidate")

    assert record["state"] == "built"
    assert record["candidate_id"].startswith("mig-")
    assert record["created_at"]
    assert record["source_action"] == "build_migration_candidate"
    # the rule change it is a response to
    assert record["base_policy_version"] == "amazon-us-pre-2025.01.21"
    assert record["candidate_policy_version"] == "amazon-us-2025.01.21"
    assert record["policy_diff"]["affected_fields"]
    # what it touches
    assert revision["revision_id"] in [p["artifact_id"] for p in record["patches"]]
    assert "title" in [p["field"] for p in record["patches"]]
    # and what a reader can pull up to check it
    refs = {(r["kind"], r["id"]) for r in record["evidence_refs"]}
    assert ("policy_snapshot", "amazon-us-2025.01.21") in refs
    assert ("revision", revision["revision_id"]) in refs


def test_the_patch_is_the_engines_own_output_not_a_restatement():
    approved()
    record = candidates.build("amazon")
    patch = next(p for p in record["patches"] if p["field"] == "title")
    # the real title_max_length rule trimmed it
    assert len(patch["candidate_value"]) < len(patch["previous_value"])
    assert patch["triggering"]["kind"] == "policy"
    assert patch["triggering"]["rule_ids"]


def test_requesting_an_unaffected_field_warns_instead_of_failing():
    approved()
    record = candidates.build("amazon", fields=["五点 1"])
    assert record["state"] == "built"
    assert record["patches"] == []
    assert any("不在本次规则变更的影响范围内" in w for w in record["warnings"])


def test_building_changes_no_listing_content():
    revision = approved()
    before = review.get_revision(revision["revision_id"])
    candidates.build("amazon")
    after = review.get_revision(revision["revision_id"])
    assert after["content"] == before["content"]
    assert after["state"] == review.APPROVED


def test_the_same_idempotency_key_replays_one_candidate():
    approved()
    first = candidates.build("amazon", idempotency_key="k1")
    second = candidates.build("amazon", idempotency_key="k1")
    assert second["replayed"] is True
    assert second["candidate_id"] == first["candidate_id"]
    assert len(candidates.listing()) == 1


# --------------------------------------------------------------------------- #
# Applying is a second decision                                                #
# --------------------------------------------------------------------------- #


def apply_args(record: dict) -> dict:
    patch_ids = [p["patch_id"] for p in record["patches"]]
    return {
        "patch_ids": patch_ids,
        "operator": "lottie",
        "reason": "规则变更后迁移标题",
        "confirm_token": candidates.confirmation_token(record["candidate_id"], patch_ids),
    }


def test_applying_without_the_confirmation_token_is_refused():
    approved()
    record = candidates.build("amazon")
    args = apply_args(record) | {"confirm_token": ""}
    with pytest.raises(candidates.CandidateError) as exc:
        candidates.apply(record["candidate_id"], **args)
    assert exc.value.code == "confirmation_mismatch"
    assert candidates.get(record["candidate_id"])["state"] == "built"


def test_a_token_for_one_patch_set_does_not_authorise_a_wider_apply():
    approved()
    approved(title=LONG_TITLE + " Variant Two", sku_id="AERO-500")
    record = candidates.build("amazon")
    all_ids = [p["patch_id"] for p in record["patches"]]
    assert len(all_ids) >= 2
    narrow = candidates.confirmation_token(record["candidate_id"], all_ids[:1])
    with pytest.raises(candidates.CandidateError) as exc:
        candidates.apply(
            record["candidate_id"],
            patch_ids=all_ids,
            operator="lottie",
            reason="全部应用",
            confirm_token=narrow,
        )
    assert exc.value.code == "confirmation_mismatch"


def test_applying_forks_a_draft_and_leaves_the_approved_revision_approved():
    revision = approved()
    record = candidates.build("amazon")
    applied = candidates.apply(record["candidate_id"], **apply_args(record))

    assert applied["state"] == "applied"
    entry = applied["applied"][0]
    assert entry["source_revision_id"] == revision["revision_id"]
    assert entry["forked"] is True
    assert entry["state"] == review.DRAFT

    source = review.get_revision(revision["revision_id"])
    assert source["state"] == review.APPROVED
    assert source["content"]["title"] == LONG_TITLE

    child = review.get_revision(entry["candidate_revision_id"])
    assert child["parent_revision_id"] == revision["revision_id"]
    assert child["content"]["title"] != LONG_TITLE
    # a migration draft has earned no verdict of its own
    assert child["validation_id"] == ""
    assert child["approval_id"] == ""


def test_applying_twice_is_refused_rather_than_stacking_drafts():
    approved()
    record = candidates.build("amazon")
    candidates.apply(record["candidate_id"], **apply_args(record))
    with pytest.raises(candidates.CandidateError) as exc:
        candidates.apply(record["candidate_id"], **apply_args(record))
    assert exc.value.code == "already_applied"


def test_a_blocked_candidate_cannot_be_applied():
    record = candidates.build("amazon")
    with pytest.raises(candidates.CandidateError) as exc:
        candidates.apply(
            record["candidate_id"],
            patch_ids=["x"],
            operator="lottie",
            reason="试试",
            confirm_token="whatever",
        )
    assert exc.value.code == "candidate_blocked"


def test_apply_requires_a_named_operator_and_a_reason():
    approved()
    record = candidates.build("amazon")
    for missing in ("operator", "reason"):
        args = apply_args(record) | {missing: ""}
        with pytest.raises(candidates.CandidateError) as exc:
            candidates.apply(record["candidate_id"], **args)
        assert exc.value.code == f"missing_{missing}"


# --------------------------------------------------------------------------- #
# Rollback                                                                     #
# --------------------------------------------------------------------------- #


def test_rollback_retires_the_drafts_the_apply_created():
    revision = approved()
    record = candidates.build("amazon")
    applied = candidates.apply(record["candidate_id"], **apply_args(record))
    child_id = applied["applied"][0]["candidate_revision_id"]

    rolled = candidates.rollback(record["candidate_id"], operator="lottie", reason="改用人工重写")
    assert rolled["state"] == "rolled_back"
    assert rolled["withdrawn_revision_ids"] == [child_id]

    # the draft is retired but still readable, and the approved copy is untouched
    assert review.get_revision(child_id)["state"] == review.ROLLED_BACK
    assert review.get_revision(revision["revision_id"])["state"] == review.APPROVED


def test_rolling_back_something_never_applied_is_refused():
    approved()
    record = candidates.build("amazon")
    with pytest.raises(candidates.CandidateError) as exc:
        candidates.rollback(record["candidate_id"], operator="lottie", reason="算了")
    assert exc.value.code == "not_applied"


def test_a_draft_with_children_is_not_withdrawn_from_under_them():
    revision = approved()
    record = candidates.build("amazon")
    applied = candidates.apply(record["candidate_id"], **apply_args(record))
    child_id = applied["applied"][0]["candidate_revision_id"]
    # someone validated and approved the migration draft, then edited on top
    review.submit_for_validation(child_id)
    review.approve(child_id, operator="lottie")
    review.save_draft(child_id, review.get_revision(child_id)["content"] | {"title": "改过的标题 350ml"})

    with pytest.raises(candidates.CandidateError) as exc:
        candidates.rollback(record["candidate_id"], operator="lottie", reason="撤回")
    assert exc.value.code in ("has_descendants", "not_withdrawable")
    assert review.get_revision(revision["revision_id"])["state"] in (
        review.APPROVED,
        review.SUPERSEDED,
    )


# --------------------------------------------------------------------------- #
# Through the Agent action and the HTTP surface                                #
# --------------------------------------------------------------------------- #


def test_the_agent_action_returns_a_real_candidate_id():
    approved()
    params = {"platform": "amazon"}
    run = actions.execute(
        {"action": "build_migration_candidate", "params": params},
        idempotency_key="mig-1",
        confirmed_token=actions.confirmation_token("build_migration_candidate", params),
    )
    assert run["state"] == actions.OK
    result = run["result"]
    assert result["built"] is True
    assert result["applied"] is False
    assert candidates.get(result["candidate_id"])["state"] == "built"
    assert result["patch_count"] >= 1
    assert result["affected_fields"] == ["title"]


def test_the_agent_action_reports_blockers_instead_of_claiming_success():
    params = {"platform": "amazon"}
    run = actions.execute(
        {"action": "build_migration_candidate", "params": params},
        idempotency_key="mig-2",
        confirmed_token=actions.confirmation_token("build_migration_candidate", params),
    )
    assert run["state"] == actions.OK
    assert run["result"]["built"] is False
    assert run["result"]["blockers"]


def test_the_action_still_requires_its_own_confirmation():
    approved()
    run = actions.execute(
        {"action": "build_migration_candidate", "params": {"platform": "amazon"}},
        idempotency_key="mig-3",
    )
    assert run["state"] == actions.NEEDS_CONFIRMATION
    assert candidates.listing() == []


def test_the_http_surface_serves_the_candidate_and_a_bound_token():
    approved()
    record = candidates.build("amazon")
    res = client.get(f"/api/migration/candidates/{record['candidate_id']}")
    assert res.status_code == 200
    data = res.json()["data"]
    assert data["candidate"]["candidate_id"] == record["candidate_id"]
    patch_ids = [p["patch_id"] for p in data["candidate"]["patches"]]
    assert data["confirmation_token"] == candidates.confirmation_token(
        record["candidate_id"], patch_ids
    )

    applied = client.post(
        f"/api/migration/candidates/{record['candidate_id']}/apply",
        json={
            "patch_ids": patch_ids,
            "operator": "lottie",
            "reason": "规则变更后迁移",
            "confirm_token": data["confirmation_token"],
        },
    )
    assert applied.status_code == 200
    assert applied.json()["data"]["candidate"]["state"] == "applied"


def test_an_unknown_candidate_is_a_404_not_an_empty_record():
    res = client.get("/api/migration/candidates/mig-9999")
    assert res.status_code == 404
    assert res.json()["error"] == "unknown_candidate"
