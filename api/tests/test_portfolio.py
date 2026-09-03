"""Batch portfolio import, blast radius, bulk approval, apply and rollback.

Covers acceptance items 5-9.
"""

from __future__ import annotations

import copy
import io

from fastapi.testclient import TestClient

import app as app_module
import portfolio

client = TestClient(app_module.app)

BASE = "amazon-us-pre-2025.01.21"
CAND = "amazon-us-2025.01.21"

GOOD_CSV = (
    "sku,product_name,selling_points,platforms\n"
    "AERO-350,AeroFold Travel Cup,Folds to 4cm|Leak-proof lid 350ml,amazon;tiktok;shopify\n"
    "AERO-500,AeroFold Travel Bottle,Folds to 5cm|Leak-proof lid 500ml,amazon;shopify\n"
    "AERO-LEGACY,Cup Cup Cup Ultra! Mega$ Cup,Folds flat|350ml,amazon\n"
)


def import_csv(text: str, name: str = "portfolio.csv"):
    return client.post(
        "/api/portfolio/import",
        files={"file": (name, io.BytesIO(text.encode("utf-8")), "text/csv")},
    )


def imported(text: str = GOOD_CSV):
    return import_csv(text).json()["data"]["skus"]


# --------------------------------------------------------------------------- #
# 5. Import reports invalid rows without losing valid ones                     #
# --------------------------------------------------------------------------- #


def test_template_is_downloadable_and_parses_as_its_own_input():
    r = client.get("/api/portfolio/template")
    assert r.status_code == 200
    assert "attachment" in r.headers["content-disposition"]
    # the template must be a valid portfolio, not just illustrative text
    parsed = portfolio.parse_portfolio(r.text.encode("utf-8"), "csv")
    assert parsed["summary"]["rejected"] == 0
    assert parsed["summary"]["imported"] >= 2


def test_malformed_rows_are_reported_without_losing_the_valid_ones():
    messy = (
        "sku,product_name,selling_points,platforms\n"
        "OK-1,Good Cup,Folds to 4cm|350ml,amazon\n"
        ",Nameless,points,amazon\n"                       # no sku
        "OK-2,Second Cup,Folds to 5cm|500ml,shopify\n"
        "NO-NAME,,points here,amazon\n"                   # no product_name
        "OK-1,Duplicate Cup,x|y,amazon\n"                 # duplicate sku
        "NO-POINTS,Third Cup,,amazon\n"                   # no selling points
        "BAD-PLAT,Fourth Cup,a|b,etsy\n"                  # unusable platform
        "\n"                                              # blank line is not an error
        "OK-3,Fourth Cup,Folds|750ml,amazon;tiktok\n"
    )
    data = import_csv(messy).json()["data"]

    assert [s["sku"] for s in data["skus"]] == ["OK-1", "OK-2", "OK-3"]
    assert data["summary"]["imported"] == 3
    assert data["summary"]["rejected"] == 5

    reasons = {e["sku"]: e["error"] for e in data["errors"]}
    assert "缺少 sku" in reasons[""]
    assert "缺少 product_name" in reasons["NO-NAME"]
    assert "重复" in reasons["OK-1"]
    assert "缺少 selling_points" in reasons["NO-POINTS"]
    assert "平台无法识别" in reasons["BAD-PLAT"]
    # every error names the spreadsheet row so it can be found and fixed
    assert all(e["row"] >= 2 for e in data["errors"])


def test_an_unrecognised_platform_alongside_valid_ones_is_a_warning_not_a_loss():
    data = import_csv(
        "sku,product_name,selling_points,platforms\n"
        "S1,Cup,Folds|350ml,amazon;etsy;shopify\n"
    ).json()["data"]
    assert data["skus"][0]["platforms"] == ["amazon", "shopify"]
    assert data["errors"][0]["severity"] == "warning"
    assert data["summary"]["rejected"] == 0


def test_import_rejects_a_non_spreadsheet_upload():
    r = client.post(
        "/api/portfolio/import",
        files={"file": ("notes.txt", io.BytesIO(b"hello"), "text/plain")},
    )
    assert r.status_code == 415


def test_xlsx_import_round_trips():
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.append(["sku", "product_name", "selling_points", "platforms"])
    ws.append(["X-1", "Xlsx Cup", "Folds to 4cm|350ml", "amazon"])
    buf = io.BytesIO()
    wb.save(buf)

    r = client.post(
        "/api/portfolio/import",
        files={
            "file": (
                "p.xlsx",
                io.BytesIO(buf.getvalue()),
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            )
        },
    )
    data = r.json()["data"]
    assert [s["sku"] for s in data["skus"]] == ["X-1"]
    assert data["skus"][0]["points"] == "Folds to 4cm\n350ml"


