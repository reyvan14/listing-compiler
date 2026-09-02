"""Content-addressed evidence store.

The rest of the backend is stateless — policy snapshots are repo-bundled YAML and
every endpoint computes from its request payload. Evidence cannot work that way:
an uploaded manual or certificate has to outlive the request that carried it.

So this is the smallest persistence that fits the existing conventions: plain
files on disk, no database. Blobs are addressed by SHA-256 (so re-uploading the
same document is idempotent and the hash is the integrity record), and a single
JSON index carries the metadata ledger.

Nothing here logs file contents, and no credential ever reaches this module.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger("listing.evidence.store")

#: Upload ceiling. Large enough for a scanned manual, small enough to bound disk.
MAX_UPLOAD_BYTES = 20 * 1024 * 1024

#: MIME types we accept, mapped to the extraction family used in extract.py.
ALLOWED_MIME: dict[str, str] = {
    "application/pdf": "pdf",
    "image/jpeg": "image",
    "image/png": "image",
    "text/plain": "text",
    "text/markdown": "text",
    "text/csv": "csv",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
}

#: Extension fallback — browsers send text/markdown and text/csv inconsistently.
EXT_MIME: dict[str, str] = {
    ".pdf": "application/pdf",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".csv": "text/csv",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}


class EvidenceError(ValueError):
    """Rejected upload or unknown source. Message is safe to show a user."""

    def __init__(self, code: str, message: str, status: int = 400) -> None:
        self.code = code
        self.safe_message = message
        self.http_status = status
        super().__init__(message)


def store_dir() -> Path:
    """Where blobs and the index live. Override with LISTING_EVIDENCE_DIR."""
    raw = os.environ.get("LISTING_EVIDENCE_DIR", "").strip()
    base = Path(raw) if raw else Path(__file__).resolve().parent.parent / "evidence_store"
    return base


def _index_path() -> Path:
    return store_dir() / "index.json"


def _blob_path(sha256: str) -> Path:
    # two-level fan-out keeps any single directory small
    return store_dir() / "blobs" / sha256[:2] / sha256


_LOCK = threading.Lock()


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def read_index() -> dict[str, Any]:
    path = _index_path()
    if not path.exists():
        return {"schema": "listing-evidence-index/v1", "sources": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        logger.warning("evidence index unreadable; starting a fresh one")
        return {"schema": "listing-evidence-index/v1", "sources": {}}
    if not isinstance(data, dict) or not isinstance(data.get("sources"), dict):
        return {"schema": "listing-evidence-index/v1", "sources": {}}
    return data


def _write_index(index: dict[str, Any]) -> None:
    path = _index_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    # atomic replace so a crash mid-write cannot corrupt the ledger
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(index, fh, ensure_ascii=False, indent=2, sort_keys=True)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def resolve_mime(filename: str, declared: str) -> str:
    """Trust the extension over a vague browser-declared type."""
    ext = Path(filename or "").suffix.lower()
    if ext in EXT_MIME:
        return EXT_MIME[ext]
    declared = (declared or "").split(";")[0].strip().lower()
    return declared


def validate_upload(filename: str, declared_mime: str, size: int) -> str:
    """Return the resolved MIME type, or raise EvidenceError."""
    if size <= 0:
        raise EvidenceError("empty_file", "文件为空，请重新选择。")
    if size > MAX_UPLOAD_BYTES:
        raise EvidenceError(
            "file_too_large",
            f"文件超过 {MAX_UPLOAD_BYTES // (1024 * 1024)} MB 上限。",
            status=413,
        )
    mime = resolve_mime(filename, declared_mime)
    if mime not in ALLOWED_MIME:
        raise EvidenceError(
            "unsupported_type",
            "仅支持 PDF、JPG/PNG、TXT/Markdown、CSV 与 XLSX。",
            status=415,
        )
    return mime


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def put_source(
    *,
    filename: str,
    declared_mime: str,
    data: bytes,
    expires_on: str = "",
    label: str = "",
) -> dict[str, Any]:
    """Persist one evidence document and index its metadata.

    Idempotent by content hash: uploading the same bytes twice returns the
    existing source rather than duplicating the blob.
    """
    mime = validate_upload(filename, declared_mime, len(data))
    digest = sha256_bytes(data)

    with _LOCK:
        index = read_index()
        existing = index["sources"].get(digest)
        if existing:
            # keep the first-seen record; refresh only operator-supplied metadata
            if expires_on:
                existing["expires_on"] = expires_on
            if label:
                existing["label"] = label
            _write_index(index)
            return dict(existing)

        blob = _blob_path(digest)
        blob.parent.mkdir(parents=True, exist_ok=True)
        blob.write_bytes(data)

        record = {
            # the content hash IS the stable source id
            "source_id": digest[:16],
            "sha256": digest,
            "filename": filename,
            "label": label or filename,
            "mime_type": mime,
            "family": ALLOWED_MIME[mime],
            "size_bytes": len(data),
            "uploaded_at": _now(),
            "expires_on": expires_on or "",
        }
        index["sources"][digest] = record
        _write_index(index)
        logger.info(
            "evidence stored source_id=%s family=%s size=%d",
            record["source_id"], record["family"], record["size_bytes"],
        )
        return dict(record)


def list_sources() -> list[dict[str, Any]]:
    sources = list(read_index()["sources"].values())
    return sorted(sources, key=lambda s: s.get("uploaded_at", ""))


def _find(source_id: str) -> "tuple[str, dict[str, Any]] | None":
    for digest, record in read_index()["sources"].items():
        if record.get("source_id") == source_id or digest == source_id:
            return digest, record
    return None


def get_source(source_id: str) -> dict[str, Any]:
    hit = _find(source_id)
    if not hit:
        raise EvidenceError("unknown_source", "找不到该证据文件。", status=404)
    return dict(hit[1])


def read_blob(source_id: str) -> bytes:
    digest, _ = _find(source_id) or (None, None)
    if digest is None:
        raise EvidenceError("unknown_source", "找不到该证据文件。", status=404)
    path = _blob_path(digest)
    if not path.exists():
        raise EvidenceError("blob_missing", "该证据文件的内容已丢失。", status=410)
    return path.read_bytes()


def delete_source(source_id: str) -> bool:
    with _LOCK:
        index = read_index()
        digest = next(
            (d for d, r in index["sources"].items() if r.get("source_id") == source_id),
            None,
        )
        if digest is None:
            return False
        index["sources"].pop(digest, None)
        _write_index(index)
        _blob_path(digest).unlink(missing_ok=True)
        return True


def set_expiry(source_id: str, expires_on: str) -> dict[str, Any]:
    with _LOCK:
        index = read_index()
        for record in index["sources"].values():
            if record.get("source_id") == source_id:
                record["expires_on"] = expires_on
                _write_index(index)
                return dict(record)
    raise EvidenceError("unknown_source", "找不到该证据文件。", status=404)
