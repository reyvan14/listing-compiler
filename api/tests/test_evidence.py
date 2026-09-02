"""Evidence ledger: ingestion, fact states, and the release gate.

Covers acceptance items 1-4: an unsupported BPA-Free claim is blocked, adding
valid evidence changes only the affected fact, conflicting evidence blocks the
dependent claims, and expired certification evidence is rejected.
"""

from __future__ import annotations

import io
from datetime import date, timedelta

from fastapi.testclient import TestClient

import app as app_module
from evidence import extract, facts, gate, store

client = TestClient(app_module.app)

SPEC_CSV = b"attribute,value\ncapacity,350 ml\nfolded height,4 cm\n"
MANUAL_TXT = (
    b"AeroFold Travel Cup manual (fictional).\n"
    b"Capacity: 350 ml\nFolded height: 4 cm\nFood-grade silicone body.\n"
)
CONFLICT_CSV = b"attribute,value\ncapacity,300 ml\n"


def upload(data: bytes, filename: str, *, expires_on: str = "", label: str = ""):
    return client.post(
        "/api/evidence/upload",
        files={"file": (filename, io.BytesIO(data), "application/octet-stream")},
        data={"expires_on": expires_on, "label": label},
    )


# --------------------------------------------------------------------------- #
# Ingestion + stored metadata                                                  #
# --------------------------------------------------------------------------- #


def test_upload_records_the_full_provenance_of_a_source():
    r = upload(SPEC_CSV, "aerofold-spec.csv")
    assert r.status_code == 200
    src = r.json()["data"]["source"]

    assert src["source_id"] and len(src["source_id"]) == 16
    assert src["sha256"] == store.sha256_bytes(SPEC_CSV)
    assert src["filename"] == "aerofold-spec.csv"
    assert src["mime_type"] == "text/csv"
    assert src["size_bytes"] == len(SPEC_CSV)
    assert src["uploaded_at"].endswith("+00:00")

    # per-row locations carry the sheet/cell address and the extraction method
    locs = r.json()["data"]["locations"]
    assert any(l["cell"].startswith("row ") for l in locs)
    assert {l["method"] for l in locs} == {"deterministic"}


def test_reuploading_identical_bytes_is_idempotent():
    a = upload(SPEC_CSV, "spec.csv").json()["data"]["source"]
    b = upload(SPEC_CSV, "spec-copy.csv").json()["data"]["source"]
    assert a["source_id"] == b["source_id"]
    assert len(client.get("/api/evidence/sources").json()["data"]["sources"]) == 1


def test_upload_rejects_unsupported_types_and_oversized_files():
    bad = upload(b"MZ\x00binary", "malware.exe")
    assert bad.status_code == 415
    assert bad.json()["error"] == "unsupported_type"

    too_big = upload(b"x" * (store.MAX_UPLOAD_BYTES + 1), "huge.txt")
    assert too_big.status_code == 413
    assert too_big.json()["error"] == "file_too_large"

    empty = upload(b"", "empty.txt")
    assert empty.status_code == 400


def test_pdf_and_image_extraction_declare_their_method(demo_evidence):
    # An image has no text layer and OCR is not configured: the location must
    # say manual_review rather than pretending to have read the pixels.
    png = bytes.fromhex(
        "89504e470d0a1a0a0000000d494844520000000100000001080600000"
        "01f15c4890000000a49444154789c6360000002000100ffff03000006"
        "0005574bd0e10000000049454e44ae426082"
    )
    locs = extract.extract_locations("image", png)
    assert locs and locs[0]["method"] == "manual_review"
    assert locs[0]["excerpt"] == ""


# --------------------------------------------------------------------------- #
# Fact states — extraction never self-certifies                                #
# --------------------------------------------------------------------------- #


def test_extraction_never_produces_a_verified_fact():
    upload(SPEC_CSV, "spec.csv")
    ledger = client.get("/api/evidence/facts").json()["data"]["facts"]
    assert ledger, "expected the spec sheet to yield facts"
    assert {f["state"] for f in ledger} == {"needs_review"}
    assert all(f["sources"] for f in ledger)


def test_operator_confirmation_is_the_only_route_to_verified():
    upload(SPEC_CSV, "spec.csv")
    fid = facts.fact_id_for("capacity")

    r = client.post(f"/api/evidence/facts/{fid}/state", json={"state": "verified"})
    assert r.status_code == 200
    assert r.json()["data"]["fact"]["state"] == "verified"