# --------------------------------------------------------------------------- #
# 6. A policy change produces the correct SKU/platform/field blast radius      #
# --------------------------------------------------------------------------- #


def test_policy_change_affects_only_the_violating_sku_and_platform():
    r = client.post(
        "/api/portfolio/impact",
        json={
            "skus": imported(),
            "base_policy_version": BASE,
            "candidate_policy_version": CAND,
        },
    )
    data = r.json()["data"]
    su = data["summary"]

    assert su["skus_scanned"] == 3
    assert su["skus_affected"] == 1
    assert su["skus_unaffected"] == 2
    assert su["affected_platforms"] == ["amazon"]
    assert su["affected_fields"] == ["title"]

    touched = [row for row in data["matrix"] if row["status"] != "unaffected"]
    assert {row["sku"] for row in touched} == {"AERO-LEGACY"}
    assert {row["platform"] for row in touched} == {"amazon"}
    # the compliant SKUs appear in the matrix as explicitly unaffected
    assert {row["sku"] for row in data["matrix"]} == {"AERO-350", "AERO-500", "AERO-LEGACY"}


def test_a_sku_fact_change_affects_only_that_sku():
    skus = imported()
    r = client.post(
        "/api/portfolio/impact",
        json={
            "skus": skus,
            "points_override": {"AERO-350": "Folds to 4cm|Leak-proof lid 300ml"},
        },
    )
    data = r.json()["data"]
    assert data["summary"]["skus_affected"] == 1
    touched = {row["sku"] for row in data["matrix"] if row["status"] != "unaffected"}
    assert touched == {"AERO-350"}


def test_the_matrix_carries_sku_platform_field_status_and_reason():
    data = client.post(
        "/api/portfolio/impact",
        json={"skus": imported(), "base_policy_version": BASE, "candidate_policy_version": CAND},
    ).json()["data"]
    row = next(r for r in data["matrix"] if r["status"] != "unaffected")
    for key in ("sku", "platform", "field", "status", "reason", "cause"):
        assert key in row and row[key] is not None, key
    assert row["reason"]


# --------------------------------------------------------------------------- #
# 7 + 8. Bulk approval of safe patches; risky patches cannot bypass review     #
# --------------------------------------------------------------------------- #


def _analysis(**kw):
    body = {"skus": imported(), "base_policy_version": BASE, "candidate_policy_version": CAND}
    body.update(kw)
    return client.post("/api/portfolio/impact", json=body).json()["data"]


def test_safe_patches_can_be_approved_in_bulk():
    analysis = _analysis()
    safe = [r for r in analysis["matrix"] if r["status"] == "safe_patch"]
    assert safe, "expected at least one safely patchable row"

    before = copy.deepcopy(analysis["artifacts"])
    out = client.post(
        "/api/portfolio/apply",
        json={
            "artifacts": analysis["artifacts"],
            "approved": safe,
            "candidate_policy_version": CAND,
        },
    ).json()["data"]

    assert out["applied_skus"] == ["AERO-LEGACY"]
    assert out["rejected_patches"] == []

    # only the patched SKU changed; the others are byte-identical
    for sku in ("AERO-350", "AERO-500"):
        assert out["results"][sku]["artifacts"] == before[sku]

    amazon = next(
        a for a in out["results"]["AERO-LEGACY"]["artifacts"] if a["platform"] == "amazon"
    )
    assert "!" not in amazon["title"]
    assert amazon["status"] == "applied"


def test_a_review_required_patch_cannot_be_applied_through_bulk_approval():
    analysis = _analysis(points_override={"AERO-350": "Folds to 4cm|Leak-proof lid 300ml"})
    risky = [r for r in analysis["matrix"] if r["status"] == "review_required"]
    assert risky, "expected at least one review-required row"

    out = client.post(
        "/api/portfolio/apply",
        json={"artifacts": analysis["artifacts"], "approved": risky},
    ).json()["data"]

    assert out["applied_skus"] == []
    assert len(out["rejected_patches"]) == len(risky)
    assert all("需人工复核" in p["reason"] for p in out["rejected_patches"])
    # and nothing was written
    for sku, res in out["results"].items():
        assert res["applied"] == []


