"""Image compliance inspection, driven by locally generated image fixtures.

Nothing here contacts a provider. Every fixture is built with Pillow inside the
test, so the bytes under inspection are known exactly and the measurements can
be asserted rather than approximated.

The load-bearing assertions are the negative ones: a white-looking prompt does
not make a background white, an unverifiable rule does not become a pass, and a
rejected file leaves nothing behind.
"""

from __future__ import annotations

import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

import imagecheck
import mediaassets
from app import app

client = TestClient(app)


# --------------------------------------------------------------------------- #
# Fixtures, generated locally                                                  #
# --------------------------------------------------------------------------- #


def png(image: Image.Image) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()


def jpeg(image: Image.Image, quality: int = 92) -> bytes:
    buf = io.BytesIO()
    image.convert("RGB").save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


def white_product(size: tuple[int, int] = (1200, 1200)) -> Image.Image:
    """A pure-white frame with a dark blob in the middle: a compliant main image."""
    image = Image.new("RGB", size, (255, 255, 255))
    draw = ImageDraw.Draw(image)
    w, h = size
    draw.ellipse([w * 0.25, h * 0.25, w * 0.75, h * 0.75], fill=(40, 60, 90))
    return image


def coloured_background(size: tuple[int, int] = (1200, 1200)) -> Image.Image:
    image = Image.new("RGB", size, (34, 120, 200))
    draw = ImageDraw.Draw(image)
    w, h = size
    draw.ellipse([w * 0.25, h * 0.25, w * 0.75, h * 0.75], fill=(240, 240, 240))
    return image


def gradient_background(size: tuple[int, int] = (1200, 1200)) -> Image.Image:
    """A smooth horizontal gradient: no single background colour exists."""
    image = Image.new("RGB", size)
    draw = ImageDraw.Draw(image)
    for x in range(size[0]):
        shade = int(255 * x / size[0])
        draw.line([(x, 0), (x, size[1])], fill=(shade, shade, shade))
    return image


def transparent_product(size: tuple[int, int] = (1200, 1200)) -> Image.Image:
    image = Image.new("RGBA", size, (255, 255, 255, 0))
    draw = ImageDraw.Draw(image)
    w, h = size
    draw.ellipse([w * 0.25, h * 0.25, w * 0.75, h * 0.75], fill=(40, 60, 90, 255))
    return image


def results_by_kind(report: dict) -> dict[str, dict]:
    return {r["kind"]: r for r in report["results"]}


# --------------------------------------------------------------------------- #
# Decoding real bytes                                                          #
# --------------------------------------------------------------------------- #


def test_measurements_come_from_the_bytes_not_the_filename():
    data = png(white_product((1234, 567)))
    measured = imagecheck.decode(data)

    assert measured["format"] == "PNG"
    assert measured["mime_type"] == "image/png"
    assert measured["width"] == 1234
    assert measured["height"] == 567
    assert measured["size_bytes"] == len(data)
    assert measured["color_mode"] == "RGB"
    assert measured["has_alpha"] is False
    assert measured["sha256"] == __import__("hashlib").sha256(data).hexdigest()
    assert measured["method"] == imagecheck.DECODE_METHOD


def test_format_is_sniffed_so_a_png_named_jpg_is_still_a_png():
    measured = imagecheck.decode(png(white_product((800, 800))), declared_mime="")
    assert measured["format"] == "PNG"


def test_a_declared_type_that_the_bytes_contradict_is_rejected():
    with pytest.raises(imagecheck.ImageInspectionError) as exc:
        imagecheck.decode(png(white_product((800, 800))), declared_mime="image/jpeg")
    assert exc.value.code == "mime_mismatch"


def test_transparency_is_detected_from_the_actual_channel():
    opaque = imagecheck.decode(png(white_product((600, 600))))
    alpha = imagecheck.decode(png(transparent_product((600, 600))))

    assert opaque["has_alpha"] is False
    assert alpha["has_alpha"] is True
    assert alpha["color_mode"] == "RGBA"


def test_aspect_ratios_are_reduced_exactly():
    assert imagecheck.decode(png(white_product((1000, 1000))))["aspect_ratio"] == "1:1"
    assert imagecheck.decode(png(white_product((1080, 1920))))["aspect_ratio"] == "9:16"
    assert imagecheck.decode(png(white_product((1200, 900))))["aspect_ratio"] == "4:3"


