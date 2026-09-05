"""Storyboard: per-shot state, honest progress, and no imaginary final film.

The assertions that matter are the ones about not overclaiming: a package
without a composition step says so, a retry does not re-pay for successful
shots, a cancelled run refuses late results, and progress is a count of real
outcomes rather than a percentage.

No provider is contacted. Shot results are recorded through the same API a real
provider callback would use.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import passport
import review
import storyboard
from app import app

client = TestClient(app)

SKU = "AERO-350"


def board() -> dict:
    return storyboard.create(SKU, platform="tiktok")


def run_all(board_id: str) -> str:
    return storyboard.start_run(board_id, confirmed=True)["run_token"]


# --------------------------------------------------------------------------- #
# Structure                                                                    #
# --------------------------------------------------------------------------- #


def test_the_default_structure_is_the_four_beat_fifteen_seconds():
    shots = storyboard.default_shots()
    assert [s["beat"] for s in shots] == ["hook", "demo", "benefit", "closing"]
    assert shots[0]["start_s"] == 0.0
    assert shots[-1]["end_s"] == 15.0
    assert storyboard.validate_shots(shots)["total_seconds"] == 15.0


def test_each_shot_carries_the_fields_the_spec_names():
    shot = storyboard.default_shots()[0]
    for key in (
        "start_s", "end_s", "duration_s", "instruction", "fact_ids",
        "source_image_asset_id", "overlay_text", "narration", "platform", "status",
    ):
        assert key in shot, key


def test_a_shot_references_facts_by_id_rather_than_quoting_them():
    """So a withdrawn fact cannot linger as copy inside a shot."""
    shot = storyboard.default_shots()[0]
    assert isinstance(shot["fact_ids"], list)
    assert "fact_text" not in shot


def test_the_timeline_is_validated():
    shots = storyboard.default_shots()
    shots[1]["duration_s"] = 0.2
    problems = storyboard.validate_shots(storyboard.retimeline(shots))["problems"]
    assert any("短于" in p for p in problems)

    long_shots = storyboard.retimeline([dict(s, duration_s=15.0) for s in shots * 2])
    assert any("超过" in p for p in storyboard.validate_shots(long_shots)["problems"])


def test_reordering_keeps_the_timeline_continuous():
    shots = storyboard.default_shots()
    reordered = storyboard.retimeline([shots[3], shots[0], shots[1], shots[2]])

    assert reordered[0]["start_s"] == 0.0
    for previous, current in zip(reordered, reordered[1:]):
        assert current["start_s"] == previous["end_s"]


def test_editing_shots_preserves_a_clip_that_was_already_generated():
    created = board()
    token = run_all(created["storyboard_id"])
    storyboard.record_shot_result(
        created["storyboard_id"], "shot-1", run_token=token,
        status=storyboard.SUCCEEDED, result_url="https://example/clip1.mp4",
    )

    edited = storyboard.update_shots(
        created["storyboard_id"],
        [
            {"shot_id": "shot-1", "duration_s": 3.0, "overlay_text": "改了文案"},
            {"shot_id": "shot-2", "duration_s": 5.0},
        ],
    )

    first = edited["shots"][0]
    assert first["overlay_text"] == "改了文案"
    assert first["status"] == storyboard.SUCCEEDED
    assert first["result_url"] == "https://example/clip1.mp4"


# --------------------------------------------------------------------------- #
# Cost is stated before it is incurred                                         #
# --------------------------------------------------------------------------- #


def test_the_exact_model_call_count_is_known_before_generating():
    created = board()
    plan = storyboard.plan_generation(created["storyboard_id"])

    assert plan["expected_model_calls"] == 4
    assert plan["requires_confirmation"] is True
    assert plan["blocked"] is False


def test_more_than_one_paid_call_requires_explicit_confirmation():
    created = board()
    with pytest.raises(storyboard.StoryboardError) as exc:
        storyboard.start_run(created["storyboard_id"])
    assert exc.value.code == "confirmation_required"
    assert exc.value.http_status == 428


def test_a_single_shot_retry_costs_one_call_and_needs_no_confirmation():
    created = board()
    plan = storyboard.plan_generation(created["storyboard_id"], only=["shot-2"])

    assert plan["expected_model_calls"] == 1
    assert plan["requires_confirmation"] is False


def test_an_invalid_timeline_blocks_generation_entirely():
    created = board()
    storyboard.update_shots(created["storyboard_id"], [{"shot_id": "shot-1", "duration_s": 0.1}])
    with pytest.raises(storyboard.StoryboardError) as exc:
        storyboard.start_run(created["storyboard_id"], confirmed=True)
    assert exc.value.code == "invalid_timeline"


# --------------------------------------------------------------------------- #
# Per-shot state and retry                                                     #
# --------------------------------------------------------------------------- #


def test_retrying_one_failed_shot_does_not_regenerate_the_successful_ones():
    created = board()
    board_id = created["storyboard_id"]
    token = run_all(board_id)
    for shot_id in ("shot-1", "shot-2", "shot-3"):
        storyboard.record_shot_result(
            board_id, shot_id, run_token=token, status=storyboard.SUCCEEDED,
            result_url=f"https://example/{shot_id}.mp4",
        )
    storyboard.record_shot_result(
        board_id, "shot-4", run_token=token, status=storyboard.FAILED, error="provider timeout"
    )

    plan = storyboard.plan_generation(board_id)

    assert plan["shots_to_generate"] == ["shot-4"]
    assert plan["expected_model_calls"] == 1
    assert set(plan["skipped_already_succeeded"]) == {"shot-1", "shot-2", "shot-3"}


def test_a_retry_keeps_the_earlier_results_intact():
    created = board()
    board_id = created["storyboard_id"]
    first_token = run_all(board_id)
    storyboard.record_shot_result(
        board_id, "shot-1", run_token=first_token, status=storyboard.SUCCEEDED,
        result_url="https://example/one.mp4",
    )
    storyboard.record_shot_result(
        board_id, "shot-2", run_token=first_token, status=storyboard.FAILED, error="boom"
    )

    second_token = storyboard.start_run(board_id, only=["shot-2"], confirmed=True)["run_token"]
    storyboard.record_shot_result(
        board_id, "shot-2", run_token=second_token, status=storyboard.SUCCEEDED,
        result_url="https://example/two.mp4",
    )

    final = storyboard.get(board_id)
    by_id = {s["shot_id"]: s for s in final["shots"]}
    assert by_id["shot-1"]["result_url"] == "https://example/one.mp4"
    assert by_id["shot-2"]["result_url"] == "https://example/two.mp4"
    assert by_id["shot-2"]["attempts"] == 2


def test_progress_counts_real_outcomes_and_invents_no_percentage():
    created = board()
    board_id = created["storyboard_id"]
    token = run_all(board_id)
    storyboard.record_shot_result(
        board_id, "shot-1", run_token=token, status=storyboard.SUCCEEDED, result_url="u"
    )
    storyboard.record_shot_result(
        board_id, "shot-2", run_token=token, status=storyboard.SUCCEEDED, result_url="u"
    )

    state = storyboard.progress(board_id)

    assert state["succeeded"] == 2
    assert state["total"] == 4
    assert state["label"] == "分镜 2/4 已生成"
    assert state["complete"] is False
    assert "%" not in state["label"]


# --------------------------------------------------------------------------- #
# Cancellation                                                                 #
# --------------------------------------------------------------------------- #


def test_a_result_arriving_after_cancellation_is_refused():
    created = board()
    board_id = created["storyboard_id"]
    token = run_all(board_id)
    storyboard.cancel_run(board_id)

    outcome = storyboard.record_shot_result(
        board_id, "shot-1", run_token=token, status=storyboard.SUCCEEDED, result_url="late.mp4"
    )

    assert outcome["accepted"] is False
    assert outcome["reason"] == "stale_run"
    assert storyboard.get(board_id)["shots"][0]["result_url"] == ""


def test_a_result_from_a_superseded_run_is_refused():
    created = board()
    board_id = created["storyboard_id"]
    old_token = run_all(board_id)
    storyboard.cancel_run(board_id)
    storyboard.start_run(board_id, confirmed=True)

    outcome = storyboard.record_shot_result(
        board_id, "shot-1", run_token=old_token, status=storyboard.SUCCEEDED, result_url="stale.mp4"
    )
    assert outcome["accepted"] is False


def test_cancelling_marks_in_flight_shots_cancelled_not_failed():
    created = board()
    board_id = created["storyboard_id"]
    run_all(board_id)
    cancelled = storyboard.cancel_run(board_id)

    assert all(s["status"] == storyboard.CANCELLED for s in cancelled["shots"])
    assert storyboard.progress(board_id)["cancelled"] is True


# --------------------------------------------------------------------------- #
# Provider handles                                                             #
# --------------------------------------------------------------------------- #


def test_a_provider_task_id_is_stored_only_if_it_is_an_opaque_handle():
    created = board()
    board_id = created["storyboard_id"]
    token = run_all(board_id)

    storyboard.record_shot_result(
        board_id, "shot-1", run_token=token, status=storyboard.SUCCEEDED,
        result_url="u", provider_task_id="task_abc-123",
    )
    storyboard.record_shot_result(
        board_id, "shot-2", run_token=token, status=storyboard.SUCCEEDED,
        result_url="u", provider_task_id="https://api.example/v1?key=sk-secret",
    )

    shots = {s["shot_id"]: s for s in storyboard.get(board_id)["shots"]}
    assert shots["shot-1"]["provider_task_id"] == "task_abc-123"
    # A URL could carry a credential, so it is not stored at all.
    assert shots["shot-2"]["provider_task_id"] == ""
    assert "sk-secret" not in str(storyboard.get(board_id))


# --------------------------------------------------------------------------- #
# Subtitles and narration                                                      #
# --------------------------------------------------------------------------- #


def test_webvtt_and_srt_are_generated_from_approved_copy():
    shots = storyboard.retimeline(
        [
            dict(storyboard.default_shots()[0], overlay_text="折叠到 4cm", narration="放进口袋就走"),
            dict(storyboard.default_shots()[1], overlay_text="食品级硅胶"),
        ]
    )
    vtt = storyboard.to_webvtt(shots)
    srt = storyboard.to_srt(shots)

    assert vtt.startswith("WEBVTT")
    assert "00:00:00.000 --> 00:00:03.000" in vtt
    assert "折叠到 4cm" in vtt and "放进口袋就走" in vtt
    assert "00:00:00,000 --> 00:00:03,000" in srt


def test_a_shot_with_no_copy_produces_no_caption_cue():
    vtt = storyboard.to_webvtt(storyboard.default_shots())
    assert vtt.strip() == "WEBVTT"


def test_narration_is_exported_as_text_when_tts_is_unconfigured():
    shots = storyboard.retimeline(
        [dict(storyboard.default_shots()[0], narration="放进口袋就走")]
    )
    assert "放进口袋就走" in storyboard.narration_script(shots)
    capability = storyboard.tts_capability()
    assert capability["available"] is False
    assert "不假装" in capability["note"]


# --------------------------------------------------------------------------- #
# Composition is never claimed without evidence                                #
# --------------------------------------------------------------------------- #


def test_without_ffmpeg_the_package_says_no_film_was_composed():
    created = board()
    package = storyboard.content_package(created["storyboard_id"])

    assert package["final_video"] is None
    assert package["composed"] is False
    assert "未合成最终成片" in package["note"]


def test_compose_refuses_rather_than_producing_a_broken_file(monkeypatch, tmp_path):
    monkeypatch.setattr(storyboard, "ffmpeg_path", lambda: "")
    result = storyboard.compose([tmp_path / "a.mp4"], tmp_path / "out.mp4")

    assert result["composed"] is False
    assert result["reason"] == "ffmpeg_unavailable"
    assert not (tmp_path / "out.mp4").exists()


def test_compose_refuses_a_missing_clip(monkeypatch, tmp_path):
    monkeypatch.setattr(storyboard, "ffmpeg_path", lambda: "/usr/bin/true")
    result = storyboard.compose([tmp_path / "nope.mp4"], tmp_path / "out.mp4")

    assert result["composed"] is False
    assert result["reason"] == "missing_clip"


def test_compose_refuses_an_oversized_clip(monkeypatch, tmp_path):
    monkeypatch.setattr(storyboard, "ffmpeg_path", lambda: "/usr/bin/true")
    monkeypatch.setattr(storyboard, "MAX_CLIP_BYTES", 10)
    clip = tmp_path / "big.mp4"
    clip.write_bytes(b"x" * 100)

    result = storyboard.compose([clip], tmp_path / "out.mp4")
    assert result["composed"] is False
    assert result["reason"] == "clip_too_large"


def test_the_compose_command_is_a_fixed_argument_list_with_no_shell(monkeypatch, tmp_path):
    """A filename must never be able to become a flag or a command."""
    captured: dict = {}

    def fake_run(args, **kwargs):
        captured["args"] = args
        captured["kwargs"] = kwargs

        class Result:
            returncode = 1

        return Result()

    clip = tmp_path / "a.mp4"
    clip.write_bytes(b"data")
    monkeypatch.setattr(storyboard, "ffmpeg_path", lambda: "/usr/bin/ffmpeg")
    monkeypatch.setattr(storyboard.subprocess, "run", fake_run)

    storyboard.compose([clip], tmp_path / "out.mp4")

    assert isinstance(captured["args"], list)
    assert captured["kwargs"].get("shell") in (None, False)
    assert captured["args"][0] == "/usr/bin/ffmpeg"


def test_an_unverifiable_output_is_deleted_rather_than_shipped(monkeypatch, tmp_path):
    clip = tmp_path / "a.mp4"
    clip.write_bytes(b"data")
    output = tmp_path / "out.mp4"

    def fake_run(args, **kwargs):
        output.write_bytes(b"not really a video")

        class Result:
            returncode = 0

        return Result()

    monkeypatch.setattr(storyboard, "ffmpeg_path", lambda: "/usr/bin/ffmpeg")
    monkeypatch.setattr(storyboard.subprocess, "run", fake_run)
    monkeypatch.setattr(storyboard, "_probe", lambda p: {"playable": False, "duration_s": None})

    result = storyboard.compose([clip], output)

    assert result["composed"] is False
    assert result["reason"] == "unplayable"
    assert not output.exists()


# --------------------------------------------------------------------------- #
# Content package and passport                                                 #
# --------------------------------------------------------------------------- #


def test_the_package_lists_clips_captions_narration_and_what_is_missing():
    created = board()
    board_id = created["storyboard_id"]
    token = run_all(board_id)
    storyboard.record_shot_result(
        board_id, "shot-1", run_token=token, status=storyboard.SUCCEEDED, result_url="c1.mp4"
    )

    package = storyboard.content_package(board_id)

    assert package["manifest"]["generated_clips"] == 1
    assert set(package["manifest"]["missing_clips"]) == {"shot-2", "shot-3", "shot-4"}
    assert package["captions"]["webvtt"].startswith("WEBVTT")
    assert package["narration"]["audio"] is None
    assert package["manifest"]["final_video"] is None


def test_the_release_passport_carries_the_content_package_state():
    review_revision = review.create_revision(
        sku_id=SKU,
        platform="amazon",
        content={
            "title": "Collapsible Travel Cup with Leakproof Lid and Carry Loop",
            "fields": [{"label": f"五点 {i}", "value": f"point {i}"} for i in range(1, 6)],
        },
    )
    review.submit_for_validation(review_revision["revision_id"])
    review.approve(review_revision["revision_id"], operator="lottie")
    board()

    record = passport.build(SKU, "amazon")
    packages = record["content_packages"]

    assert len(packages) == 1
    assert packages[0]["composed"] is False
    assert packages[0]["shot_count"] == 4
    assert "未合成最终成片" in packages[0]["note"]


# --------------------------------------------------------------------------- #
# HTTP surface                                                                 #
# --------------------------------------------------------------------------- #


def test_the_run_endpoint_refuses_without_confirmation():
    created = client.post("/api/storyboard", json={"sku_id": SKU}).json()["data"]["storyboard"]
    res = client.post(f"/api/storyboard/{created['storyboard_id']}/run", json={})

    assert res.status_code == 428
    assert res.json()["error"] == "confirmation_required"


def test_the_plan_endpoint_states_the_call_count_before_running():
    created = client.post("/api/storyboard", json={"sku_id": SKU}).json()["data"]["storyboard"]
    data = client.post(f"/api/storyboard/{created['storyboard_id']}/plan", json={}).json()["data"]

    assert data["expected_model_calls"] == 4
    assert data["requires_confirmation"] is True


def test_the_progress_endpoint_reports_a_verifiable_sentence():
    created = client.post("/api/storyboard", json={"sku_id": SKU}).json()["data"]["storyboard"]
    board_id = created["storyboard_id"]
    token = client.post(f"/api/storyboard/{board_id}/run", json={"confirmed": True}).json()["data"]["run_token"]
    client.post(
        f"/api/storyboard/{board_id}/shots/shot-1/result",
        json={"run_token": token, "status": "succeeded", "result_url": "c.mp4"},
    )

    data = client.get(f"/api/storyboard/{board_id}/progress").json()["data"]
    assert data["label"] == "分镜 1/4 已生成"


def test_an_unknown_storyboard_is_a_404():
    assert client.get("/api/storyboard/sb-9999").status_code == 404
