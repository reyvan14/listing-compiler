"""Editable listing revisions, validation gating, and human approval.

These tests exercise the invariants that make the review workflow trustworthy
rather than decorative: approval cannot outrun validation, an edit cannot
inherit an old verdict, rollback restores content without erasing what came
after it, and no code path invents a reviewer.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import review
from app import app

client = TestClient(app)

SKU = "AERO-350"

#: A TikTok title that trips three blocking rules (hashtag, emoji, "!").
BLOCKED_TITLE = "🔥爆款 #summer 折叠水杯!!!"
#: A clean Amazon title with the five bullets the checker demands.
CLEAN_TITLE = "Collapsible Silicone Travel Cup 350ml Leakproof Lid"


def bullets(prefix: str = "point") -> list[dict[str, str]]:
    return [{"label": f"五点 {i}", "value": f"{prefix} {i}"} for i in range(1, 6)]


def make_revision(
    *,
    platform: str = "amazon",
    title: str = CLEAN_TITLE,
    fields: "list[dict[str, str]] | None" = None,
    sku_id: str = SKU,
) -> dict:
    return review.create_revision(
        sku_id=sku_id,
        platform=platform,
        content={"title": title, "fields": bullets() if fields is None else fields},
        product_name="AeroFold Collapsible Silicone Travel Cup",
        points="折叠到 4cm\n食品级硅胶",
        generator={"provider": "aliyun", "model": "qwen-test"},
    )


# --------------------------------------------------------------------------- #
# Revision creation                                                            #
# --------------------------------------------------------------------------- #


def test_a_generated_listing_becomes_a_draft_revision_with_full_provenance():
    revision = make_revision()

    assert revision["state"] == review.DRAFT
    assert revision["source"] == "generated"
    assert revision["sku_id"] == SKU
    assert revision["platform"] == "amazon"
    assert revision["market"] == "US"
    assert revision["locale"] == "en-US"
    assert revision["parent_revision_id"] == ""
    assert revision["created_at"]
    assert revision["content_hash"]
    # per-field hashes let a passport pin exact copy later
    assert revision["field_hashes"]["title"]
    assert revision["generator"] == {"provider": "aliyun", "model": "qwen-test"}


def test_creating_the_same_generated_content_twice_does_not_fork_history():
    """Reopening the reviewer must not manufacture revisions."""
    first = make_revision()
    second = make_revision()

    assert first["revision_id"] == second["revision_id"]
    assert len(review.list_revisions(sku_id=SKU)) == 1


def test_generator_metadata_cannot_carry_a_credential():
    revision = review.create_revision(
        sku_id=SKU,
        platform="amazon",
        content={"title": CLEAN_TITLE, "fields": bullets()},
        generator={
            "provider": "aliyun",
            "api_key": "sk-must-never-persist",
            "authorization": "Bearer sk-nope",
            "cookie": "session=abc",
        },
    )

    assert revision["generator"] == {"provider": "aliyun"}
    stored = review.read_ledger()
    assert "sk-must-never-persist" not in str(stored)


# --------------------------------------------------------------------------- #
# Editing                                                                      #
# --------------------------------------------------------------------------- #


def test_editing_a_draft_updates_it_in_place():
    revision = make_revision()
    edited = review.save_draft(
        revision["revision_id"],
        {"title": "Collapsible Travel Cup 350ml Updated", "fields": bullets()},
        operator="lottie",
    )

    assert edited["revision_id"] == revision["revision_id"]
    assert edited["content"]["title"] == "Collapsible Travel Cup 350ml Updated"
    assert edited["content_hash"] != revision["content_hash"]
    assert len(review.list_revisions(sku_id=SKU)) == 1


def test_saving_identical_content_is_a_no_op():
    """'Reset unsaved edits' then save must not churn the ledger."""
    revision = make_revision()
    again = review.save_draft(revision["revision_id"], revision["content"])

    assert again["content_hash"] == revision["content_hash"]
    assert again["updated_at"] == revision["updated_at"]
    assert len(review.read_ledger()["audit"]) == 1  # only the creation event


def test_editing_an_approved_revision_forks_a_candidate_and_leaves_it_intact():
    revision = make_revision()
    review.submit_for_validation(revision["revision_id"])
    review.approve(revision["revision_id"], operator="lottie", reason="looks good")

    candidate = review.save_draft(
        revision["revision_id"],
        {"title": "Collapsible Travel Cup 350ml v2", "fields": bullets()},
        operator="lottie",
    )

    assert candidate["revision_id"] != revision["revision_id"]
    assert candidate["parent_revision_id"] == revision["revision_id"]
    assert candidate["state"] == review.DRAFT
    assert candidate["source"] == "edited"
    # the approved revision is untouched and still the active one
    original = review.get_revision(revision["revision_id"])
    assert original["state"] == review.APPROVED
    assert original["content"]["title"] == CLEAN_TITLE
    assert review.active_revision(SKU, "amazon")["revision_id"] == revision["revision_id"]


def test_an_edit_invalidates_the_validation_result_computed_for_the_old_copy():
    revision = make_revision()
    validated = review.submit_for_validation(revision["revision_id"])
    assert validated["state"] == review.VALIDATED
    assert validated["validation_id"]

    edited = review.save_draft(
        revision["revision_id"],
        {"title": "Collapsible Travel Cup 350ml Edited", "fields": bullets()},
    )

    assert edited["state"] == review.DRAFT
    assert edited["validation_id"] == ""


# --------------------------------------------------------------------------- #
# Validation and approval gating                                               #
# --------------------------------------------------------------------------- #


def test_validation_with_blockers_sends_the_revision_back():
    revision = make_revision(platform="tiktok", title=BLOCKED_TITLE)
    result = review.submit_for_validation(revision["revision_id"])

    assert result["state"] == review.NEEDS_CHANGES
    record = review.read_ledger()["validations"][result["validation_id"]]
    assert set(record["blockers"]) >= {"no_hashtags", "no_emoji", "prohibited_chars"}
    assert record["policy_snapshot_ids"]


def test_approval_is_refused_while_a_blocker_stands():
    revision = make_revision(platform="tiktok", title=BLOCKED_TITLE)
    review.submit_for_validation(revision["revision_id"])

    with pytest.raises(review.ReviewError) as exc:
        review.approve(revision["revision_id"], operator="lottie", reason="ship it")

    assert exc.value.code == "blocked_by_validation"
    assert review.get_revision(revision["revision_id"])["state"] == review.NEEDS_CHANGES
    assert review.active_revision(SKU, "tiktok") is None


def test_approval_revalidates_and_refuses_a_verdict_that_no_longer_applies():
    """A stored green check must not be enough on its own.

    The revision is validated while clean, then edited into a blocking state
    through the ledger directly -- simulating any path that could desynchronise
    content from verdict. Approval must re-run the checker and refuse.
    """
    revision = make_revision(platform="tiktok", title="Collapsible Silicone Travel Cup 350ml")
    review.submit_for_validation(revision["revision_id"])

    ledger = review.read_ledger()
    stored = ledger["revisions"][revision["revision_id"]]
    stored["content"]["title"] = BLOCKED_TITLE
    stored["content_hash"] = review.content_hash(stored["content"])
    stored["state"] = review.VALIDATED  # stale verdict left deliberately in place
    review._write_ledger(ledger)

    with pytest.raises(review.ReviewError) as exc:
        review.approve(revision["revision_id"], operator="lottie")

    assert exc.value.code == "blocked_by_validation"


def test_approval_requires_a_named_operator():
    revision = make_revision()
    review.submit_for_validation(revision["revision_id"])

    with pytest.raises(review.ReviewError) as exc:
        review.approve(revision["revision_id"], operator="  ")

    assert exc.value.code == "missing_operator"


def test_approval_records_what_permitted_it():
    revision = make_revision()
    review.submit_for_validation(revision["revision_id"])
    result = review.approve(revision["revision_id"], operator="lottie", reason="copy checked")

    approval = result["approval"]
    assert approval["approval_id"]
    assert approval["revision_id"] == revision["revision_id"]
    assert approval["operator"] == "lottie"
    assert approval["decision"] == "approved"
    assert approval["reason"] == "copy checked"
    assert approval["validation_result_ids"]
    assert approval["policy_snapshot_ids"]
    assert approval["at"]


def test_a_revision_cannot_be_approved_twice():
    revision = make_revision()
    review.submit_for_validation(revision["revision_id"])
    review.approve(revision["revision_id"], operator="lottie")

    with pytest.raises(review.ReviewError) as exc:
        review.approve(revision["revision_id"], operator="lottie")

    assert exc.value.code == "already_approved"
    assert len(review.read_ledger()["approvals"]) == 1


def test_approving_a_second_revision_supersedes_the_first_without_deleting_it():
    first = make_revision()
    review.submit_for_validation(first["revision_id"])
    review.approve(first["revision_id"], operator="lottie")

    second = review.save_draft(
        first["revision_id"],
        {"title": "Collapsible Silicone Travel Cup 350ml Leakproof v2", "fields": bullets()},
    )
    review.submit_for_validation(second["revision_id"])
    result = review.approve(second["revision_id"], operator="lottie")

    assert result["superseded"] == [first["revision_id"]]
    assert review.get_revision(first["revision_id"])["state"] == review.SUPERSEDED
    assert review.active_revision(SKU, "amazon")["revision_id"] == second["revision_id"]
    # exactly one active approved revision for the sku+platform pair
    approved = [r for r in review.list_revisions(sku_id=SKU, platform="amazon")
                if r["state"] == review.APPROVED]
    assert len(approved) == 1


def test_request_changes_needs_a_reason_and_is_recorded():
    revision = make_revision()
    review.submit_for_validation(revision["revision_id"])

    with pytest.raises(review.ReviewError):
        review.request_changes(revision["revision_id"], operator="lottie", reason="")

    result = review.request_changes(
        revision["revision_id"], operator="lottie", reason="标题缺少容量"
    )
    assert result["revision"]["state"] == review.NEEDS_CHANGES
    assert result["approval"]["decision"] == "changes_requested"
    assert result["approval"]["reason"] == "标题缺少容量"


# --------------------------------------------------------------------------- #
# Warning acknowledgement                                                      #
# --------------------------------------------------------------------------- #


def warned_revision() -> dict:
    """A revision whose validation raises warnings but no blockers."""
    revision = make_revision(platform="tiktok", title="折叠硅胶水杯 350ml")
    validated = review.submit_for_validation(revision["revision_id"])
    record = review.read_ledger()["validations"][validated["validation_id"]]
    assert record["warnings"] and not record["blockers"], record
    return validated


def test_acknowledging_a_warning_records_who_reason_and_when():
    revision = warned_revision()
    record = review.read_ledger()["validations"][revision["validation_id"]]
    warning_id = record["warnings"][0]

    ack = review.acknowledge_warnings(
        revision["revision_id"], [warning_id], operator="lottie", reason="平台已确认可放行"
    )

    assert ack["operator"] == "lottie"
    assert ack["reason"] == "平台已确认可放行"
    assert ack["warning_ids"] == [warning_id]
    assert ack["revision_id"] == revision["revision_id"]
    assert ack["at"]


def test_a_warning_that_was_never_raised_cannot_be_acknowledged():
    revision = warned_revision()

    with pytest.raises(review.ReviewError) as exc:
        review.acknowledge_warnings(
            revision["revision_id"], ["invented_warning"], operator="lottie", reason="looks fine"
        )

    assert exc.value.code == "unknown_warning"


def test_acknowledgement_requires_an_operator_and_a_reason():
    revision = warned_revision()
    record = review.read_ledger()["validations"][revision["validation_id"]]
    warning_id = record["warnings"][0]

    for operator, reason in (("", "why"), ("lottie", "")):
        with pytest.raises(review.ReviewError):
            review.acknowledge_warnings(
                revision["revision_id"], [warning_id], operator=operator, reason=reason
            )


def test_a_blocker_cannot_be_waved_through_as_a_warning():
    revision = make_revision(platform="tiktok", title=BLOCKED_TITLE)
    result = review.submit_for_validation(revision["revision_id"])
    record = review.read_ledger()["validations"][result["validation_id"]]

    with pytest.raises(review.ReviewError) as exc:
        review.acknowledge_warnings(
            revision["revision_id"], [record["blockers"][0]], operator="lottie", reason="ship"
        )

    assert exc.value.code == "unknown_warning"


# --------------------------------------------------------------------------- #
# Rollback                                                                     #
# --------------------------------------------------------------------------- #


def test_rollback_restores_exact_content_as_a_new_traceable_revision():
    first = make_revision()
    review.submit_for_validation(first["revision_id"])
    review.approve(first["revision_id"], operator="lottie")

    second = review.save_draft(
        first["revision_id"],
        {"title": "Collapsible Silicone Travel Cup 350ml Leakproof v2", "fields": bullets("edited")},
    )
    review.submit_for_validation(second["revision_id"])
    review.approve(second["revision_id"], operator="lottie")

    result = review.rollback_to(first["revision_id"], operator="lottie", reason="v2 文案有误")
    restored = result["revision"]

    assert restored["revision_id"] not in (first["revision_id"], second["revision_id"])
    assert restored["content"] == first["content"]
    assert restored["content_hash"] == first["content_hash"]
    assert restored["restores_revision_id"] == first["revision_id"]
    assert restored["parent_revision_id"] == second["revision_id"]
    assert restored["source"] == "rollback"
    assert restored["state"] == review.APPROVED
    assert review.active_revision(SKU, "amazon")["revision_id"] == restored["revision_id"]


def test_rollback_preserves_later_history():
    first = make_revision()
    review.submit_for_validation(first["revision_id"])
    review.approve(first["revision_id"], operator="lottie")
    second = review.save_draft(
        first["revision_id"],
        {"title": "Collapsible Silicone Travel Cup 350ml Leakproof v2", "fields": bullets()},
    )
    review.submit_for_validation(second["revision_id"])
    review.approve(second["revision_id"], operator="lottie")

    review.rollback_to(first["revision_id"], operator="lottie", reason="回滚")

    history = review.list_revisions(sku_id=SKU, platform="amazon")
    assert [r["revision_id"] for r in history] == [
        first["revision_id"],
        second["revision_id"],
        history[-1]["revision_id"],
    ]
    # the revision we rolled away from is re-stated, not deleted
    assert review.get_revision(second["revision_id"])["state"] == review.ROLLED_BACK
    assert review.get_revision(second["revision_id"])["content"]["title"].endswith("v2")


def test_rollback_is_refused_when_the_restored_copy_would_no_longer_pass():
    """Today's rules gate a rollback exactly as they gate an approval."""
    clean = make_revision(platform="tiktok", title="Collapsible Silicone Travel Cup 350ml")
    review.submit_for_validation(clean["revision_id"])
    review.approve(clean["revision_id"], operator="lottie")

    # Force the stored content of the rollback target into a blocking state.
    ledger = review.read_ledger()
    ledger["revisions"][clean["revision_id"]]["content"]["title"] = BLOCKED_TITLE
    review._write_ledger(ledger)

    with pytest.raises(review.ReviewError) as exc:
        review.rollback_to(clean["revision_id"], operator="lottie", reason="restore")

    assert exc.value.code == "blocked_by_validation"
    # nothing was activated behind the operator's back
    active = review.active_revision(SKU, "tiktok")
    assert active is None or active["revision_id"] == clean["revision_id"]


