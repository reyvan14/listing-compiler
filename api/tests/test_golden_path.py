"""The whole lifecycle, end to end, through the real application.

One test walks the path the specification describes: a SKU with evidence, facts
extracted and approved, listings generated and inspected, copy edited and
re-approved, a storyboard, a Release Passport and its ZIP, feedback imported and
turned into a candidate, and finally a rollback that restores exactly.

Everything here is the shipped code. The only thing faked is the boundary a test
must never cross: no model, no marketplace, no OCR service, no network. Media
results are recorded through the same API a real provider callback would use.

The assertions are deliberately weighted toward what must *not* happen — an
approved revision must not be overwritten, a passport must not be ready while a
blocker stands, a package must not claim a film nobody composed.
"""

from __future__ import annotations

import io
import json
import zipfile

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

import feedback
import mediaassets
import passport
import review
import storyboard
from app import app
from evidence import facts as facts_module, store

client = TestClient(app)

SKU = "AERO-350"
PLATFORM = "amazon"

#: Copy with no evidence-bearing claim, so the evidence gate is exercised
#: separately from the rest of the path rather than blocking all of it.
TITLE_V1 = "Collapsible Travel Cup with Leakproof Lid and Carry Loop"
TITLE_V2 = "Collapsible Travel Cup with Leakproof Lid, Carry Loop and Wide Base"


def bullets(prefix: str = "point") -> list[dict[str, str]]:
    return [{"label": f"五点 {i}", "value": f"{prefix} {i}"} for i in range(1, 6)]


def white_png(size: int = 1600) -> bytes:
    image = Image.new("RGB", (size, size), (255, 255, 255))
    draw = ImageDraw.Draw(image)
    draw.ellipse([size * 0.3, size * 0.3, size * 0.7, size * 0.7], fill=(40, 60, 90))
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()