def test_a_fact_with_no_sources_cannot_be_verified():
    client.post(
        "/api/evidence/facts",
        json={"key": "bpa_free", "claim_type": "certification", "value": "true"},
    )
    fid = facts.fact_id_for("bpa_free")
    r = client.post(f"/api/evidence/facts/{fid}/state", json={"state": "verified"})
    assert r.status_code == 400
    assert r.json()["error"] == "no_evidence"


# --------------------------------------------------------------------------- #
# 1. Unsupported BPA-Free claim is blocked                                     #
# --------------------------------------------------------------------------- #


def _draft(title: str, fields=None):
    return {
        "id": "amazon",
        "title": title,
        "fields": fields or [],
    }


def test_unsupported_bpa_free_claim_is_blocked():
    # Nothing uploaded: the ledger holds no BPA-Free evidence at all.
    r = client.post(
        "/api/evidence/gate",
        json={"drafts": [_draft("Collapsible Silicone Travel Cup 350ml, BPA-Free")]},
    )
    data = r.json()["data"]
    result = data["results"][0]

    assert result["verdict"] == "blocked"
    bpa = next(
        c
        for f in result["fields"]
        for c in f["claims"]
        if c["fact_key"] == "bpa_free"
    )
    assert bpa["verdict"] == "blocked"
    assert bpa["state"] == "unsupported"
    assert "缺少任何证据来源" in bpa["detail"]
    assert bpa["suggestion"]

    # and it surfaces as a blocking, evidence-kind check row
    row = next(c for c in data["checks"]["amazon"] if "bpa_free" in c["id"])
    assert row["blocking"] is True
    assert row["kind"] == "evidence"


def test_marketing_language_without_a_factual_claim_is_not_gated():
    r = client.post(
        "/api/evidence/gate",
        json={"drafts": [_draft("A cup that disappears into your pocket")]},
    )
    result = r.json()["data"]["results"][0]
    assert result["verdict"] == "ok"
    assert result["claim_count"] == 0


# --------------------------------------------------------------------------- #
# 2. Valid evidence changes only the affected fact / fields                    #
# --------------------------------------------------------------------------- #


def test_adding_evidence_affects_only_the_facts_that_document_supports():
    upload(SPEC_CSV, "spec.csv")  # capacity + folded height only
    before = {f["fact_id"]: dict(f) for f in facts.list_facts()}
    assert facts.fact_id_for("food_grade_silicone") not in before

    upload(MANUAL_TXT, "manual.txt")  # adds the material fact
    after = {f["fact_id"]: f for f in facts.list_facts()}

    material = facts.fact_id_for("food_grade_silicone")
    assert material in after, "the manual should introduce the material fact"

    # the capacity fact gained a second corroborating source but kept its value
    cap = facts.fact_id_for("capacity")
    assert after[cap]["value"] == before[cap]["value"] == "350"
    assert len(after[cap]["sources"]) == 2
    assert after[cap]["state"] == "needs_review"

    # a fact neither document mentions was not invented
    assert facts.fact_id_for("bpa_free") not in after


def test_verified_capacity_unblocks_only_the_capacity_claim():
    upload(SPEC_CSV, "spec.csv")
    client.post(
        f"/api/evidence/facts/{facts.fact_id_for('capacity')}/state",
        json={"state": "verified"},
    )

    result = client.post(
        "/api/evidence/gate",
        json={"drafts": [_draft("Travel Cup 350ml, BPA-Free")]},
    ).json()["data"]["results"][0]

    by_key = {c["fact_key"]: c for f in result["fields"] for c in f["claims"]}
    assert by_key["capacity"]["verdict"] == "ok"
    # the unrelated certification claim is untouched by verifying capacity
    assert by_key["bpa_free"]["verdict"] == "blocked"
    assert result["verdict"] == "blocked"


def test_a_verified_claim_exposes_its_supporting_source_location():
    upload(SPEC_CSV, "spec.csv")
    client.post(
        f"/api/evidence/facts/{facts.fact_id_for('capacity')}/state",
        json={"state": "verified"},
    )
    result = client.post(
        "/api/evidence/gate", json={"drafts": [_draft("Travel Cup 350ml")]}
    ).json()["data"]["results"][0]

    claim = result["fields"][0]["claims"][0]
    src = claim["supporting_sources"][0]
    assert src["source_id"]
    assert src["cell"].startswith("row ")
    assert "350" in src["excerpt"]
    assert src["method"] == "deterministic"


# --------------------------------------------------------------------------- #
# 3. Conflicting evidence blocks the dependent claim                           #
# --------------------------------------------------------------------------- #