# --------------------------------------------------------------------------- #
# Diff                                                                         #
# --------------------------------------------------------------------------- #


def test_diff_classifies_every_field_change():
    base = make_revision(
        fields=[{"label": "五点 1", "value": "keep"}, {"label": "搜索词", "value": "gone"}]
    )
    target = review.save_draft(
        base["revision_id"],
        {
            "title": "Collapsible Silicone Travel Cup 500ml",
            "fields": [{"label": "五点 1", "value": "keep"}, {"label": "描述", "value": "new"}],
        },
    )
    # save_draft on a draft edits in place, so diff against a stored snapshot
    diff = review.diff_content(base["content"], target["content"])
    by_label = {row["label"]: row for row in diff}

    assert by_label["标题"]["status"] == review.MODIFIED
    assert by_label["五点 1"]["status"] == review.UNCHANGED
    assert by_label["搜索词"]["status"] == review.REMOVED
    assert by_label["描述"]["status"] == review.ADDED


def test_diff_between_two_stored_revisions_reports_counts_and_lineage():
    first = make_revision()
    review.submit_for_validation(first["revision_id"])
    review.approve(first["revision_id"], operator="lottie")
    second = review.save_draft(
        first["revision_id"],
        {"title": "Collapsible Silicone Travel Cup 500ml Leakproof", "fields": bullets()},
    )

    diff = review.diff_revisions(first["revision_id"], second["revision_id"])

    assert diff["base"]["revision_id"] == first["revision_id"]
    assert diff["target"]["revision_id"] == second["revision_id"]
    assert diff["counts"][review.MODIFIED] == 1
    assert diff["counts"][review.UNCHANGED] == 5
    assert diff["identical"] is False


