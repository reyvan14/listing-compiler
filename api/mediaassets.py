"""Content-addressed media assets and their inspection records.

Generated images and uploaded images go through exactly the same door. A model
that produced a picture gets no more credit than a person who dragged one in:
both are decoded, measured and graded by ``imagecheck`` against the same
versioned policy snapshot, and both are stored by content hash so a passport can
later pin the exact bytes it was built from.

Persistence mirrors ``evidence.store``: blobs on disk under the request-scoped
directory, one atomically-replaced JSON ledger, no database. Storing the bytes
is not incidental -- the detail inspector has to be able to reopen the *inspected*
original, and an export package has to contain the file whose checksum it lists.
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import imagecheck
from evidence import store

_LOCK = threading.RLock()

_SCHEMA = "listing-media-assets/v1"

#: Where an asset came from. Both are inspected identically; the label exists so
#: a reviewer can see provenance, not so one can skip a check.
GENERATED = "generated"
UPLOADED = "uploaded"


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _ledger_path() -> Path:
    return store.store_dir() / "media_assets.json"


def _blob_path(sha256: str) -> Path:
    return store.store_dir() / "media" / sha256[:2] / sha256


def _blank() -> dict[str, Any]:
    return {"schema": _SCHEMA, "assets": {}}


def read_ledger() -> dict[str, Any]:
    path = _ledger_path()
    if not path.exists():
        return _blank()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return _blank()
    if not isinstance(data, dict) or not isinstance(data.get("assets"), dict):
        return _blank()
    return data


def _write_ledger(ledger: dict[str, Any]) -> None:
    path = _ledger_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(ledger, fh, ensure_ascii=False, indent=2, sort_keys=True)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def put_asset(
    data: bytes,
    *,
    platform: str,
    origin: str = UPLOADED,
    revision_id: str = "",
    node_id: str = "",
    label: str = "",
    filename: str = "",
    declared_mime: str = "",
) -> dict[str, Any]:
    """Store, inspect and index one image.

    Raises ``imagecheck.ImageInspectionError`` when the bytes cannot be measured.
    A rejected image is not written: nothing enters the ledger that was never
    successfully decoded, so every stored asset has real measurements.
    """
    report = imagecheck.inspect(data, platform, declared_mime=declared_mime)
    asset = report["asset"]

    record = {
        "asset_id": asset["asset_id"],
        "sha256": asset["sha256"],
        "origin": GENERATED if origin == GENERATED else UPLOADED,
        "platform": platform,
        "revision_id": revision_id,
        "node_id": node_id,
        "label": label or filename or asset["asset_id"],
        "filename": filename,
        "measurements": asset,
        "background": report["background"],
        "results": report["results"],
        "summary": report["summary"],
        "policy_snapshot_id": report["policy_snapshot_id"],
        "unavailable_reason": report["unavailable_reason"],
        "stored_at": _now(),
    }

    with _LOCK:
        blob = _blob_path(asset["sha256"])
        blob.parent.mkdir(parents=True, exist_ok=True)
        if not blob.exists():
            blob.write_bytes(data)
        ledger = read_ledger()
        previous = ledger["assets"].get(asset["asset_id"])
        if previous:
            # Same bytes re-submitted. Keep first-seen provenance, refresh the
            # verdict: the policy snapshot may have moved since.
            record["stored_at"] = previous.get("stored_at", record["stored_at"])
            record["origin"] = previous.get("origin", record["origin"])
        ledger["assets"][asset["asset_id"]] = record
        _write_ledger(ledger)
    return dict(record)


def get_asset(asset_id: str) -> dict[str, Any]:
    record = read_ledger()["assets"].get(asset_id)
    if record is None:
        raise imagecheck.ImageInspectionError("unknown_asset", "找不到该图片资产。", status=404)
    return dict(record)


def read_blob(asset_id: str) -> "tuple[bytes, str]":
    """The exact inspected bytes plus their MIME type."""
    record = get_asset(asset_id)
    path = _blob_path(record["sha256"])
    if not path.exists():
        raise imagecheck.ImageInspectionError("asset_missing", "该图片的内容已丢失。", status=410)
    return path.read_bytes(), record["measurements"]["mime_type"]


def list_assets(*, revision_id: str = "", platform: str = "") -> list[dict[str, Any]]:
    rows = [
        a
        for a in read_ledger()["assets"].values()
        if (not revision_id or a.get("revision_id") == revision_id)
        and (not platform or a.get("platform") == platform)
    ]
    return sorted(rows, key=lambda a: a.get("stored_at", ""))


def verify_asset(asset_id: str) -> dict[str, Any]:
    """Re-hash the stored bytes and report whether they still match the record.

    A passport that lists a checksum has to be able to prove it, and a blob that
    drifted from its record must surface as a mismatch rather than as an absence.
    """
    record = get_asset(asset_id)
    path = _blob_path(record["sha256"])
    if not path.exists():
        return {"asset_id": asset_id, "present": False, "matches": False, "sha256": ""}
    actual = store.sha256_bytes(path.read_bytes())
    return {
        "asset_id": asset_id,
        "present": True,
        "matches": actual == record["sha256"],
        "sha256": actual,
    }


def delete_asset(asset_id: str) -> bool:
    with _LOCK:
        ledger = read_ledger()
        record = ledger["assets"].pop(asset_id, None)
        if record is None:
            return False
        _write_ledger(ledger)
        # The blob is content-addressed and may back another record.
        if not any(a["sha256"] == record["sha256"] for a in ledger["assets"].values()):
            _blob_path(record["sha256"]).unlink(missing_ok=True)
        return True
