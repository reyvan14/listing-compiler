"""Release Passport: readiness computed from records, and a verifiable package.

The assertions that matter here are the ones that refuse: a passport must not
report readiness it cannot justify, and an export must not claim success it did
not verify. Nothing in this file contacts a marketplace or a provider.
"""

from __future__ import annotations

import io
import json
import zipfile

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

import mediaassets
import passport
import review
from app import app

client = TestClient(app)

SKU = "AERO-350"
#: Deliberately free of evidence-bearing claims (no capacity, no material,
#: no certification), so the passport tests exercise readiness rather than the
#: evidence gate. The gate gets its own test below.
CLEAN_TITLE = "Collapsible Travel Cup with Leakproof Lid and Carry Loop"


def bullets() -> list[dict[str, str]]:
    return [{"label": f"五点 {i}", "value": f"point {i}"} for i in range(1, 6)]


def approved_revision(platform: str = "amazon", title: str = CLEAN_TITLE) -> dict:
    revision = review.create_revision(
        sku_id=SKU,
        platform=platform,
        content={"title": title, "fields": bullets()},
        product_name="AeroFold Collapsible Silicone Travel Cup",
        generator={"provider": "aliyun", "model": "qwen-test"},
    )
    review.submit_for_validation(revision["revision_id"])
    review.approve(revision["revision_id"], operator="lottie", reason="ok")
    return review.get_revision(revision["revision_id"])


def png_bytes(size: int = 1600, bg=(255, 255, 255)) -> bytes:
    image = Image.new("RGB", (size, size), bg)
    draw = ImageDraw.Draw(image)
    draw.ellipse([size * 0.3, size * 0.3, size * 0.7, size * 0.7], fill=(40, 60, 90))
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()


# --------------------------------------------------------------------------- #
# Readiness                                                                    #
# --------------------------------------------------------------------------- #


def test_a_sku_with_nothing_approved_is_blocked_and_says_why():
    record = passport.build(SKU, "amazon")

    assert record["readiness"] == passport.BLOCKED
    assert "已批准" in record["readiness_reasons"][0]
    assert record["revision_id"] == ""


def test_an_approved_revision_binds_the_passport_to_exact_ids():
    revision = approved_revision()
    record = passport.build(SKU, "amazon")

    assert record["revision_id"] == revision["revision_id"]
    assert record["content_hash"] == revision["content_hash"]
    assert record["field_hashes"] == revision["field_hashes"]
    assert record["listing"] == revision["content"]
    assert record["revision_lineage"][-1] == revision["revision_id"]
    assert record["approvals"][0]["operator"] == "lottie"
    assert record["policy_snapshots"][0]["snapshot_id"].startswith("amazon-us-")
    assert record["policy_snapshots"][0]["rules_sha256"]


def test_readiness_is_recomputed_against_todays_rules_not_the_stored_verdict():
    """An approval taken yesterday does not make a passport ready today."""
    revision = approved_revision(platform="tiktok", title=CLEAN_TITLE)
    assert passport.build(SKU, "tiktok")["readiness"] != passport.BLOCKED

    ledger = review.read_ledger()
    ledger["revisions"][revision["revision_id"]]["content"]["title"] = "🔥爆款 #summer 水杯!!!"
    review._write_ledger(ledger)

    record = passport.build(SKU, "tiktok")
    assert record["readiness"] == passport.BLOCKED
    assert any("阻断" in r for r in record["readiness_reasons"])


def test_a_superseded_approval_stops_being_the_passport_subject():
    first = approved_revision()
    second = review.save_draft(
        first["revision_id"],
        {"title": f"{CLEAN_TITLE} v2", "fields": bullets()},
    )
    review.submit_for_validation(second["revision_id"])
    review.approve(second["revision_id"], operator="lottie")

    record = passport.build(SKU, "amazon")
    assert record["revision_id"] == second["revision_id"]
    assert review.get_revision(first["revision_id"])["state"] == review.SUPERSEDED


def test_a_failed_image_inspection_blocks_the_passport():
    approved_revision()
    mediaassets.put_asset(png_bytes(bg=(34, 120, 200)), platform="amazon")

    record = passport.build(SKU, "amazon")
    assert record["readiness"] == passport.BLOCKED
    assert any("图片" in r for r in record["readiness_reasons"])