# --------------------------------------------------------------------------- #
# Audit trail                                                                  #
# --------------------------------------------------------------------------- #


def test_no_reviewer_activity_exists_that_a_human_did_not_perform():
    revision = make_revision()
    review.submit_for_validation(revision["revision_id"])

    view = review.revision_view(revision["revision_id"])
    assert view["approvals"] == []
    assert view["acknowledgements"] == []
    assert view["approved_revision_id"] == ""
    # every recorded event names the operator that caused it, or no operator
    for entry in view["audit"]:
        assert entry["operator"] == ""  # nothing above was attributed to a person


def test_every_transition_lands_in_the_audit_trail():
    revision = make_revision()
    review.submit_for_validation(revision["revision_id"], operator="lottie")
    review.approve(revision["revision_id"], operator="lottie", reason="ok")

    events = [e["event"] for e in review.revision_view(revision["revision_id"])["audit"]]
    assert events == [
        "revision_created",
        "validation_submitted",
        "validation_completed",
        "revision_approved",
    ]


# --------------------------------------------------------------------------- #
# HTTP surface                                                                 #
# --------------------------------------------------------------------------- #


def test_the_http_workflow_runs_end_to_end():
    created = client.post(
        "/api/review/revisions",
        json={
            "sku_id": SKU,
            "platform": "amazon",
            "content": {"title": CLEAN_TITLE, "fields": bullets()},
            "product_name": "AeroFold",
        },
    )
    assert created.status_code == 200
    revision_id = created.json()["data"]["revision"]["revision_id"]

    validated = client.post(f"/api/review/revisions/{revision_id}/validate", json={})
    assert validated.json()["data"]["revision"]["state"] == review.VALIDATED

    approved = client.post(
        f"/api/review/revisions/{revision_id}/approve",
        json={"operator": "lottie", "reason": "ok"},
    )
    body = approved.json()["data"]
    assert body["revision"]["state"] == review.APPROVED
    assert body["approvals"][0]["operator"] == "lottie"

    listed = client.get("/api/review/revisions", params={"sku_id": SKU})
    assert len(listed.json()["data"]["revisions"]) == 1


def test_the_http_layer_reports_a_blocked_approval_as_a_conflict():
    created = client.post(
        "/api/review/revisions",
        json={
            "sku_id": SKU,
            "platform": "tiktok",
            "content": {"title": BLOCKED_TITLE, "fields": bullets()},
        },
    )
    revision_id = created.json()["data"]["revision"]["revision_id"]
    client.post(f"/api/review/revisions/{revision_id}/validate", json={})

    blocked = client.post(
        f"/api/review/revisions/{revision_id}/approve", json={"operator": "lottie"}
    )
    assert blocked.status_code == 409
    assert blocked.json()["error"] == "blocked_by_validation"


def test_an_unknown_revision_is_a_404_not_a_crash():
    assert client.get("/api/review/revisions/rev-9999").status_code == 404