def test_conflicting_sources_mark_the_fact_and_block_its_claim():
    upload(SPEC_CSV, "spec.csv")
    client.post(
        f"/api/evidence/facts/{facts.fact_id_for('capacity')}/state",
        json={"state": "verified"},
    )
    upload(CONFLICT_CSV, "conflict.csv")  # says 300 ml

    cap = {f["fact_id"]: f for f in facts.list_facts()}[facts.fact_id_for("capacity")]
    assert cap["state"] == "conflicting"
    assert len(cap["sources"]) == 2

    result = client.post(
        "/api/evidence/gate", json={"drafts": [_draft("Travel Cup 350ml")]}
    ).json()["data"]["results"][0]
    claim = result["fields"][0]["claims"][0]
    assert claim["verdict"] == "blocked"
    assert claim["state"] == "conflicting"
    assert "矛盾" in claim["detail"]


def test_a_conflict_does_not_contaminate_unrelated_facts():
    upload(MANUAL_TXT, "manual.txt")
    upload(CONFLICT_CSV, "conflict.csv")
    by_id = {f["fact_id"]: f for f in facts.list_facts()}

    assert by_id[facts.fact_id_for("capacity")]["state"] == "conflicting"
    # folded height and material agree across both documents
    assert by_id[facts.fact_id_for("folded_height")]["state"] == "needs_review"
    assert by_id[facts.fact_id_for("food_grade_silicone")]["state"] == "needs_review"


# --------------------------------------------------------------------------- #
# 4. Expired certification evidence is rejected                                #
# --------------------------------------------------------------------------- #


def test_expired_evidence_demotes_the_fact_and_blocks_the_claim():
    yesterday = (date.today() - timedelta(days=1)).isoformat()
    upload(MANUAL_TXT, "cert.txt", expires_on=yesterday)

    material = {f["fact_id"]: f for f in facts.list_facts()}[
        facts.fact_id_for("food_grade_silicone")
    ]
    assert material["state"] == "expired"

    result = client.post(
        "/api/evidence/gate",
        json={"drafts": [_draft("Cup", [{"field": "b1", "value": "Food-grade silicone body"}])]},
    ).json()["data"]["results"][0]
    claim = result["fields"][0]["claims"][0]
    assert claim["verdict"] == "blocked"
    assert claim["state"] == "expired"
    assert "过期" in claim["detail"]


def test_evidence_valid_in_the_future_is_not_treated_as_expired():
    tomorrow = (date.today() + timedelta(days=1)).isoformat()
    upload(MANUAL_TXT, "cert.txt", expires_on=tomorrow)
    material = {f["fact_id"]: f for f in facts.list_facts()}[
        facts.fact_id_for("food_grade_silicone")
    ]
    assert material["state"] == "needs_review"


def test_deleting_a_source_demotes_the_facts_it_supported():
    src = upload(SPEC_CSV, "spec.csv").json()["data"]["source"]
    client.post(
        f"/api/evidence/facts/{facts.fact_id_for('capacity')}/state",
        json={"state": "verified"},
    )
    assert client.delete(f"/api/evidence/sources/{src['source_id']}").status_code == 200

    cap = {f["fact_id"]: f for f in facts.list_facts()}[facts.fact_id_for("capacity")]
    assert cap["state"] == "unsupported"
    assert cap["sources"] == []


# --------------------------------------------------------------------------- #
# Separation of concerns + secret safety                                       #
# --------------------------------------------------------------------------- #


def test_evidence_checks_are_tagged_apart_from_policy_checks():
    """Policy validation and evidence validation must stay distinguishable."""
    policy_rows = client.post(
        "/api/listing/validate",
        json={"drafts": [_draft("Cup 350ml BPA-Free")], "product_name": "Cup", "points": ""},
    ).json()["data"]["drafts"][0]["checks"]
    evidence_rows = client.post(
        "/api/evidence/gate", json={"drafts": [_draft("Cup 350ml BPA-Free")]}
    ).json()["data"]["checks"]["amazon"]

    assert all(r.get("kind") != "evidence" for r in policy_rows)
    assert all(r["kind"] == "evidence" for r in evidence_rows)
    assert all(r["id"].startswith("evidence.") for r in evidence_rows)