def test_the_full_lifecycle_holds_together():
    # 1. A SKU with a specification document ------------------------------- #
    store.put_source(
        filename="spec.txt",
        declared_mime="text/plain",
        data="Capacity: 350 ml\nFolded: 4 cm\n".encode(),
    )
    source_id = store.list_sources()[0]["source_id"]

    # 2. Extract, then approve, facts -------------------------------------- #
    extracted = client.post(f"/api/intake/sources/{source_id}/extract").json()["data"]
    assert extracted["candidates"], "the document should yield candidates"
    assert {c["review_state"] for c in extracted["candidates"]} == {"needs_review"}, (
        "extraction must never produce an approved fact"
    )

    capacity = next(c for c in extracted["candidates"] if c["key"] == "capacity")
    client.post(
        f"/api/intake/candidates/{capacity['candidate_id']}/review",
        json={"decision": "approved", "operator": "lottie"},
    )
    fact = next(f for f in facts_module.list_facts() if f["key"] == "capacity")
    assert fact["state"] == facts_module.NEEDS_REVIEW, (
        "approving a reading is not the same as verifying the claim"
    )
    facts_module.set_fact_state(fact["fact_id"], facts_module.VERIFIED)

    # 3. A platform listing becomes a reviewable revision ------------------- #
    created = client.post(
        "/api/review/revisions",
        json={
            "sku_id": SKU,
            "platform": PLATFORM,
            "content": {"title": TITLE_V1, "fields": bullets()},
            "product_name": "AeroFold Collapsible Travel Cup",
        },
    ).json()["data"]["revision"]
    revision_v1 = created["revision_id"]

    # 4. Pixel inspection of a real image ----------------------------------- #
    upload = client.post(
        "/api/media/assets/upload",
        files={"file": ("main.png", white_png(), "image/png")},
        data={"platform": PLATFORM, "revision_id": revision_v1},
    ).json()["data"]["asset"]
    assert upload["measurements"]["width"] == 1600
    assert upload["summary"]["needs_manual_review"] is True, (
        "subject coverage and overlaid text are never auto-passed"
    )

    # 5. Edit, diff, revalidate, approve ------------------------------------ #
    edited = client.post(
        f"/api/review/revisions/{revision_v1}/draft",
        json={"content": {"title": TITLE_V2, "fields": bullets()}, "operator": "lottie"},
    ).json()["data"]
    assert edited["forked"] is False, "a draft is edited in place"

    diff = client.get(
        "/api/review/diff", params={"base": revision_v1, "target": revision_v1}
    ).json()["data"]
    assert diff["identical"] is True

    validated = client.post(f"/api/review/revisions/{revision_v1}/validate", json={}).json()["data"]
    assert validated["revision"]["state"] == review.VALIDATED

    approved = client.post(
        f"/api/review/revisions/{revision_v1}/approve",
        json={"operator": "lottie", "reason": "内部复核通过"},
    ).json()["data"]
    assert approved["revision"]["state"] == review.APPROVED

    # 6. A four-shot storyboard, with clips recorded as a provider would ---- #
    board = client.post(
        "/api/storyboard", json={"sku_id": SKU, "platform": "tiktok"}
    ).json()["data"]["storyboard"]
    board_id = board["storyboard_id"]

    plan = client.post(f"/api/storyboard/{board_id}/plan", json={}).json()["data"]
    assert plan["expected_model_calls"] == 4
    assert plan["requires_confirmation"] is True

    refused = client.post(f"/api/storyboard/{board_id}/run", json={})
    assert refused.status_code == 428, "four paid calls need an explicit confirmation"

    token = client.post(
        f"/api/storyboard/{board_id}/run", json={"confirmed": True}
    ).json()["data"]["run_token"]
    for index in range(1, 5):
        client.post(
            f"/api/storyboard/{board_id}/shots/shot-{index}/result",
            json={
                "run_token": token,
                "status": "succeeded",
                "result_url": f"https://mock.invalid/clip{index}.mp4",
                "provider_task_id": f"task-{index}",
            },
        )
    progress = client.get(f"/api/storyboard/{board_id}/progress").json()["data"]
    assert progress["label"] == "分镜 4/4 已生成"
    assert "%" not in progress["label"]

    package = client.get(f"/api/storyboard/{board_id}/package").json()["data"]
    assert package["composed"] is False, "no FFmpeg here, so no film is claimed"
    assert package["final_video"] is None
    assert package["captions"]["webvtt"].startswith("WEBVTT")

    # 7. Release Passport and its ZIP --------------------------------------- #
    built = client.post(
        "/api/passport/build", json={"sku_id": SKU, "platform": PLATFORM}
    ).json()["data"]["passport"]
    assert built["revision_id"] == revision_v1
    assert built["readiness"] != passport.BLOCKED, built["readiness_reasons"]
    assert built["content_packages"], "the storyboard package travels with the passport"
    assert built["content_packages"][0]["composed"] is False

    unconfirmed = client.post(f"/api/passport/{built['passport_id']}/export", json={})
    assert unconfirmed.status_code == 428

    exported = client.post(
        f"/api/passport/{built['passport_id']}/export", json={"confirm": True}
    )
    assert exported.status_code == 200
    with zipfile.ZipFile(io.BytesIO(exported.content)) as zf:
        names = set(zf.namelist())
        assert {"manifest.json", "release-passport.json", "listing.md", "README.md"} <= names
        manifest = json.loads(zf.read("manifest.json"))
        for row in manifest["files"]:
            assert len(zf.read(row["path"])) == row["size_bytes"]
        readme = zf.read("README.md").decode("utf-8")
        assert "没有" in readme and "发布" in readme

    # 8. Records survive a reload: they live on the server, not in the page -- #
    reloaded = client.get(f"/api/review/revisions/{revision_v1}").json()["data"]
    assert reloaded["revision"]["state"] == review.APPROVED
    assert len(reloaded["history"]) == 1, "re-reading must not mint revisions"

    # 9. Feedback becomes a candidate, never an edit ------------------------ #
    header = ",".join(feedback.COLUMNS)
    rows = (
        f"{header}\n"
        f"{SKU},{PLATFORM},{revision_v1},2026-08-01,2026-08-14,50000,200,40,10,300,1,,,\n"
    ).encode()
    imported = client.post(
        "/api/feedback/import", files={"file": ("aug.csv", rows, "text/csv")}
    ).json()["data"]["import"]
    analysis = client.get(
        f"/api/feedback/imports/{imported['import_id']}/analysis"
    ).json()["data"]
    assert analysis["signals"], "50000 impressions at 0.4% CTR should register"
    assert analysis["live_integration"] is False

    promoted = client.post(
        f"/api/feedback/imports/{imported['import_id']}/promote",
        json={
            "signal_index": 0,
            "operator": "lottie",
            "content": {"title": f"{TITLE_V2} 350ml", "fields": bullets("improved")},
        },
    ).json()["data"]
    revision_v2 = promoted["revision"]["revision_id"]
    assert promoted["forked"] is True
    assert revision_v2 != revision_v1

    # 10. The approved revision was not overwritten, and rollback restores --- #
    still_approved = review.get_revision(revision_v1)
    assert still_approved["state"] == review.APPROVED
    assert still_approved["content"]["title"] == TITLE_V2, (
        "the feedback candidate must not have edited the approved copy"
    )

    # approve the candidate, then roll back to the earlier one
    client.post(f"/api/review/revisions/{revision_v2}/validate", json={})
    client.post(
        f"/api/review/revisions/{revision_v2}/approve",
        json={"operator": "lottie", "reason": "试一版更长的标题"},
    )
    assert review.get_revision(revision_v1)["state"] == review.SUPERSEDED

    rolled = client.post(
        f"/api/review/revisions/{revision_v1}/rollback",
        json={"operator": "lottie", "reason": "新标题表现不佳"},
    ).json()["data"]
    restored = rolled["revision"]

    assert restored["revision_id"] not in (revision_v1, revision_v2)
    assert restored["content"] == still_approved["content"], "rollback restores exactly"
    assert restored["state"] == review.APPROVED
    assert review.get_revision(revision_v2)["state"] == review.ROLLED_BACK
    # nothing was deleted along the way
    assert len(review.list_revisions(sku_id=SKU, platform=PLATFORM)) == 3


def test_the_passport_refuses_while_a_blocker_stands():
    """The same path, stopped where it should stop."""
    revision = review.create_revision(
        sku_id=SKU,
        platform="tiktok",
        content={"title": "🔥爆款 #summer 折叠水杯!!!", "fields": bullets()},
    )
    review.submit_for_validation(revision["revision_id"])

    with pytest.raises(review.ReviewError):
        review.approve(revision["revision_id"], operator="lottie")

    record = passport.build(SKU, "tiktok")
    assert record["readiness"] == passport.BLOCKED
    with pytest.raises(passport.PassportError):
        passport.build_package(record["passport_id"])


def test_a_failed_image_inspection_stops_the_handoff():
    revision = review.create_revision(
        sku_id=SKU, platform=PLATFORM, content={"title": TITLE_V1, "fields": bullets()}
    )
    review.submit_for_validation(revision["revision_id"])
    review.approve(revision["revision_id"], operator="lottie")

    blue = Image.new("RGB", (1600, 1600), (34, 120, 200))
    buf = io.BytesIO()
    blue.save(buf, format="PNG")
    mediaassets.put_asset(buf.getvalue(), platform=PLATFORM)

    record = passport.build(SKU, PLATFORM)
    assert record["readiness"] == passport.BLOCKED
    assert any("图片" in reason for reason in record["readiness_reasons"])
