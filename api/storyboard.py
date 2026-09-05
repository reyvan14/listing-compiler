"""Storyboard: a video you can check, shot by shot.

The old video node was one call and one opaque result. This replaces it with
shots you can read, reorder and re-run individually, and it is written around
one refusal: **nothing is described as done until it is.**

Concretely, that means the module will not say clips were merged unless a real
composition step produced a file it then validated; ``final_video`` stays null
otherwise and the package says why. Progress is "shot 2 of 4 succeeded",
counted from actual per-shot outcomes, never a timer or a percentage. The
expected number of paid model calls is computed and shown *before* generation,
and generating more than one costs an explicit confirmation.

Retrying one failed shot regenerates that shot. Successful shots keep their
results and are not paid for twice, which is the whole point of per-shot state.

Cancellation is enforced by a run token: a result that arrives after a cancel,
or after a newer run started, is dropped rather than written over the active
run's state.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from evidence import store

_LOCK = threading.RLock()
_SCHEMA = "listing-storyboard/v1"

# Shot status ---------------------------------------------------------------- #

PENDING = "pending"
GENERATING = "generating"
SUCCEEDED = "succeeded"
FAILED = "failed"
CANCELLED = "cancelled"

SHOT_STATES = (PENDING, GENERATING, SUCCEEDED, FAILED, CANCELLED)

MAX_SHOTS = 12
MAX_TOTAL_SECONDS = 60.0
MIN_SHOT_SECONDS = 1.0
MAX_SHOT_SECONDS = 15.0

#: The four-beat default the spec names, over 15 seconds.
DEFAULT_STRUCTURE = (
    ("hook", "开场钩子", 0.0, 3.0),
    ("demo", "产品演示", 3.0, 8.0),
    ("benefit", "证据支撑的卖点", 8.0, 12.0),
    ("closing", "收尾画面", 12.0, 15.0),
)


class StoryboardError(ValueError):
    def __init__(self, code: str, message: str, status: int = 400) -> None:
        self.code = code
        self.safe_message = message
        self.http_status = status
        super().__init__(message)


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


# --------------------------------------------------------------------------- #
# Shots                                                                        #
# --------------------------------------------------------------------------- #


def _shot(
    *,
    shot_id: str,
    beat: str,
    label: str,
    start: float,
    end: float,
    platform: str,
    instruction: str = "",
    overlay_text: str = "",
    narration: str = "",
    fact_ids: "list[str] | None" = None,
    source_image_asset_id: str = "",
) -> dict[str, Any]:
    return {
        "shot_id": shot_id,
        "beat": beat,
        "label": label,
        "start_s": round(float(start), 2),
        "end_s": round(float(end), 2),
        "duration_s": round(float(end) - float(start), 2),
        "instruction": instruction[:500],
        # Only ids here. The copy itself is resolved from the ledger at render
        # time, so a shot can never quote a fact that was later withdrawn.
        "fact_ids": list(fact_ids or []),
        "source_image_asset_id": source_image_asset_id,
        "overlay_text": overlay_text[:200],
        "narration": narration[:500],
        "platform": platform,
        "status": PENDING,
        "attempts": 0,
        "provider_task_id": "",
        "result_url": "",
        "error": "",
        "updated_at": _now(),
    }


def default_shots(*, platform: str = "tiktok") -> list[dict[str, Any]]:
    """The default 15-second structure: hook, demo, evidence-backed benefit, close."""
    return [
        _shot(
            shot_id=f"shot-{i + 1}",
            beat=beat,
            label=label,
            start=start,
            end=end,
            platform=platform,
        )
        for i, (beat, label, start, end) in enumerate(DEFAULT_STRUCTURE)
    ]


def validate_shots(shots: list[dict[str, Any]]) -> dict[str, Any]:
    """Check the timeline. Returns problems rather than raising, so the editor
    can show every issue at once instead of one at a time."""
    problems: list[str] = []
    if not shots:
        problems.append("分镜为空。")
    if len(shots) > MAX_SHOTS:
        problems.append(f"分镜数量超过 {MAX_SHOTS} 个上限。")

    total = 0.0
    previous_end: "float | None" = None
    for index, shot in enumerate(shots, start=1):
        duration = float(shot.get("duration_s") or 0)
        if duration < MIN_SHOT_SECONDS:
            problems.append(f"第 {index} 个分镜时长 {duration}s，短于 {MIN_SHOT_SECONDS}s。")
        if duration > MAX_SHOT_SECONDS:
            problems.append(f"第 {index} 个分镜时长 {duration}s，长于 {MAX_SHOT_SECONDS}s。")
        if previous_end is not None and abs(float(shot["start_s"]) - previous_end) > 0.01:
            problems.append(
                f"第 {index} 个分镜从 {shot['start_s']}s 开始，与上一镜结束的 {previous_end}s 不连续。"
            )
        previous_end = float(shot["end_s"])
        total += duration

    if total > MAX_TOTAL_SECONDS:
        problems.append(f"总时长 {total:.1f}s 超过 {MAX_TOTAL_SECONDS:.0f}s 上限。")

    return {
        "ok": not problems,
        "problems": problems,
        "total_seconds": round(total, 2),
        "shot_count": len(shots),
        # The exact number of paid model calls, shown before anything runs.
        "expected_model_calls": len(shots),
        "requires_confirmation": len(shots) > 1,
    }


def retimeline(shots: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Recompute start/end so a reorder or an edit leaves a continuous timeline."""
    cursor = 0.0
    out: list[dict[str, Any]] = []
    for shot in shots:
        duration = round(float(shot.get("duration_s") or 0), 2)
        row = dict(shot)
        row["start_s"] = round(cursor, 2)
        row["end_s"] = round(cursor + duration, 2)
        row["duration_s"] = duration
        cursor += duration
        out.append(row)
    return out