def test_mixing_a_risky_patch_into_a_safe_batch_rejects_only_the_risky_one():
    analysis = _analysis(points_override={"AERO-350": "Folds to 4cm|Leak-proof lid 300ml"})
    safe = [r for r in analysis["matrix"] if r["status"] == "safe_patch"]
    risky = [r for r in analysis["matrix"] if r["status"] == "review_required"]
    assert safe and risky

    out = client.post(
        "/api/portfolio/apply",
        json={"artifacts": analysis["artifacts"], "approved": safe + risky},
    ).json()["data"]

    assert len(out["rejected_patches"]) == len(risky)
    assert out["applied_skus"], "the safe patches should still have applied"


# --------------------------------------------------------------------------- #
# 9. Batch and individual rollback restore prior artifacts                     #
# --------------------------------------------------------------------------- #


def test_batch_rollback_restores_every_sku_exactly():
    analysis = _analysis()
    snapshot = portfolio.snapshot_portfolio(analysis["artifacts"])
    original = copy.deepcopy(analysis["artifacts"])

    safe = [r for r in analysis["matrix"] if r["status"] == "safe_patch"]
    applied = client.post(
        "/api/portfolio/apply",
        json={"artifacts": analysis["artifacts"], "approved": safe, "candidate_policy_version": CAND},
    ).json()["data"]
    assert applied["applied_skus"]

    restored = client.post(
        "/api/portfolio/rollback", json={"snapshot": snapshot}
    ).json()["data"]
    assert restored["scope"] == "batch"
    assert restored["artifacts"] == original


def test_a_single_sku_can_be_rolled_back_on_its_own():
    analysis = _analysis()
    snapshot = portfolio.snapshot_portfolio(analysis["artifacts"])

    restored = client.post(
        "/api/portfolio/rollback", json={"snapshot": snapshot, "sku": "AERO-LEGACY"}
    ).json()["data"]

    assert restored["scope"] == "AERO-LEGACY"
    assert list(restored["artifacts"]) == ["AERO-LEGACY"]
    assert restored["artifacts"]["AERO-LEGACY"] == analysis["artifacts"]["AERO-LEGACY"]


def test_rollback_rejects_an_unknown_sku_and_a_malformed_snapshot():
    analysis = _analysis()
    snapshot = portfolio.snapshot_portfolio(analysis["artifacts"])
    bad = client.post("/api/portfolio/rollback", json={"snapshot": snapshot, "sku": "NOPE"})
    assert bad.status_code == 400
    assert client.post("/api/portfolio/rollback", json={"snapshot": {}}).status_code == 400


# --------------------------------------------------------------------------- #
# Audit report                                                                 #
# --------------------------------------------------------------------------- #


def test_batch_report_records_versions_values_and_approver_in_json_and_html():
    analysis = _analysis()
    safe = [r for r in analysis["matrix"] if r["status"] == "safe_patch"]
    applied = client.post(
        "/api/portfolio/apply",
        json={"artifacts": analysis["artifacts"], "approved": safe, "candidate_policy_version": CAND},
    ).json()["data"]

    body = {
        "analysis": analysis,
        "apply_result": applied,
        "status": "applied",
        "approver": "ops@example.test",
        "evidence_versions": [{"source_id": "abc123", "sha256": "deadbeef"}],
    }
    report = client.post("/api/portfolio/report", json=body).json()["data"]

    assert report["schema"] == "listing-batch-migration-report/v1"
    assert report["policy"]["base_version"] == BASE
    assert report["policy"]["candidate_version"] == CAND
    assert report["approver"] == "ops@example.test"
    assert report["evidence_versions"][0]["source_id"] == "abc123"
    assert report["summary"]["skus_scanned"] == 3
    assert report["apply"]["applied_skus"] == ["AERO-LEGACY"]

    patched = report["patched_fields"][0]
    assert patched["original_value"] and patched["patched_value"]
    assert patched["original_value"] != patched["patched_value"]
    assert report["generated_at"]

    html = client.post("/api/portfolio/report", params={"format": "html"}, json=body)
    assert html.status_code == 200 and "text/html" in html.headers["content-type"]
    assert "批量迁移审计报告" in html.text
    # the report must never imply a marketplace action
    assert "已发布" not in html.text


def test_no_portfolio_endpoint_calls_a_model(monkeypatch):
    import token_plan

    async def boom(*a, **k):  # pragma: no cover - must not run
        raise AssertionError("a portfolio endpoint called the provider")

    monkeypatch.setattr(token_plan, "chat_completion", boom)
    analysis = _analysis()
    assert analysis["summary"]["skus_scanned"] == 3
