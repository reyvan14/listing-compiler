"""HTTP surface for the migration workflow + secret-safety checks."""

from __future__ import annotations

import logging

from fastapi.testclient import TestClient

import app as app_module
import migration
from tests.helpers import POINTS_300, POINTS_350, demo_artifacts, demo_facts

client = TestClient(app_module.app)

AMAZON_BASE = "amazon-us-2025.03"
AMAZON_CAND = "amazon-us-2026.03-candidate"


def _impact_body(points_before=POINTS_350, points_after=POINTS_300, **extra):
    return {
        "artifacts": demo_artifacts(points_before),
        "facts_before": demo_facts(points_before),
        "facts_after": demo_facts(points_after),
        **extra,
    }


def test_policy_snapshots_and_diff_endpoints():
    snaps = client.get("/api/policy/snapshots").json()["data"]["snapshots"]
    versions = {s["version"] for s in snaps}
    assert AMAZON_BASE in versions and AMAZON_CAND in versions

    d = client.get("/api/policy/diff", params={"base": AMAZON_BASE, "candidate": AMAZON_CAND})
    assert d.status_code == 200
    body = d.json()["data"]
    assert len(body["added"]) == 2 and len(body["changed"]) == 1

    bad = client.get("/api/policy/diff", params={"base": "nope", "candidate": AMAZON_CAND})
    assert bad.status_code == 400
    assert bad.json()["error"] == "unknown_policy_version"


def test_impact_endpoint_amazon_policy_only():
    body = _impact_body(
        POINTS_350, POINTS_350,
        base_policy_version=AMAZON_BASE, candidate_policy_version=AMAZON_CAND,
    )
    r = client.post("/api/migration/impact", json=body)
    assert r.status_code == 200
    data = r.json()["data"]
    assert {x["artifact_id"] for x in data["affected"]} == {"amazon"}
    assert {x["artifact_id"] for x in data["unaffected"]} == {"tiktok", "shopify"}


# --------------------------------------------------------------------------- #
# 9. candidate endpoint rejects unrelated field changes                        #
# --------------------------------------------------------------------------- #


def test_candidate_endpoint_rejects_unrelated_target():
    body = _impact_body()
    body["targets"] = [["shopify", "media"]]  # not capacity-dependent
    r = client.post("/api/migration/candidate", json=body)
    assert r.status_code == 400
    assert r.json()["error"] == "unrelated_target"


def test_candidate_endpoint_returns_patches_for_impacted_targets():
    body = _impact_body()
    r = client.post("/api/migration/candidate", json=body)
    assert r.status_code == 200
    data = r.json()["data"]
    fields = {(p["artifact_id"], p["field"]) for p in data["patches"]}
    assert ("amazon", "title") in fields
    assert ("shopify", "media") not in fields


def test_apply_then_rollback_via_http_restores_state():
    arts = demo_artifacts(POINTS_350)
    fa = demo_facts(POINTS_300)
    snap = migration.snapshot_state(arts)

    impact = client.post("/api/migration/impact", json={
        "artifacts": arts, "facts_before": demo_facts(POINTS_350), "facts_after": fa,
    }).json()["data"]
    cand = client.post("/api/migration/candidate", json={
        "artifacts": arts, "impact": impact,
        "facts_before": demo_facts(POINTS_350), "facts_after": fa,
    }).json()["data"]
    approved = [p for p in cand["patches"] if not p["needs_human_review"]]
    applied = client.post("/api/migration/apply", json={
        "artifacts": arts, "approved_patches": approved, "facts_after": fa,
    }).json()["data"]
    changed_titles = [a["title"] for a in applied["artifacts"] if "300ml" in a["title"]]
    assert changed_titles

    restored = client.post("/api/migration/rollback", json={"snapshot": snap}).json()["data"]
    assert restored["artifacts"] == arts

    bad = client.post("/api/migration/rollback", json={"snapshot": {"nope": 1}})
    assert bad.status_code == 400 and bad.json()["error"] == "bad_snapshot"


def test_report_endpoint_json_and_html():
    body = _impact_body(POINTS_350, POINTS_350,
                        base_policy_version=AMAZON_BASE, candidate_policy_version=AMAZON_CAND)
    impact = client.post("/api/migration/impact", json=body).json()["data"]
    cand = client.post("/api/migration/candidate", json={**body, "impact": impact}).json()["data"]
    report_body = {
        "impact": impact, "candidate": cand, "status": "candidate",
        "base_policy_version": AMAZON_BASE, "candidate_policy_version": AMAZON_CAND,
    }
    j = client.post("/api/migration/report", json=report_body)
    assert j.status_code == 200
    assert j.json()["data"]["schema"] == "listing-migration-report/v1"

    h = client.post("/api/migration/report", params={"format": "html"}, json=report_body)
    assert h.status_code == 200 and "text/html" in h.headers["content-type"]
    assert "迁移报告" in h.text


# --------------------------------------------------------------------------- #
# 12. no provider secrets / raw responses in errors or logs                    #
# --------------------------------------------------------------------------- #


def test_migration_endpoints_never_call_a_real_provider(monkeypatch):
    """conftest clears env, so use_model must not reach token_plan.chat_completion."""
    import token_plan

    async def boom(*a, **k):  # pragma: no cover - must not run
        raise AssertionError("real provider call from a migration endpoint")

    monkeypatch.setattr(token_plan, "chat_completion", boom)
    body = _impact_body()
    body["use_model"] = True
    r = client.post("/api/migration/candidate", json=body)
    assert r.status_code == 200  # fell back to deterministic patches


def test_request_model_patch_returns_none_without_config():
    import asyncio

    arts = demo_artifacts(POINTS_350)
    out = asyncio.run(
        migration.request_model_patch(
            arts, [("amazon", "title")], facts_after=demo_facts(POINTS_300)
        )
    )
    assert out is None


def test_bad_snapshot_error_message_has_no_secrets(caplog):
    with caplog.at_level(logging.INFO):
        r = client.post("/api/migration/rollback", json={"snapshot": {"artifacts": "bad"}})
    assert r.status_code == 400
    blob = r.text + "\n".join(rec.message for rec in caplog.records)
    for needle in ("Authorization", "Bearer ", "sk-", "TOKEN_PLAN_API_KEY"):
        assert needle not in blob