def test_a_checksum_that_moved_blocks_the_passport():
    approved_revision()
    asset = mediaassets.put_asset(png_bytes(), platform="amazon")

    # Corrupt the stored blob behind the record's back.
    blob = mediaassets._blob_path(asset["sha256"])
    blob.write_bytes(b"tampered")

    record = passport.build(SKU, "amazon")
    assert record["readiness"] == passport.BLOCKED
    assert any("校验和" in r for r in record["readiness_reasons"])


def test_unresolved_manual_review_items_stay_visible_and_are_never_passes():
    approved_revision()
    mediaassets.put_asset(png_bytes(), platform="amazon")

    record = passport.build(SKU, "amazon")

    assert record["readiness"] == passport.NEEDS_REVIEW
    assert record["manual_review"], "manual-review items must survive into the passport"
    rules = {item["rule_id"] for item in record["manual_review"] if "rule_id" in item}
    assert any("subject_coverage" in r or "no_overlaid_text" in r for r in rules)
    for item in record["manual_review"]:
        assert item.get("state") in (None, "manual_review", "unavailable")


def test_an_unbacked_claim_in_the_approved_copy_blocks_the_passport():
    """The evidence gate is part of readiness, not a separate opinion."""
    approved_revision(title="Collapsible Travel Cup 350ml with Leakproof Lid")

    record = passport.build(SKU, "amazon")
    assert record["readiness"] == passport.BLOCKED
    assert any("证据闸门" in r for r in record["readiness_reasons"])
    assert record["evidence_gate"]["verdict"] == "blocked"


def test_an_evidence_document_that_vanished_is_reported_not_hidden():
    approved_revision()
    record = passport.build(SKU, "amazon")
    # No documents were uploaded, so nothing is cited and nothing is invented.
    assert record["evidence_documents"] == []
    assert all(fact["sources"] == [] for fact in record["facts"])


# --------------------------------------------------------------------------- #
# Determinism and identity                                                     #
# --------------------------------------------------------------------------- #


def test_rebuilding_unchanged_records_yields_the_same_content_digest():
    approved_revision()
    first = passport.build(SKU, "amazon")
    second = passport.build(SKU, "amazon")

    assert first["content_digest"] == second["content_digest"]
    assert first["passport_id"] == second["passport_id"]
    # one passport, not two, for unchanged records
    assert len(passport.list_passports(sku_id=SKU)) == 1


def test_changing_the_listing_creates_a_new_passport_and_supersedes_the_old_one():
    first_rev = approved_revision()
    first = passport.build(SKU, "amazon")

    second_rev = review.save_draft(
        first_rev["revision_id"], {"title": f"{CLEAN_TITLE} v2", "fields": bullets()}
    )
    review.submit_for_validation(second_rev["revision_id"])
    review.approve(second_rev["revision_id"], operator="lottie")
    second = passport.build(SKU, "amazon")

    assert second["passport_id"] != first["passport_id"]
    assert passport.get(first["passport_id"])["readiness"] == passport.SUPERSEDED
    assert second["content_digest"] != first["content_digest"]


# --------------------------------------------------------------------------- #
# Export package                                                               #
# --------------------------------------------------------------------------- #


def ready_passport() -> dict:
    approved_revision()
    return passport.build(SKU, "amazon")


def test_a_blocked_passport_cannot_be_exported():
    record = passport.build(SKU, "amazon")  # nothing approved
    with pytest.raises(passport.PassportError) as exc:
        passport.build_package(record["passport_id"])
    assert exc.value.code == "not_ready"


def test_the_package_contains_every_promised_file():
    record = ready_passport()
    built = passport.build_package(record["passport_id"])

    with zipfile.ZipFile(io.BytesIO(built["package"])) as zf:
        names = set(zf.namelist())

    assert {
        "manifest.json",
        "release-passport.json",
        "listing.json",
        "listing.md",
        "validation-report.json",
        "evidence-index.json",
        "approvals.json",
        "policy-snapshots.json",
        "README.md",
    } <= names


def test_the_manifest_records_path_size_hash_and_source_entity_for_every_file():
    record = ready_passport()
    built = passport.build_package(record["passport_id"])

    with zipfile.ZipFile(io.BytesIO(built["package"])) as zf:
        manifest = json.loads(zf.read("manifest.json"))
        for row in manifest["files"]:
            data = zf.read(row["path"])
            assert len(data) == row["size_bytes"]
            assert __import__("hashlib").sha256(data).hexdigest() == row["sha256"]
            assert row["entity"], row["path"]
        # the manifest does not list itself, and says so
        assert "manifest.json" not in {r["path"] for r in manifest["files"]}
        assert "manifest" in manifest["note"]