def test_corrupt_and_truncated_input_is_refused_not_half_measured():
    good = png(white_product((900, 900)))

    for label, data in (
        ("truncated", good[: len(good) // 3]),
        ("garbage", b"\x89PNG\r\n\x1a\n" + b"\x00" * 64),
        ("not an image", b"this is a text file, not an image"),
        ("empty", b""),
    ):
        with pytest.raises(imagecheck.ImageInspectionError) as exc:
            imagecheck.decode(data)
        assert exc.value.code in (
            "corrupt_image",
            "unsupported_format",
            "empty_image",
        ), f"{label} -> {exc.value.code}"


def test_oversized_input_is_refused_before_it_is_decoded():
    with pytest.raises(imagecheck.ImageInspectionError) as exc:
        imagecheck.decode(b"\x00" * (imagecheck.MAX_IMAGE_BYTES + 1))
    assert exc.value.code == "image_too_large"
    assert exc.value.http_status == 413


def test_an_unsupported_but_valid_image_format_is_refused_clearly():
    buf = io.BytesIO()
    white_product((64, 64)).save(buf, format="PPM")
    with pytest.raises(imagecheck.ImageInspectionError) as exc:
        imagecheck.decode(buf.getvalue())
    assert exc.value.code == "unsupported_format"
    assert exc.value.http_status == 415


# --------------------------------------------------------------------------- #
# Background: measured from pixels                                             #
# --------------------------------------------------------------------------- #


def test_a_white_frame_measures_as_white_with_high_uniformity():
    background = imagecheck.sample_background(png(white_product()))

    assert background["background_rgb"] == [255, 255, 255]
    assert background["background_hex"] == "#ffffff"
    assert background["uniformity"] == 1.0
    assert background["sample_count"] > 0
    assert {r["band"] for r in background["sampled_regions"]} == {
        "top", "bottom", "left", "right"
    }
    assert background["method"] == imagecheck.BACKGROUND_METHOD


def test_a_coloured_frame_does_not_measure_as_white():
    background = imagecheck.sample_background(png(coloured_background()))

    assert background["background_rgb"] == [34, 120, 200]
    assert min(background["background_rgb"]) < 250


def test_a_gradient_background_reports_low_uniformity():
    """No single background colour exists, and the score must say so."""
    background = imagecheck.sample_background(png(gradient_background()))

    assert background["uniformity"] < 0.5
    assert background["confidence"] == background["uniformity"]


def test_transparency_is_flattened_onto_white_before_measuring():
    # A transparent corner is not evidence of a white background, but it must
    # also not read as black, which is what raw RGBA zeros would give.
    background = imagecheck.sample_background(png(transparent_product()))
    assert background["background_rgb"] == [255, 255, 255]


# --------------------------------------------------------------------------- #
# Rule evaluation against the versioned snapshot                               #
# --------------------------------------------------------------------------- #


def test_a_compliant_amazon_main_image_passes_the_measurable_rules():
    report = imagecheck.inspect(jpeg(white_product((1600, 1600))), "amazon")
    by_kind = results_by_kind(report)

    assert report["policy_snapshot_id"].startswith("amazon-us-")
    assert by_kind["image_white_background"]["state"] == imagecheck.PASS
    assert by_kind["image_format"]["state"] == imagecheck.PASS
    assert by_kind["image_min_dimensions"]["state"] == imagecheck.PASS
    assert by_kind["image_aspect_ratio"]["state"] == imagecheck.PASS
    assert by_kind["image_no_transparency"]["state"] == imagecheck.PASS


def test_a_non_white_background_fails_the_white_background_rule():
    # PNG, so the asserted colour is the colour that was drawn: JPEG would move
    # 34 to 33 and the test would be measuring the codec, not the inspector.
    report = imagecheck.inspect(png(coloured_background((1600, 1600))), "amazon")
    result = results_by_kind(report)["image_white_background"]

    assert result["state"] == imagecheck.FAIL
    assert report["summary"]["blocked"] is True
    # the record shows what was measured and what was required
    assert "(34, 120, 200)" in str(result["measured"])
    assert "250" in str(result["expected"])
    assert result["evidence"]["sample_count"] > 0
    assert result["method"] == imagecheck.BACKGROUND_METHOD


def test_a_gradient_background_fails_on_uniformity_even_when_it_is_bright():
    """Light grey that never settles is not a white background."""
    report = imagecheck.inspect(jpeg(gradient_background((1600, 1600))), "amazon")
    result = results_by_kind(report)["image_white_background"]

    assert result["state"] == imagecheck.FAIL
    assert result["evidence"]["uniformity"] < 0.95


def test_an_undersized_image_fails_the_dimension_rule_with_both_numbers():
    report = imagecheck.inspect(jpeg(white_product((400, 400))), "amazon")
    result = results_by_kind(report)["image_min_dimensions"]

    assert result["state"] == imagecheck.FAIL
    assert result["measured"] == "400×400"
    assert result["expected"] == "≥ 1000×1000"
    assert result["policy_snapshot_id"].startswith("amazon-us-")
    assert result["rule_id"] == "amazon.main_image.min_dimensions"


def test_a_non_square_image_only_warns_because_the_rule_is_a_warning():
    report = imagecheck.inspect(jpeg(white_product((1600, 1200))), "amazon")
    result = results_by_kind(report)["image_aspect_ratio"]

    assert result["state"] == imagecheck.WARNING
    assert report["summary"]["blocked"] is False


def test_transparency_is_reported_against_the_transparency_rule():
    report = imagecheck.inspect(png(transparent_product((1600, 1600))), "amazon")
    result = results_by_kind(report)["image_no_transparency"]

    assert result["state"] == imagecheck.WARNING
    assert "alpha" in str(result["measured"])


def test_unverifiable_rules_become_manual_review_and_never_a_pass():
    report = imagecheck.inspect(jpeg(white_product((1600, 1600))), "amazon")
    by_kind = results_by_kind(report)

    for kind in ("image_subject_coverage", "image_no_overlaid_text"):
        assert by_kind[kind]["state"] == imagecheck.MANUAL_REVIEW
        assert by_kind[kind]["method"] == "not-implemented"

    # a perfectly measurable image is still not "fully verified"
    assert report["summary"]["needs_manual_review"] is True
    assert report["summary"]["fully_verified"] is False


def test_branding_and_product_identity_are_never_claimed_as_verified():
    report = imagecheck.inspect(jpeg(white_product((1600, 1600))), "amazon")
    blob = str(report).lower()
    # nothing in the record may assert that a logo, text or identity check passed
    for result in report["results"]:
        if result["kind"] in imagecheck.MANUAL_KINDS:
            assert result["state"] != imagecheck.PASS
    assert "verified" not in blob or report["summary"]["fully_verified"] is False


def test_shopify_has_no_white_background_rule_but_still_reports_the_background():
    report = imagecheck.inspect(png(coloured_background((1200, 1200))), "shopify")
    kinds = {r["kind"] for r in report["results"]}

    assert "image_white_background" not in kinds
    assert report["summary"]["blocked"] is False
    # the measurement is still available to a reviewer
    assert report["background"]["background_rgb"] == [34, 120, 200]


def test_tiktok_grades_the_same_image_by_its_own_snapshot():
    report = imagecheck.inspect(jpeg(coloured_background((800, 800))), "tiktok")

    assert report["policy_snapshot_id"].startswith("tiktok-us-")
    by_kind = results_by_kind(report)
    assert by_kind["image_min_dimensions"]["state"] == imagecheck.PASS  # 600px floor
    assert by_kind["image_no_overlaid_text"]["state"] == imagecheck.MANUAL_REVIEW


def test_inspection_is_deterministic_for_the_same_bytes():
    data = jpeg(white_product((1600, 1600)))
    first = imagecheck.inspect(data, "amazon")
    second = imagecheck.inspect(data, "amazon")

    strip = lambda r: [  # noqa: E731 - local comparison helper
        {k: v for k, v in row.items()} for row in r["results"]
    ]
    assert strip(first) == strip(second)
    assert first["background"] == second["background"]


# --------------------------------------------------------------------------- #
# Asset store: generated and uploaded follow one model                         #
# --------------------------------------------------------------------------- #


def test_generated_and_uploaded_images_are_inspected_identically():
    data = jpeg(coloured_background((1600, 1600)))

    generated = mediaassets.put_asset(data, platform="amazon", origin=mediaassets.GENERATED)
    uploaded = mediaassets.put_asset(
        jpeg(coloured_background((1600, 1600))), platform="amazon", origin=mediaassets.UPLOADED
    )

    assert generated["results"] and uploaded["results"]
    assert [r["state"] for r in generated["results"]] == [r["state"] for r in uploaded["results"]]
    # a generated image gets no exemption from the white-background rule
    assert generated["summary"]["blocked"] is True


def test_a_rejected_image_leaves_nothing_in_the_ledger():
    before = mediaassets.read_ledger()

    with pytest.raises(imagecheck.ImageInspectionError):
        mediaassets.put_asset(b"not an image", platform="amazon")

    assert mediaassets.read_ledger() == before


def test_a_stored_asset_can_be_verified_against_its_recorded_checksum():
    record = mediaassets.put_asset(jpeg(white_product((1600, 1600))), platform="amazon")
    verified = mediaassets.verify_asset(record["asset_id"])

    assert verified["present"] is True
    assert verified["matches"] is True
    assert verified["sha256"] == record["sha256"]


def test_the_exact_inspected_bytes_can_be_read_back():
    data = jpeg(white_product((1600, 1600)))
    record = mediaassets.put_asset(data, platform="amazon")

    blob, mime = mediaassets.read_blob(record["asset_id"])
    assert blob == data
    assert mime == "image/jpeg"


# --------------------------------------------------------------------------- #
# HTTP surface                                                                 #
# --------------------------------------------------------------------------- #


def test_uploading_an_image_returns_its_measurements_and_verdicts():
    data = jpeg(white_product((1600, 1600)))
    res = client.post(
        "/api/media/assets/upload",
        files={"file": ("main.jpg", data, "image/jpeg")},
        data={"platform": "amazon"},
    )

    assert res.status_code == 200
    asset = res.json()["data"]["asset"]
    assert asset["measurements"]["width"] == 1600
    assert asset["origin"] == "uploaded"
    assert asset["summary"]["needs_manual_review"] is True


def test_uploading_a_corrupt_image_is_a_clean_rejection():
    res = client.post(
        "/api/media/assets/upload",
        files={"file": ("broken.png", b"\x89PNG\r\n\x1a\n" + b"\x00" * 32, "image/png")},
        data={"platform": "amazon"},
    )

    assert res.status_code in (400, 415)
    assert res.json()["error"] in ("corrupt_image", "unsupported_format")


def test_a_generated_data_url_is_registered_and_inspected():
    import base64

    data = jpeg(white_product((1600, 1600)))
    res = client.post(
        "/api/media/assets",
        json={
            "data_url": "data:image/jpeg;base64," + base64.b64encode(data).decode(),
            "platform": "amazon",
            "origin": "generated",
        },
    )

    assert res.status_code == 200
    asset = res.json()["data"]["asset"]
    assert asset["origin"] == "generated"
    assert asset["measurements"]["mime_type"] == "image/jpeg"


def test_the_server_refuses_to_fetch_an_arbitrary_url_on_the_callers_behalf():
    res = client.post(
        "/api/media/assets",
        json={"data_url": "http://169.254.169.254/latest/meta-data/", "platform": "amazon"},
    )

    assert res.status_code == 422
    assert res.json()["error"] == "unsupported_source"


def test_the_original_bytes_are_served_back_for_the_lightbox():
    data = jpeg(white_product((1600, 1600)))
    upload = client.post(
        "/api/media/assets/upload",
        files={"file": ("main.jpg", data, "image/jpeg")},
        data={"platform": "amazon"},
    )
    asset_id = upload.json()["data"]["asset"]["asset_id"]

    res = client.get(f"/api/media/assets/{asset_id}/original")
    assert res.status_code == 200
    assert res.headers["content-type"] == "image/jpeg"
    assert res.content == data


def test_an_unknown_asset_is_a_404():
    assert client.get("/api/media/assets/deadbeef/original").status_code == 404


def test_the_original_is_reachable_with_the_scope_in_the_url():
    """An <img src> cannot send headers, so the lightbox needs the query form."""
    data = jpeg(white_product((1600, 1600)))
    upload = client.post(
        "/api/media/assets/upload",
        files={"file": ("main.jpg", data, "image/jpeg")},
        data={"platform": "amazon"},
        headers={"X-Workspace-ID": "ws-alpha", "X-Product-ID": "prod-1"},
    )
    asset_id = upload.json()["data"]["asset"]["asset_id"]

    via_query = client.get(
        f"/api/media/assets/{asset_id}/original",
        params={"workspace": "ws-alpha", "product": "prod-1"},
    )
    assert via_query.status_code == 200
    assert via_query.content == data


def test_another_workspace_cannot_read_an_asset_it_did_not_store():
    data = jpeg(white_product((1600, 1600)))
    upload = client.post(
        "/api/media/assets/upload",
        files={"file": ("main.jpg", data, "image/jpeg")},
        data={"platform": "amazon"},
        headers={"X-Workspace-ID": "ws-alpha", "X-Product-ID": "prod-1"},
    )
    asset_id = upload.json()["data"]["asset"]["asset_id"]

    other = client.get(
        f"/api/media/assets/{asset_id}/original",
        params={"workspace": "ws-beta", "product": "prod-1"},
    )
    assert other.status_code == 404