def test_the_demo_dataset_reproduces_the_documented_scenarios(demo_evidence):
    """The bundled demo files must actually drive the states they promise."""
    upload((demo_evidence / "aerofold-spec.csv").read_bytes(), "aerofold-spec.csv")
    by_id = {f["fact_id"]: f for f in facts.list_facts()}
    assert by_id[facts.fact_id_for("capacity")]["value"] == "350"

    upload((demo_evidence / "conflicting-spec.csv").read_bytes(), "conflicting-spec.csv")
    by_id = {f["fact_id"]: f for f in facts.list_facts()}
    assert by_id[facts.fact_id_for("capacity")]["state"] == "conflicting"

    # no demo file supports BPA-Free — that is the point of the dataset
    assert facts.fact_id_for("bpa_free") not in by_id


def test_upload_logs_never_contain_file_contents(caplog):
    import logging

    secret = b"capacity,350 ml\nINTERNAL-SUPPLIER-CODE-DO-NOT-LEAK\n"
    with caplog.at_level(logging.DEBUG):
        upload(secret, "spec.csv")
    blob = "\n".join(r.getMessage() for r in caplog.records)
    assert "INTERNAL-SUPPLIER-CODE" not in blob
    assert "sk-" not in blob


# --------------------------------------------------------------------------- #
# The SKU truth source is gated even when generated copy omits the claim       #
# --------------------------------------------------------------------------- #


def test_a_claim_in_the_sku_source_is_gated_even_if_no_platform_repeats_it():
    """One truth source means a claim cannot escape by not being echoed.

    The demo Amazon draft never writes "BPA-Free" in its own copy — the claim
    lives in the operator's selling points. It must still be blocked.
    """
    r = client.post(
        "/api/evidence/gate",
        json={
            "drafts": [_draft("Collapsible Silicone Travel Cup 350ml")],
            "source_points": "折叠到 4cm\nBPA-Free\n适合徒步",
        },
    )
    result = r.json()["data"]["results"][0]
    assert result["verdict"] == "blocked"

    src_field = next(f for f in result["fields"] if f["field"] == "sku:selling-points")
    bpa = next(c for c in src_field["claims"] if c["fact_key"] == "bpa_free")
    assert bpa["verdict"] == "blocked"
    assert bpa["state"] == "unsupported"


def test_source_points_without_a_claim_add_no_findings():
    r = client.post(
        "/api/evidence/gate",
        json={
            "drafts": [_draft("Pocket Cup")],
            "source_points": "口袋能装\n适合通勤",
        },
    )
    result = r.json()["data"]["results"][0]
    assert result["verdict"] == "ok"
    assert result["claim_count"] == 0


def test_a_deleted_document_stops_contributing_to_conflicts():
    """Deleting a source must erase its values, not merely hide them.

    Hiding at read time left the stored link in place, so a removed document
    kept contradicting every future upload.
    """
    upload(SPEC_CSV, "spec.csv")            # 350 ml
    bad = upload(CONFLICT_CSV, "bad.csv").json()["data"]["source"]   # 300 ml
    assert {f["fact_id"]: f for f in facts.list_facts()}[
        facts.fact_id_for("capacity")
    ]["state"] == "conflicting"

    client.delete(f"/api/evidence/sources/{bad['source_id']}")

    cap = {f["fact_id"]: f for f in facts.list_facts()}[facts.fact_id_for("capacity")]
    assert cap["state"] == "needs_review"
    assert cap["value"] == "350"
    assert [s["source_id"] for s in cap["sources"]] != [bad["source_id"]]

    # and a fresh upload of the same value does not re-trigger the conflict
    upload(MANUAL_TXT, "manual.txt")
    cap = {f["fact_id"]: f for f in facts.list_facts()}[facts.fact_id_for("capacity")]
    assert cap["state"] == "needs_review"


def test_ingest_ignores_links_to_documents_that_no_longer_exist():
    """An orphaned link must not keep contradicting new uploads.

    Simulates a ledger left behind by an older code path: the link is present
    but its document is not in the store.
    """
    from evidence.facts import _write_ledger, read_ledger

    upload(SPEC_CSV, "spec.csv")
    ledger = read_ledger()
    cap = ledger["facts"][facts.fact_id_for("capacity")]
    cap["sources"].append(
        {"source_id": "ghost0000000000", "value": "300", "excerpt": "", "method": "deterministic"}
    )
    cap["state"] = "conflicting"
    _write_ledger(ledger)

    upload(MANUAL_TXT, "manual.txt")  # re-ingest triggers the self-heal
    cap = {f["fact_id"]: f for f in facts.list_facts()}[facts.fact_id_for("capacity")]
    assert cap["state"] == "needs_review"
    assert all(s["source_id"] != "ghost0000000000" for s in cap["sources"])