# --------------------------------------------------------------------------- #
# Subtitles                                                                    #
# --------------------------------------------------------------------------- #


def _timestamp(seconds: float, *, srt: bool) -> str:
    millis = int(round(seconds * 1000))
    hours, millis = divmod(millis, 3_600_000)
    minutes, millis = divmod(millis, 60_000)
    secs, millis = divmod(millis, 1000)
    sep = "," if srt else "."
    return f"{hours:02d}:{minutes:02d}:{secs:02d}{sep}{millis:03d}"


def _caption_text(shot: dict[str, Any]) -> str:
    """Overlay first, narration second. Only approved copy reaches a caption."""
    parts = [p for p in (shot.get("overlay_text", ""), shot.get("narration", "")) if p]
    return "\n".join(parts)


def to_webvtt(shots: list[dict[str, Any]]) -> str:
    lines = ["WEBVTT", ""]
    for index, shot in enumerate(shots, start=1):
        text = _caption_text(shot)
        if not text:
            continue
        lines.append(str(index))
        lines.append(
            f"{_timestamp(shot['start_s'], srt=False)} --> {_timestamp(shot['end_s'], srt=False)}"
        )
        lines.append(text)
        lines.append("")
    return "\n".join(lines)


def to_srt(shots: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    counter = 0
    for shot in shots:
        text = _caption_text(shot)
        if not text:
            continue
        counter += 1
        lines.append(str(counter))
        lines.append(
            f"{_timestamp(shot['start_s'], srt=True)} --> {_timestamp(shot['end_s'], srt=True)}"
        )
        lines.append(text)
        lines.append("")
    return "\n".join(lines)


def narration_script(shots: list[dict[str, Any]]) -> str:
    """Plain narration text, exported whether or not TTS is configured."""
    out: list[str] = []
    for index, shot in enumerate(shots, start=1):
        narration = shot.get("narration", "").strip()
        if narration:
            out.append(f"[{index}] {shot['start_s']:.1f}s-{shot['end_s']:.1f}s  {narration}")
    return "\n".join(out)


# --------------------------------------------------------------------------- #
# Optional adapters                                                            #
# --------------------------------------------------------------------------- #


def tts_capability() -> dict[str, Any]:
    """Whether a documented TTS adapter is configured. It is not, by default."""
    configured = bool((os.environ.get("LISTING_TTS_BASE_URL") or "").strip()) and bool(
        (os.environ.get("LISTING_TTS_API_KEY") or "").strip()
    )
    return {
        "available": configured,
        "provider": (os.environ.get("LISTING_TTS_PROVIDER") or "").strip(),
        "note": (
            "已配置 TTS 适配器。"
            if configured
            else "未配置 TTS：导出旁白文本与字幕文件，不生成语音，也不假装生成了。"
        ),
    }


def ffmpeg_path() -> str:
    configured = (os.environ.get("LISTING_FFMPEG_CMD") or "").strip()
    if configured:
        return configured if os.path.isfile(configured) else ""
    return shutil.which("ffmpeg") or ""


def composition_capability() -> dict[str, Any]:
    path = ffmpeg_path()
    return {
        "available": bool(path),
        "tool": "ffmpeg",
        "note": (
            "已检测到 FFmpeg，可尝试合成最终成片。"
            if path
            else "未安装 FFmpeg：交接包只包含各分镜片段与字幕，不会声称已合成成片。"
        ),
    }


#: Clip ceilings for composition. A concat of unbounded inputs is a DoS.
MAX_CLIP_BYTES = 64 * 1024 * 1024
MAX_COMPOSE_SECONDS = 120.0


def compose(clip_paths: list[Path], output: Path, *, timeout: float = 120.0) -> dict[str, Any]:
    """Concatenate validated clips with FFmpeg, or explain why nothing was made.

    Inputs are validated before use and the command is a fixed argument list
    with no shell — a filename can never become a flag or a command. Success
    means the output exists, is non-empty and probes as playable; anything else
    reports failure rather than leaving a broken file described as a video.
    """
    tool = ffmpeg_path()
    if not tool:
        return {"composed": False, "reason": "ffmpeg_unavailable", "detail": composition_capability()["note"]}
    if not clip_paths:
        return {"composed": False, "reason": "no_clips", "detail": "没有可合成的片段。"}

    for path in clip_paths:
        if not path.is_file():
            return {"composed": False, "reason": "missing_clip", "detail": f"缺少片段文件：{path.name}"}
        if path.stat().st_size > MAX_CLIP_BYTES:
            return {"composed": False, "reason": "clip_too_large", "detail": f"片段过大：{path.name}"}

    with tempfile.TemporaryDirectory() as work:
        listing = Path(work) / "clips.txt"
        # Paths are ours, but quoting is still explicit: concat's list format
        # treats a bare quote as syntax.
        listing.write_text(
            "\n".join(f"file '{p.resolve().as_posix()}'" for p in clip_paths) + "\n",
            encoding="utf-8",
        )
        args = [
            tool, "-nostdin", "-hide_banner", "-loglevel", "error",
            "-f", "concat", "-safe", "0", "-i", str(listing),
            "-c", "copy", "-t", str(MAX_COMPOSE_SECONDS), "-y", str(output),
        ]
        try:
            result = subprocess.run(args, capture_output=True, timeout=timeout, check=False)
        except subprocess.TimeoutExpired:
            return {"composed": False, "reason": "timeout", "detail": "合成超时，未产生成片。"}
        except OSError:
            return {"composed": False, "reason": "spawn_failed", "detail": "无法启动 FFmpeg。"}

    if result.returncode != 0 or not output.is_file() or output.stat().st_size == 0:
        output.unlink(missing_ok=True)
        return {"composed": False, "reason": "compose_failed", "detail": "合成失败，未产生可播放文件。"}

    probe = _probe(output)
    if not probe["playable"]:
        output.unlink(missing_ok=True)
        return {"composed": False, "reason": "unplayable", "detail": "合成结果无法通过校验，已删除。"}

    return {
        "composed": True,
        "path": str(output),
        "bytes": output.stat().st_size,
        "duration_s": probe["duration_s"],
        "tool": "ffmpeg",
    }


def _probe(path: Path) -> dict[str, Any]:
    """Validate the produced file. Absent ffprobe means unverified, not fine."""
    probe = shutil.which("ffprobe")
    if not probe:
        return {"playable": False, "duration_s": None, "reason": "ffprobe_unavailable"}
    try:
        out = subprocess.run(
            [probe, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
            capture_output=True, text=True, timeout=30, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return {"playable": False, "duration_s": None, "reason": "probe_failed"}
    if out.returncode != 0:
        return {"playable": False, "duration_s": None, "reason": "probe_failed"}
    try:
        duration = float((out.stdout or "").strip())
    except ValueError:
        return {"playable": False, "duration_s": None, "reason": "no_duration"}
    return {"playable": duration > 0, "duration_s": round(duration, 2)}


# --------------------------------------------------------------------------- #
# Persistence                                                                  #
# --------------------------------------------------------------------------- #


def _ledger_path() -> Path:
    return store.store_dir() / "storyboards.json"


def _blank() -> dict[str, Any]:
    return {"schema": _SCHEMA, "seq": 0, "storyboards": {}}


def read_ledger() -> dict[str, Any]:
    path = _ledger_path()
    if not path.exists():
        return _blank()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return _blank()
    if not isinstance(data, dict) or not isinstance(data.get("storyboards"), dict):
        return _blank()
    data.setdefault("seq", 0)
    return data


def _write_ledger(ledger: dict[str, Any]) -> None:
    path = _ledger_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(ledger, handle, ensure_ascii=False, indent=2, sort_keys=True)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def create(sku_id: str, *, platform: str = "tiktok") -> dict[str, Any]:
    with _LOCK:
        ledger = read_ledger()
        ledger["seq"] = int(ledger.get("seq") or 0) + 1
        storyboard_id = f"sb-{ledger['seq']:04d}"
        board = {
            "storyboard_id": storyboard_id,
            "sku_id": sku_id,
            "platform": platform,
            "shots": default_shots(platform=platform),
            "created_at": _now(),
            "updated_at": _now(),
            "run_token": "",
            "cancelled": False,
            "final_video": None,
            "composition": composition_capability(),
            "tts": tts_capability(),
        }
        ledger["storyboards"][storyboard_id] = board
        _write_ledger(ledger)
        return dict(board)


def get(storyboard_id: str) -> dict[str, Any]:
    found = read_ledger()["storyboards"].get(storyboard_id)
    if found is None:
        raise StoryboardError("unknown_storyboard", "找不到该分镜。", status=404)
    return dict(found)


def list_storyboards(*, sku_id: str = "") -> list[dict[str, Any]]:
    rows = [
        b for b in read_ledger()["storyboards"].values() if not sku_id or b["sku_id"] == sku_id
    ]
    return sorted(rows, key=lambda b: b["storyboard_id"])


def _save(board: dict[str, Any]) -> dict[str, Any]:
    with _LOCK:
        ledger = read_ledger()
        board["updated_at"] = _now()
        ledger["storyboards"][board["storyboard_id"]] = board
        _write_ledger(ledger)
        return dict(board)


def update_shots(storyboard_id: str, shots: list[dict[str, Any]]) -> dict[str, Any]:
    """Replace the shot list: reorder, add, remove and edit all land here.

    Results are preserved by shot id, so reordering a storyboard does not throw
    away clips that were already paid for.
    """
    board = get(storyboard_id)
    previous = {s["shot_id"]: s for s in board["shots"]}

    rebuilt: list[dict[str, Any]] = []
    for index, incoming in enumerate(shots[:MAX_SHOTS], start=1):
        shot_id = str(incoming.get("shot_id") or f"shot-{uuid.uuid4().hex[:8]}")
        old = previous.get(shot_id, {})
        duration = float(incoming.get("duration_s") or old.get("duration_s") or 3.0)
        row = _shot(
            shot_id=shot_id,
            beat=str(incoming.get("beat") or old.get("beat") or "custom"),
            label=str(incoming.get("label") or old.get("label") or f"分镜 {index}"),
            start=0.0,
            end=duration,
            platform=board["platform"],
            instruction=str(incoming.get("instruction") or old.get("instruction") or ""),
            overlay_text=str(incoming.get("overlay_text") or old.get("overlay_text") or ""),
            narration=str(incoming.get("narration") or old.get("narration") or ""),
            fact_ids=list(incoming.get("fact_ids") or old.get("fact_ids") or []),
            source_image_asset_id=str(
                incoming.get("source_image_asset_id") or old.get("source_image_asset_id") or ""
            ),
        )
        # A shot that already generated keeps its result; editing its text does
        # not silently discard a clip somebody paid for.
        if old.get("status") == SUCCEEDED and old.get("result_url"):
            row["status"] = SUCCEEDED
            row["result_url"] = old["result_url"]
            row["provider_task_id"] = old.get("provider_task_id", "")
            row["attempts"] = old.get("attempts", 0)
        rebuilt.append(row)

    board["shots"] = retimeline(rebuilt)
    return _save(board)


# --------------------------------------------------------------------------- #
# Generation                                                                   #
# --------------------------------------------------------------------------- #


def plan_generation(storyboard_id: str, *, only: "list[str] | None" = None) -> dict[str, Any]:
    """What generating would cost, before anything is spent."""
    board = get(storyboard_id)
    wanted = _targets(board, only)
    validation = validate_shots(board["shots"])
    return {
        "storyboard_id": storyboard_id,
        "shots_to_generate": [s["shot_id"] for s in wanted],
        # Exactly one paid call per shot that needs one; already-successful
        # shots are excluded, which is why a retry is cheaper than a full run.
        "expected_model_calls": len(wanted),
        "requires_confirmation": len(wanted) > 1,
        "skipped_already_succeeded": [
            s["shot_id"] for s in board["shots"] if s["status"] == SUCCEEDED and s not in wanted
        ],
        "validation": validation,
        "blocked": not validation["ok"],
    }


def _targets(board: dict[str, Any], only: "list[str] | None") -> list[dict[str, Any]]:
    if only:
        wanted = set(only)
        return [s for s in board["shots"] if s["shot_id"] in wanted]
    return [s for s in board["shots"] if s["status"] != SUCCEEDED]


def start_run(storyboard_id: str, *, only: "list[str] | None" = None, confirmed: bool = False) -> dict[str, Any]:
    """Begin a run. More than one paid call needs an explicit confirmation."""
    board = get(storyboard_id)
    plan = plan_generation(storyboard_id, only=only)
    if plan["blocked"]:
        raise StoryboardError("invalid_timeline", "分镜校验未通过，未开始生成。", status=409)
    if not plan["shots_to_generate"]:
        raise StoryboardError("nothing_to_do", "没有需要生成的分镜。")
    if plan["requires_confirmation"] and not confirmed:
        raise StoryboardError(
            "confirmation_required",
            f"本次将产生 {plan['expected_model_calls']} 次付费生成调用，需要显式确认。",
            status=428,
        )

    token = uuid.uuid4().hex
    board["run_token"] = token
    board["cancelled"] = False
    targets = set(plan["shots_to_generate"])
    for shot in board["shots"]:
        if shot["shot_id"] in targets:
            shot["status"] = GENERATING
            shot["error"] = ""
            shot["updated_at"] = _now()
    saved = _save(board)
    return {"run_token": token, "plan": plan, "storyboard": saved}


def record_shot_result(
    storyboard_id: str,
    shot_id: str,
    *,
    run_token: str,
    status: str,
    result_url: str = "",
    provider_task_id: str = "",
    error: str = "",
) -> dict[str, Any]:
    """Write one shot's outcome, if it still belongs to the active run.

    A result from a cancelled or superseded run is dropped. Without this, a slow
    provider reply could overwrite the state of a run the operator already
    stopped, and the UI would show a clip nobody is waiting for.
    """
    if status not in SHOT_STATES:
        raise StoryboardError("bad_status", f"未知的分镜状态：{status}")

    with _LOCK:
        ledger = read_ledger()
        board = ledger["storyboards"].get(storyboard_id)
        if board is None:
            raise StoryboardError("unknown_storyboard", "找不到该分镜。", status=404)
        if board.get("cancelled") or run_token != board.get("run_token"):
            return {"accepted": False, "reason": "stale_run", "storyboard": dict(board)}

        shot = next((s for s in board["shots"] if s["shot_id"] == shot_id), None)
        if shot is None:
            raise StoryboardError("unknown_shot", "找不到该分镜片段。", status=404)

        shot["status"] = status
        shot["attempts"] = int(shot.get("attempts") or 0) + 1
        shot["updated_at"] = _now()
        if status == SUCCEEDED:
            shot["result_url"] = result_url
            shot["error"] = ""
        else:
            shot["error"] = error[:300]
        # The provider's task id is an opaque handle, never a credential.
        shot["provider_task_id"] = _safe_task_id(provider_task_id)
        board["updated_at"] = _now()
        _write_ledger(ledger)
        return {"accepted": True, "storyboard": dict(board)}


_TASK_ID = re.compile(r"^[A-Za-z0-9._:-]{1,120}$")


def _safe_task_id(value: str) -> str:
    """Store an opaque handle, or nothing. Never a URL that might carry a key."""
    text = (value or "").strip()
    return text if _TASK_ID.match(text) else ""


def cancel_run(storyboard_id: str) -> dict[str, Any]:
    """Stop the run. In-flight results will be refused, not applied."""
    board = get(storyboard_id)
    board["cancelled"] = True
    board["run_token"] = ""
    for shot in board["shots"]:
        if shot["status"] == GENERATING:
            shot["status"] = CANCELLED
            shot["updated_at"] = _now()
    return _save(board)


def progress(storyboard_id: str) -> dict[str, Any]:
    """Real per-shot progress. Counted, never estimated."""
    board = get(storyboard_id)
    shots = board["shots"]
    counts = {state: sum(1 for s in shots if s["status"] == state) for state in SHOT_STATES}
    done = counts[SUCCEEDED]
    total = len(shots)
    return {
        "storyboard_id": storyboard_id,
        "counts": counts,
        "succeeded": done,
        "total": total,
        # A sentence a person can verify against the shot list.
        "label": f"分镜 {done}/{total} 已生成",
        "running": counts[GENERATING] > 0,
        "cancelled": bool(board.get("cancelled")),
        "complete": done == total and total > 0,
    }


# --------------------------------------------------------------------------- #
# Content package                                                              #
# --------------------------------------------------------------------------- #


def content_package(storyboard_id: str) -> dict[str, Any]:
    """Everything the storyboard produced, and an honest note on what it did not.

    ``final_video`` is null unless a composition step really ran and its output
    passed validation. The manifest records that, so a reader of the package
    cannot mistake four separate clips for a finished film.
    """
    board = get(storyboard_id)
    shots = board["shots"]
    succeeded = [s for s in shots if s["status"] == SUCCEEDED and s["result_url"]]
    composition = composition_capability()
    tts = tts_capability()

    return {
        "schema": "listing-content-package/v1",
        "storyboard_id": storyboard_id,
        "sku_id": board["sku_id"],
        "platform": board["platform"],
        "storyboard": {
            "shots": shots,
            "total_seconds": validate_shots(shots)["total_seconds"],
        },
        "captions": {"webvtt": to_webvtt(shots), "srt": to_srt(shots)},
        "narration": {
            "script": narration_script(shots),
            "audio": None,
            "tts": tts,
            "note": tts["note"],
        },
        "clips": [
            {
                "shot_id": s["shot_id"],
                "url": s["result_url"],
                "provider_task_id": s["provider_task_id"],
                "duration_s": s["duration_s"],
            }
            for s in succeeded
        ],
        "final_video": board.get("final_video"),
        "composed": bool(board.get("final_video")),
        "composition": composition,
        "manifest": {
            "shot_count": len(shots),
            "generated_clips": len(succeeded),
            "missing_clips": [s["shot_id"] for s in shots if s["status"] != SUCCEEDED],
            "captions": ["captions.vtt", "captions.srt"],
            "narration": "narration.txt",
            "final_video": board.get("final_video", {}).get("path") if board.get("final_video") else None,
            "generated_at": _now(),
        },
        "note": (
            "包内为各分镜片段与字幕。"
            + (
                "已合成并校验最终成片。"
                if board.get("final_video")
                else "未合成最终成片：" + composition["note"]
            )
        ),
    }