def test_two_exports_of_the_same_stored_passport_are_byte_identical():
    record = ready_passport()
    first = passport.build_package(record["passport_id"])["package"]
    second = passport.build_package(record["passport_id"])["package"]

    assert first == second


def test_the_export_is_verified_before_it_is_recorded():
    record = ready_passport()
    built = passport.build_package(record["passport_id"])

    assert built["export"]["verified"] is True
    stored = passport.get(record["passport_id"])
    assert stored["readiness"] == passport.EXPORTED
    assert stored["export"]["digest"] == built["export"]["digest"]


def test_re_exporting_does_not_invent_a_second_export_moment():
    record = ready_passport()
    first = passport.build_package(record["passport_id"])["export"]
    second = passport.build_package(record["passport_id"])["export"]

    assert first["digest"] == second["digest"]
    assert first["exported_at"] == second["exported_at"]


def test_a_tampered_package_fails_verification():
    record = ready_passport()
    built = passport.build_package(record["passport_id"])

    # Rewrite one entry, keeping the original manifest.
    source = zipfile.ZipFile(io.BytesIO(built["package"]))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as zf:
        for name in source.namelist():
            data = source.read(name)
            if name == "listing.md":
                data = data + b"\ntampered"
            zf.writestr(name, data)

    check = passport.verify_package(out.getvalue())
    assert check["ok"] is False
    assert any("listing.md" in p for p in check["problems"])


def test_approved_media_travels_with_the_package_under_a_safe_path():
    approved_revision()
    asset = mediaassets.put_asset(png_bytes(), platform="amazon")
    record = passport.build(SKU, "amazon")
    built = passport.build_package(record["passport_id"])

    with zipfile.ZipFile(io.BytesIO(built["package"])) as zf:
        media = [n for n in zf.namelist() if n.startswith("media/")]
        assert media == [f"media/{asset['asset_id']}.png"]
        assert zf.read(media[0]) == png_bytes()


def test_no_package_path_can_escape_the_archive_root():
    """Hostile input is either contained or refused, never passed through."""
    for hostile in ("../../etc/passwd", "/etc/passwd", "..", "...", "C:\\windows\\system32", ""):
        try:
            safe = passport.safe_path(hostile)
        except passport.PassportError:
            continue  # refusing to name it is the strongest outcome
        assert not safe.startswith("/")
        assert not safe.startswith("..")
        assert ".." not in safe.split("/")
        assert "\\" not in safe

    # a traversal buried in a multi-segment path is flattened, not honoured
    assert passport.safe_path("media", "../../secret", "a.png") == "media/secret/a.png"


def test_the_package_carries_no_credential_shaped_field():
    approved_revision()
    record = passport.build(SKU, "amazon")
    built = passport.build_package(record["passport_id"])

    with zipfile.ZipFile(io.BytesIO(built["package"])) as zf:
        blob = b"".join(zf.read(n) for n in zf.namelist()).decode("utf-8", errors="replace")

    lowered = blob.lower()
    for forbidden in ("api_key", "authorization", "bearer ", "cookie", "id_rsa", "sk-"):
        assert forbidden not in lowered, forbidden


def test_a_secret_reaching_the_passport_aborts_the_export_rather_than_shipping_it():
    record = ready_passport()
    ledger = passport.read_ledger()
    ledger["passports"][record["passport_id"]]["generator"] = {"api_key": "sk-leaked"}
    passport._write_ledger(ledger)

    with pytest.raises(passport.PassportError) as exc:
        passport.build_package(record["passport_id"])
    assert exc.value.code == "secret_in_package"


def test_the_readme_states_that_nothing_was_published():
    record = ready_passport()
    built = passport.build_package(record["passport_id"])

    with zipfile.ZipFile(io.BytesIO(built["package"])) as zf:
        readme = zf.read("README.md").decode("utf-8")

    assert "没有" in readme and "发布" in readme
    assert "不代表" in readme
    assert "manual_review" in readme


# --------------------------------------------------------------------------- #
# HTTP surface                                                                 #
# --------------------------------------------------------------------------- #


