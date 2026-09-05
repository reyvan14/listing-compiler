"""Feedback Lab: deterministic statistics that refuse to claim causation.

Every fixture is a local CSV built inside the test. Nothing contacts a
marketplace, and no model is called. The assertions concentrate on the places
this kind of feature usually overreaches: a difference described as an effect,
an uplift predicted from two numbers, a suggestion applied to a live listing,
and a whole import lost to one malformed row.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import feedback
import review
from app import app

client = TestClient(app)

HEADER = ",".join(feedback.COLUMNS)


def csv_rows(*rows: str) -> bytes:
    return (HEADER + "\n" + "\n".join(rows) + "\n").encode("utf-8")


def row(
    *,
    sku="AERO-350",
    platform="amazon",
    revision="rev-0001",
    start="2026-08-01",
    end="2026-08-14",
    impressions="12000",
    clicks="180",
    atc="40",
    purchases="12",
    revenue="358.80",
    returns="0",
    reason="",
    review_text="",
    rating="",
) -> str:
    return ",".join(
        [sku, platform, revision, start, end, impressions, clicks, atc, purchases,
         revenue, returns, reason, review_text, rating]
    )


# --------------------------------------------------------------------------- #
# Import                                                                       #
# --------------------------------------------------------------------------- #


def test_the_template_parses_as_a_valid_import():
    parsed = feedback.parse_rows(feedback.TEMPLATE_CSV.encode())
    assert parsed["problems"] == []
    assert len(parsed["rows"]) == 3


def test_one_bad_row_does_not_lose_the_good_ones():
    data = csv_rows(
        row(revision="rev-0001"),
        row(revision="rev-0002", impressions="not-a-number"),
        row(revision="rev-0003"),
    )
    parsed = feedback.parse_rows(data)

    assert [r["revision_id"] for r in parsed["rows"]] == ["rev-0001", "rev-0003"]
    assert len(parsed["problems"]) == 1
    assert parsed["problems"][0]["line"] == 3
    assert "不是数字" in parsed["problems"][0]["message"]


@pytest.mark.parametrize(
    "bad,expected",
    [
        (row(platform="ebay"), "bad_platform"),
        (row(start="08/01/2026"), "bad_date"),
        (row(start="2026-08-20", end="2026-08-01"), "bad_period"),
        (row(clicks="99999"), "impossible_row"),
        (row(purchases="9999"), "impossible_row"),
        (row(impressions="-5"), "negative_value"),
        (row(sku=""), "missing_value"),
    ],
)
def test_each_kind_of_bad_row_is_reported_with_its_line(bad, expected):
    parsed = feedback.parse_rows(csv_rows(bad))
    assert parsed["rows"] == []
    assert parsed["problems"][0]["code"] == expected
    assert parsed["problems"][0]["line"] == 2


def test_a_file_missing_a_required_column_is_refused_whole():
    with pytest.raises(feedback.FeedbackError) as exc:
        feedback.parse_rows(b"sku,platform\nAERO-350,amazon\n")
    assert exc.value.code == "missing_columns"


def test_an_oversized_file_is_refused():
    with pytest.raises(feedback.FeedbackError) as exc:
        feedback.parse_rows(b"x" * (feedback.MAX_IMPORT_BYTES + 1))
    assert exc.value.code == "file_too_large"


def test_every_row_is_tied_to_an_exact_revision():
    parsed = feedback.parse_rows(csv_rows(row(revision="rev-0007")))
    assert parsed["rows"][0]["revision_id"] == "rev-0007"


def test_an_import_records_that_it_is_not_a_live_integration():
    record = feedback.create_import(csv_rows(row()), filename="aug.csv")
    assert record["live_integration"] is False
    assert "不是平台实时接口" in record["note"]


# --------------------------------------------------------------------------- #
# Metrics                                                                      #
# --------------------------------------------------------------------------- #


def test_rates_are_computed_deterministically():
    parsed = feedback.parse_rows(csv_rows(row(impressions="10000", clicks="200", purchases="10")))
    stats = feedback.aggregate(parsed["rows"])

    assert stats["ctr"] == 0.02
    assert stats["cvr"] == 0.05
    assert stats["period_start"] == "2026-08-01"
    assert stats["period_end"] == "2026-08-14"


def test_missing_inputs_produce_a_warning_rather_than_a_guess():
    parsed = feedback.parse_rows(csv_rows(row(purchases=""), row(purchases="5")))
    stats = feedback.aggregate(parsed["rows"])

    assert any("purchases" in w for w in stats["warnings"])
    assert stats["purchases"] == 5


def test_a_rate_with_no_denominator_is_none_not_zero():
    parsed = feedback.parse_rows(csv_rows(row(clicks="0", purchases="")))
    stats = feedback.aggregate(parsed["rows"])
    assert stats["cvr"] is None


# --------------------------------------------------------------------------- #
# Comparisons                                                                  #
# --------------------------------------------------------------------------- #


def test_a_comparison_reports_both_sample_sizes_and_both_windows():
    record = feedback.create_import(
        csv_rows(
            row(revision="rev-0001", start="2026-08-01", end="2026-08-14"),
            row(revision="rev-0002", start="2026-08-15", end="2026-08-28", clicks="400"),
        )
    )
    result = feedback.compare_revisions(record["import_id"], "rev-0001", "rev-0002")

    assert result["left_sample"]["impressions"] == 12000
    assert result["right_sample"]["impressions"] == 12000
    assert result["left_sample"]["window"] == ["2026-08-01", "2026-08-14"]
    assert result["right_sample"]["window"] == ["2026-08-15", "2026-08-28"]


def test_a_comparison_never_describes_a_difference_as_an_effect():
    record = feedback.create_import(
        csv_rows(row(revision="rev-0001"), row(revision="rev-0002", clicks="400"))
    )
    result = feedback.compare_revisions(record["import_id"], "rev-0001", "rev-0002")

    assert "不是因果结论" in result["causality_note"]
    blob = str(result)
    for forbidden in ("提升了", "带来了", "因为", "uplift", "caused"):
        assert forbidden not in blob


def test_a_small_sample_is_flagged_rather_than_reported_confidently():
    record = feedback.create_import(
        csv_rows(
            row(revision="rev-0001", impressions="100", clicks="5", purchases="1"),
            row(revision="rev-0002", impressions="120", clicks="9", purchases="2"),
        )
    )
    result = feedback.compare_revisions(record["import_id"], "rev-0001", "rev-0002")

    assert result["low_sample"] is True
    assert any("噪声" in w for w in result["warnings"])


def test_platform_and_period_comparisons_work_from_the_same_rows():
    record = feedback.create_import(
        csv_rows(
            row(platform="amazon", start="2026-08-01", end="2026-08-14"),
            row(platform="tiktok", start="2026-08-15", end="2026-08-28", clicks="300"),
        )
    )
    by_platform = feedback.compare_platforms(record["import_id"], "amazon", "tiktok")
    by_period = feedback.compare_periods(record["import_id"], "2026-08-15")

    assert by_platform["left"]["rows"] == 1 and by_platform["right"]["rows"] == 1
    assert by_period["left"]["rows"] == 1 and by_period["right"]["rows"] == 1


# --------------------------------------------------------------------------- #
# Signals                                                                      #
# --------------------------------------------------------------------------- #


def test_high_impressions_with_low_ctr_is_detected():
    parsed = feedback.parse_rows(
        csv_rows(row(impressions="50000", clicks="200", purchases="10"))
    )
    signals = feedback.detect_signals(parsed["rows"])

    found = next(s for s in signals if s["signal"] == "high_impressions_low_ctr")
    assert found["affected_field"] == "标题"
    assert found["supporting_rows"] == [2]
    assert "不是因果结论" in found["causality"]


def test_acceptable_ctr_with_low_cvr_is_detected():
    parsed = feedback.parse_rows(
        csv_rows(row(impressions="10000", clicks="500", purchases="5", returns="0"))
    )
    signals = feedback.detect_signals(parsed["rows"])

    assert any(s["signal"] == "acceptable_ctr_low_cvr" for s in signals)


def test_an_elevated_return_rate_is_detected():
    parsed = feedback.parse_rows(
        csv_rows(row(impressions="10000", clicks="300", purchases="20", returns="5"))
    )
    signals = feedback.detect_signals(parsed["rows"])

    found = next(s for s in signals if s["signal"] == "elevated_return_rate")
    assert found["confidence"] == "high"
    assert "退货" in found["risks"] or "物流" in found["risks"]


def test_a_repeated_theme_keeps_the_rows_and_quotes_it_came_from():
    parsed = feedback.parse_rows(
        csv_rows(
            row(reason="尺寸偏小", review_text="比想象中小"),
            row(reason="尺寸偏小", review_text="尺寸不对"),
        )
    )
    signals = feedback.detect_signals(parsed["rows"])

    theme = next(s for s in signals if s["signal"] == "repeated_theme")
    assert len(theme["supporting_rows"]) >= 2
    assert theme["quotes"]
    assert theme["confidence"] in ("low", "medium")


def test_a_signal_below_the_sample_floor_is_not_raised():
    parsed = feedback.parse_rows(csv_rows(row(impressions="200", clicks="1", purchases="0")))
    signals = feedback.detect_signals(parsed["rows"])
    assert not any(s["signal"] == "high_impressions_low_ctr" for s in signals)


def test_every_signal_carries_field_proposal_confidence_and_risks():
    parsed = feedback.parse_rows(
        csv_rows(row(impressions="50000", clicks="200", purchases="10", returns="4"))
    )
    for signal in feedback.detect_signals(parsed["rows"]):
        assert signal["affected_field"]
        assert signal["proposal"]
        assert signal["confidence"] in ("low", "medium", "high")
        assert signal["risks"]
        assert signal["supporting_rows"]
        assert signal["measurements"]


def test_no_signal_predicts_an_uplift():
    parsed = feedback.parse_rows(
        csv_rows(row(impressions="50000", clicks="200", purchases="2", returns="1"))
    )
    blob = str(feedback.detect_signals(parsed["rows"]))
    for forbidden in ("预计提升", "将提升", "expected uplift", "%提升"):
        assert forbidden not in blob


# --------------------------------------------------------------------------- #
# Candidates enter the review lifecycle                                        #
# --------------------------------------------------------------------------- #


def bullets() -> list[dict[str, str]]:
    return [{"label": f"五点 {i}", "value": f"point {i}"} for i in range(1, 6)]


def test_a_promoted_signal_forks_rather_than_overwriting_an_approved_revision():
    revision = review.create_revision(
        sku_id="AERO-350",
        platform="amazon",
        content={"title": "Collapsible Travel Cup with Leakproof Lid", "fields": bullets()},
    )
    review.submit_for_validation(revision["revision_id"])
    review.approve(revision["revision_id"], operator="lottie")

    record = feedback.create_import(
        csv_rows(row(revision=revision["revision_id"], impressions="50000", clicks="200"))
    )
    result = feedback.promote_signal(
        record["import_id"],
        0,
        operator="lottie",
        content={"title": "Collapsible Travel Cup 350ml Leakproof Lid", "fields": bullets()},
    )

    assert result["forked"] is True
    assert result["revision"]["state"] == review.DRAFT
    # the approved revision is untouched
    original = review.get_revision(revision["revision_id"])
    assert original["state"] == review.APPROVED
    assert original["content"]["title"] == "Collapsible Travel Cup with Leakproof Lid"


def test_promoting_requires_a_named_operator():
    record = feedback.create_import(csv_rows(row(impressions="50000", clicks="200")))
    with pytest.raises(feedback.FeedbackError) as exc:
        feedback.promote_signal(record["import_id"], 0, operator="", content={"title": "x", "fields": []})
    assert exc.value.code == "missing_operator"


def test_promoting_an_unknown_signal_is_a_404():
    record = feedback.create_import(csv_rows(row()))
    with pytest.raises(feedback.FeedbackError) as exc:
        feedback.promote_signal(record["import_id"], 99, operator="lottie", content={"title": "x", "fields": []})
    assert exc.value.code == "unknown_signal"


# --------------------------------------------------------------------------- #
# Experiments                                                                  #
# --------------------------------------------------------------------------- #


def test_an_experiment_records_the_full_design():
    experiment = feedback.create_experiment(
        hypothesis="把容量前置能提高点击率",
        baseline_revision_id="rev-0001",
        candidate_revision_id="rev-0002",
        changed_fields=["title"],
        start_date="2026-09-01",
        end_date="2026-09-14",
        primary_metric="ctr",
        guardrail_metrics=["return_rate"],
    )

    assert experiment["state"] == "draft"
    assert experiment["hypothesis"].startswith("把容量")
    assert experiment["changed_fields"] == ["title"]
    assert experiment["primary_metric"] == "ctr"
    assert experiment["guardrail_metrics"] == ["return_rate"]
    assert experiment["result"] is None


def test_an_experiment_needs_a_hypothesis_and_a_baseline():
    with pytest.raises(feedback.FeedbackError):
        feedback.create_experiment(hypothesis="", baseline_revision_id="rev-0001")
    with pytest.raises(feedback.FeedbackError):
        feedback.create_experiment(hypothesis="x", baseline_revision_id="")


def test_concluding_attaches_an_observation_and_refuses_to_call_it_a_cause():
    record = feedback.create_import(
        csv_rows(
            row(revision="rev-0001", clicks="180"),
            row(revision="rev-0002", clicks="400"),
        )
    )
    experiment = feedback.create_experiment(
        hypothesis="更短的标题更好",
        baseline_revision_id="rev-0001",
        candidate_revision_id="rev-0002",
    )
    concluded = feedback.conclude_experiment(experiment["experiment_id"], record["import_id"])

    assert concluded["state"] == "concluded"
    assert concluded["result"]["observed"]["deltas"]["ctr"]["absolute"] is not None
    assert "不做因果推断" in concluded["result"]["interpretation"]


def test_an_experiment_without_a_candidate_cannot_be_concluded():
    record = feedback.create_import(csv_rows(row()))
    experiment = feedback.create_experiment(hypothesis="x", baseline_revision_id="rev-0001")
    with pytest.raises(feedback.FeedbackError) as exc:
        feedback.conclude_experiment(experiment["experiment_id"], record["import_id"])
    assert exc.value.code == "missing_candidate"


def test_experiment_state_transitions_are_validated():
    experiment = feedback.create_experiment(hypothesis="x", baseline_revision_id="rev-0001")
    assert feedback.set_experiment_state(experiment["experiment_id"], "running")["state"] == "running"
    with pytest.raises(feedback.FeedbackError):
        feedback.set_experiment_state(experiment["experiment_id"], "victorious")


# --------------------------------------------------------------------------- #
# HTTP surface                                                                 #
# --------------------------------------------------------------------------- #


def test_the_template_downloads_as_csv():
    res = client.get("/api/feedback/template")
    assert res.status_code == 200
    assert "text/csv" in res.headers["content-type"]
    assert res.text.startswith("sku,platform,revision_id")


def test_importing_reports_both_accepted_rows_and_problems():
    res = client.post(
        "/api/feedback/import",
        files={"file": ("aug.csv", csv_rows(row(), row(impressions="oops")), "text/csv")},
    )
    record = res.json()["data"]["import"]

    assert res.status_code == 200
    assert record["row_count"] == 1
    assert record["problem_count"] == 1


def test_the_analysis_endpoint_returns_signals_and_disclaims_automation():
    upload = client.post(
        "/api/feedback/import",
        files={"file": ("aug.csv", csv_rows(row(impressions="50000", clicks="200")), "text/csv")},
    ).json()["data"]["import"]

    data = client.get(f"/api/feedback/imports/{upload['import_id']}/analysis").json()["data"]

    assert data["signals"]
    assert data["live_integration"] is False
    assert "不会自动修改" in data["note"]


def test_an_unknown_import_is_a_404():
    assert client.get("/api/feedback/imports/imp-9999/analysis").status_code == 404


def test_the_experiment_endpoints_round_trip():
    created = client.post(
        "/api/feedback/experiments",
        json={"hypothesis": "更短标题", "baseline_revision_id": "rev-0001"},
    ).json()["data"]["experiment"]

    listed = client.get("/api/feedback/experiments").json()["data"]["experiments"]
    assert [e["experiment_id"] for e in listed] == [created["experiment_id"]]

    updated = client.post(
        f"/api/feedback/experiments/{created['experiment_id']}/state", json={"state": "running"}
    ).json()["data"]["experiment"]
    assert updated["state"] == "running"