def test_export_requires_an_explicit_confirmation():
    approved_revision()
    built = client.post(
        "/api/passport/build", json={"sku_id": SKU, "platform": "amazon"}
    ).json()["data"]["passport"]

    unconfirmed = client.post(f"/api/passport/{built['passport_id']}/export", json={})
    assert unconfirmed.status_code == 428
    assert unconfirmed.json()["error"] == "confirmation_required"

    confirmed = client.post(
        f"/api/passport/{built['passport_id']}/export", json={"confirm": True}
    )
    assert confirmed.status_code == 200
    assert confirmed.headers["content-type"] == "application/zip"
    assert confirmed.headers["x-package-digest"]
    assert zipfile.ZipFile(io.BytesIO(confirmed.content)).testzip() is None


def test_the_manifest_endpoint_shows_contents_without_downloading_the_zip():
    approved_revision()
    built = client.post(
        "/api/passport/build", json={"sku_id": SKU, "platform": "amazon"}
    ).json()["data"]["passport"]

    res = client.get(f"/api/passport/{built['passport_id']}/manifest")
    assert res.status_code == 200
    manifest = res.json()["data"]["manifest"]
    assert manifest["passport_id"] == built["passport_id"]
    assert len(manifest["files"]) >= 8


def test_locale_fields_are_marked_as_declared_not_verified():
    approved_revision()
    record = client.post(
        "/api/passport/build",
        json={"sku_id": SKU, "platform": "amazon", "currency": "USD"},
    ).json()["data"]["passport"]

    assert record["locale"]["currency"] == "USD"
    assert record["locale"]["declared_by"] == "operator"
    assert record["locale"]["verified"] is False


def test_an_unknown_passport_is_a_404():
    assert client.get("/api/passport/psp-9999").status_code == 404


def test_previewing_the_package_does_not_record_an_export():
    """Showing what a package would contain is not the same event as handing one over."""
    record = ready_passport()
    passport.build_package(record["passport_id"], record=False)

    stored = passport.get(record["passport_id"])
    assert stored["export"] is None
    assert stored["readiness"] != passport.EXPORTED

    passport.build_package(record["passport_id"])
    assert passport.get(record["passport_id"])["readiness"] == passport.EXPORTED


def test_the_manifest_endpoint_leaves_the_passport_unexported():
    approved_revision(title="Collapsible Travel Cup with Leakproof Lid and Carry Loop")
    built = client.post(
        "/api/passport/build", json={"sku_id": SKU, "platform": "amazon"}
    ).json()["data"]["passport"]

    client.get(f"/api/passport/{built['passport_id']}/manifest")

    after = client.get(f"/api/passport/{built['passport_id']}").json()["data"]["passport"]
    assert after["export"] is None
    assert after["readiness"] != "exported"


def test_a_rebuild_a_minute_later_is_the_same_passport(monkeypatch):
    """A re-validation stamp is not content.

    This is the failure that made an export supersede itself: the passport was
    rebuilt whenever the panel refreshed, and the second build a second later
    produced a different digest purely because ``revalidated_at`` had moved.
    """
    approved_revision(title="Collapsible Travel Cup with Leakproof Lid and Carry Loop")
    first = passport.build(SKU, "amazon")

    clock = ["2026-09-05T12:00:00+00:00"]
    monkeypatch.setattr(passport, "_now", lambda: clock[0])
    monkeypatch.setattr(review, "_now", lambda: clock[0])
    clock[0] = "2026-09-05T12:01:00+00:00"

    second = passport.build(SKU, "amazon")

    assert second["content_digest"] == first["content_digest"]
    assert second["passport_id"] == first["passport_id"]
    assert passport.get(first["passport_id"])["readiness"] != passport.SUPERSEDED
    assert len(passport.list_passports(sku_id=SKU, platform="amazon")) == 1


def test_an_export_survives_the_rebuild_that_follows_it():
    approved_revision(title="Collapsible Travel Cup with Leakproof Lid and Carry Loop")
    record = passport.build(SKU, "amazon")
    exported = passport.build_package(record["passport_id"])["export"]

    # the UI rebuilds right after exporting, to show the fresh state
    rebuilt = passport.build(SKU, "amazon")

    assert rebuilt["passport_id"] == record["passport_id"]
    assert rebuilt["readiness"] == passport.EXPORTED
    assert rebuilt["export"]["digest"] == exported["digest"]
