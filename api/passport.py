"""Release Passport: what is being handed off, and what backs it.

A passport answers six questions with stored records rather than prose:
exactly what is being handed off, which facts and evidence support it, which
policy version validated it, who approved it, what remains unresolved, and
whether the package can be reproduced and verified.

Three properties keep it honest.

**It is built from ids, never from display text.** Every section is assembled
by looking up entities -- a revision id, a fact id, an evidence source hash, an
asset id, a policy snapshot version -- so a passport cannot drift from the
records it claims to summarise. If an entity is gone, the passport says it is
gone; it does not paper over the hole with the text it remembers.

**Readiness is computed, never asserted.** ``blocked`` and ``needs_review`` come
out of real verdicts: no approved revision, a deterministic blocker, an evidence
gate refusal, a failed image inspection, a missing asset, a checksum that moved,
or an approved revision that has since been edited or superseded. Unresolved
manual-review items stay visible in every state and are never converted into
passes.

**Export is a handoff, not a publication.** Nothing here contacts a marketplace.
The package is a deterministic ZIP: fixed entry timestamps, sorted entries,
generated paths, and a manifest listing every file's size, SHA-256 and
originating entity. It is re-opened and re-hashed after creation, so "exported"
means verified, not attempted.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import posixpath
import re
import tempfile
import threading
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import evidence
import mediaassets
import policy
import review
import storyboard as storyboard_module
from evidence import store

_LOCK = threading.RLock()

_SCHEMA = "listing-release-passport/v1"
PACKAGE_SCHEMA = "listing-handoff-package/v1"

# Readiness ----------------------------------------------------------------- #

BLOCKED = "blocked"
NEEDS_REVIEW = "needs_review"
READY = "ready_for_handoff"
EXPORTED = "exported"
SUPERSEDED = "superseded"

READINESS = (BLOCKED, NEEDS_REVIEW, READY, EXPORTED, SUPERSEDED)

#: Total uncompressed bytes a package may contain. A handoff is a listing plus
#: its approved media, not an archive of everything the workspace ever held.
MAX_PACKAGE_BYTES = 64 * 1024 * 1024
MAX_PACKAGE_FILES = 200

#: Fixed ZIP entry timestamp. Real mtimes would make two exports of the same
#: stored passport differ byte-for-byte for no business reason.
_ZIP_EPOCH = (1980, 1, 1, 0, 0, 0)

#: Passport fields that change on every rebuild and say nothing about content.
_VOLATILE = ("built_at", "export", "readiness", "readiness_reasons", "passport_id")

#: Keys that record *when a computation ran*, at any depth. A re-validation
#: stamp is not content: if these reached the digest, rebuilding an unchanged
#: passport a second later would mint a new one and supersede the exported
#: version of the very same listing.
_VOLATILE_KEYS = frozenset(
    {"revalidated_at", "ran_at", "built_at", "inspected_at", "stored_at", "exported_at"}
)

#: Fields stripped from the copy that goes into the package. ``export``
#: describes the package itself, and ``readiness`` flips to "exported" the
#: moment one exists -- packaging either would make the archive depend on
#: whether it had been built before.
_UNPACKAGED = ("export",)

#: Key names that must never appear anywhere in an exported passport. The
#: builders already avoid them; this is the backstop that fails loudly rather
#: than shipping a credential in a file someone is about to email.
_FORBIDDEN_KEYS = (
    "api_key", "apikey", "authorization", "auth_token", "access_token",
    "secret", "password", "passwd", "cookie", "session_id",
    "private_key", "ssh_key", "id_rsa", "env", "environ",
)


class PassportError(ValueError):
    """Rejected passport operation. ``safe_message`` is safe to show a user."""

    def __init__(self, code: str, message: str, status: int = 400) -> None:
        self.code = code
        self.safe_message = message
        self.http_status = status
        super().__init__(message)


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


# --------------------------------------------------------------------------- #
# Ledger                                                                       #
# --------------------------------------------------------------------------- #


def _ledger_path() -> Path:
    return store.store_dir() / "passports.json"


def _blank() -> dict[str, Any]:
    return {"schema": _SCHEMA, "seq": 0, "passports": {}}


def read_ledger() -> dict[str, Any]:
    path = _ledger_path()
    if not path.exists():
        return _blank()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return _blank()
    if not isinstance(data, dict) or not isinstance(data.get("passports"), dict):
        return _blank()
    data.setdefault("seq", 0)
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


# --------------------------------------------------------------------------- #
# Section builders — every one of these starts from an id                      #
# --------------------------------------------------------------------------- #

#: Locale defaults. Declared by the operator, never inferred from product data:
#: this tool does not invent price, currency or measurement facts.
_MARKET_DEFAULTS = {
    "US": {"language": "en-US", "currency": "USD", "unit_system": "metric"},
    "UK": {"language": "en-GB", "currency": "GBP", "unit_system": "metric"},
    "DE": {"language": "de-DE", "currency": "EUR", "unit_system": "metric"},
    "CN": {"language": "zh-CN", "currency": "CNY", "unit_system": "metric"},
}


def _locale_block(revision: dict[str, Any], overrides: dict[str, str]) -> dict[str, Any]:
    market = revision.get("market") or "US"
    base = dict(_MARKET_DEFAULTS.get(market, _MARKET_DEFAULTS["US"]))
    base["language"] = revision.get("locale") or base["language"]
    for key in ("language", "currency", "unit_system"):
        if overrides.get(key):
            base[key] = overrides[key]
    return {
        "market": market,
        **base,
        # These are operator declarations, not measurements. The passport says
        # so rather than letting a reader assume they were verified.
        "declared_by": "operator",
        "verified": False,
    }


def _facts_block() -> "tuple[list[dict[str, Any]], list[dict[str, Any]]]":
    """Approved facts and the evidence documents they cite, both by id."""
    sources = {s["source_id"]: s for s in evidence.store.list_sources()}
    cited: set[str] = set()
    facts: list[dict[str, Any]] = []

    for fact in evidence.facts.list_facts():
        links = []
        for link in fact.get("sources", []):
            source_id = str(link.get("source_id") or "")
            source = sources.get(source_id)
            cited.add(source_id)
            links.append(
                {
                    "source_id": source_id,
                    # A link whose document is gone is reported as gone, not dropped.
                    "present": source is not None,
                    "sha256": (source or {}).get("sha256", ""),
                    "page": link.get("page"),
                    "sheet": link.get("sheet", ""),
                    "cell": link.get("cell", ""),
                    "method": link.get("method", ""),
                    "expires_on": link.get("expires_on", ""),
                }
            )
        facts.append(
            {
                "fact_id": fact["fact_id"],
                "key": fact["key"],
                "value": fact["value"],
                "display": fact["display"],
                "claim_type": fact["claim_type"],
                "state": fact["state"],
                "sources": links,
            }
        )

    documents = [
        {
            "source_id": s["source_id"],
            "sha256": s["sha256"],
            "filename": s["filename"],
            "label": s["label"],
            "mime_type": s["mime_type"],
            "size_bytes": s["size_bytes"],
            "uploaded_at": s["uploaded_at"],
            "expires_on": s.get("expires_on", ""),
            "cited": s["source_id"] in cited,
        }
        for s in sources.values()
    ]
    return facts, sorted(documents, key=lambda d: d["source_id"])


def _policy_block(platform: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    try:
        snapshot = policy.current_snapshot(platform)
    except Exception:
        return out
    rules_digest = _sha256(
        _canonical([{"id": r.id, "kind": r.kind, "severity": r.severity, "params": dict(r.params or {})}
                    for r in snapshot.rules])
    )
    out.append(
        {
            "snapshot_id": snapshot.version,
            "platform": snapshot.platform,
            "market": snapshot.market,
            "status": snapshot.status,
            "effective_date": snapshot.effective_date,
            "excerpt_date": snapshot.excerpt_date,
            "source_name": snapshot.source_name,
            "source_url": snapshot.source_url,
            "rules_sha256": rules_digest,
            "rule_count": len(snapshot.rules),
        }
    )
    return out


def _media_block(revision: dict[str, Any]) -> "tuple[list[dict[str, Any]], list[str]]":
    """Inspected media for this platform, plus reasons any of them block."""
    reasons: list[str] = []
    rows: list[dict[str, Any]] = []
    for asset in mediaassets.list_assets(platform=revision["platform"]):
        check = mediaassets.verify_asset(asset["asset_id"])
        if not check["present"]:
            reasons.append(f"图片 {asset['asset_id']} 的文件已丢失。")
        elif not check["matches"]:
            reasons.append(f"图片 {asset['asset_id']} 的内容与记录的校验和不一致。")
        if asset["summary"]["blocked"]:
            reasons.append(f"图片 {asset['asset_id']} 有未通过的图片合规项。")
        rows.append(
            {
                "asset_id": asset["asset_id"],
                "sha256": asset["sha256"],
                "origin": asset["origin"],
                "label": asset["label"],
                "format": asset["measurements"]["format"],
                "mime_type": asset["measurements"]["mime_type"],
                "width": asset["measurements"]["width"],
                "height": asset["measurements"]["height"],
                "size_bytes": asset["measurements"]["size_bytes"],
                "policy_snapshot_id": asset["policy_snapshot_id"],
                "summary": asset["summary"],
                "results": asset["results"],
                "checksum_verified": check["matches"],
                "present": check["present"],
            }
        )
    return rows, reasons


def _content_packages(sku_id: str) -> list[dict[str, Any]]:
    """Storyboard content packages for this SKU.

    Included by reference and by state, never by optimism: ``composed`` is
    whatever the storyboard actually recorded, so a passport cannot imply a
    finished film that no composition step produced.
    """
    out: list[dict[str, Any]] = []
    try:
        boards = storyboard_module.list_storyboards(sku_id=sku_id)
    except Exception:  # pragma: no cover - defensive
        return out
    for board in boards:
        package = storyboard_module.content_package(board["storyboard_id"])
        out.append(
            {
                "storyboard_id": package["storyboard_id"],
                "platform": package["platform"],
                "shot_count": package["manifest"]["shot_count"],
                "generated_clips": package["manifest"]["generated_clips"],
                "missing_clips": package["manifest"]["missing_clips"],
                "composed": package["composed"],
                "captions": list(package["captions"]),
                "note": package["note"],
            }
        )
    return out


def _evidence_gate(revision: dict[str, Any]) -> dict[str, Any]:
    draft = {
        "id": revision["platform"],
        "title": revision["content"]["title"],
        "fields": list(revision["content"]["fields"]),
    }
    return evidence.gate.evaluate_draft(
        draft, evidence.facts.facts_by_id(), source_points=revision.get("points", "")
    )


def _lineage(revision_id: str, ledger: dict[str, Any]) -> list[str]:
    chain: list[str] = []
    current = revision_id
    seen: set[str] = set()
    while current and current not in seen:
        seen.add(current)
        chain.append(current)
        current = (ledger["revisions"].get(current) or {}).get("parent_revision_id", "")
    return list(reversed(chain))


# --------------------------------------------------------------------------- #
# Build                                                                        #
# --------------------------------------------------------------------------- #


def build(
    sku_id: str,
    platform: str,
    *,
    project_id: str = "",
    overrides: "dict[str, str] | None" = None,
) -> dict[str, Any]:
    """Assemble a passport for the currently approved revision of sku+platform.

    Always returns a passport. A SKU with nothing approved yields a ``blocked``
    passport that names what is missing, which is more useful -- and more
    honest -- than an error that leaves the operator guessing.
    """
    overrides = overrides or {}
    review_ledger = review.read_ledger()
    approved = review.active_revision(sku_id, platform)

    reasons: list[str] = []
    if approved is None:
        return _store(
            _shell(sku_id, platform, project_id)
            | {
                "readiness": BLOCKED,
                "content_readiness": BLOCKED,
                "readiness_reasons": ["尚无已批准的修订版本，无法交接。"],
            }
        )

    revision_id = approved["revision_id"]
    validation = review_ledger["validations"].get(approved.get("validation_id") or "")
    approvals = sorted(
        (a for a in review_ledger["approvals"].values() if a["revision_id"] == revision_id),
        key=lambda a: a["at"],
    )
    acks = [
        a for a in review_ledger["acknowledgements"].values() if a["revision_id"] == revision_id
    ]

    # Re-validate rather than trust the record: policy may have moved since the
    # approval, and a passport asserting today's readiness must use today's rules.
    fresh = review.run_validation(approved)
    blockers = list(fresh["blockers"])
    warnings = list(fresh["warnings"])
    if blockers:
        reasons.append(f"确定性校验仍有 {len(blockers)} 项阻断。")
    if fresh["content_hash"] != approved["content_hash"]:  # pragma: no cover - defensive
        reasons.append("已批准修订的内容与其记录的指纹不一致。")

    gate = _evidence_gate(approved)
    if gate["verdict"] == "blocked":
        reasons.append(f"证据闸门阻断了 {len(gate['blocked_fields'])} 个字段。")

    media, media_reasons = _media_block(approved)
    reasons.extend(media_reasons)

    facts, documents = _facts_block()
    missing_docs = [
        link["source_id"]
        for fact in facts
        for link in fact["sources"]
        if not link["present"]
    ]
    if missing_docs:
        reasons.append(f"{len(missing_docs)} 条事实引用的证据文件已不存在。")

    manual_review = [
        {
            "asset_id": asset["asset_id"],
            "rule_id": r["rule_id"],
            "state": r["state"],
            "detail": r["detail"],
        }
        for asset in media
        for r in asset["results"]
        if r["state"] in ("manual_review", "unavailable")
    ]
    gate_review = [
        {"field": f["field"], "claim": c["label"], "detail": c["detail"]}
        for f in gate["fields"]
        for c in f["claims"]
        if c["verdict"] == "needs_review"
    ]

    passport = _shell(sku_id, platform, project_id or approved.get("project_id", ""))
    passport.update(
        {
            "locale": _locale_block(approved, overrides),
            "revision_id": revision_id,
            "revision_lineage": _lineage(revision_id, review_ledger),
            "content_hash": approved["content_hash"],
            "field_hashes": approved["field_hashes"],
            "listing": approved["content"],
            "generator": approved.get("generator", {}),
            "validation": {
                "validation_id": validation["validation_id"] if validation else "",
                "recorded_blockers": list(validation["blockers"]) if validation else [],
                "recorded_warnings": list(validation["warnings"]) if validation else [],
                "revalidated_at": fresh["ran_at"],
                "blockers": blockers,
                "warnings": warnings,
                "checks": fresh["checks"],
                "policy_snapshot_ids": list(fresh["policy_snapshot_ids"]),
            },
            "evidence_gate": gate,
            "facts": facts,
            "evidence_documents": documents,
            "media": media,
            "policy_snapshots": _policy_block(platform),
            "content_packages": _content_packages(sku_id),
            "approvals": approvals,
            "acknowledgements": acks,
            "audit": [
                e
                for e in review_ledger["audit"]
                if e.get("revision_id") in set(_lineage(revision_id, review_ledger))
            ],
            "blockers": blockers,
            "warnings": warnings,
            "manual_review": manual_review + gate_review,
        }
    )

    if reasons:
        readiness = BLOCKED
    elif warnings or manual_review or gate_review or gate["verdict"] == "needs_review":
        readiness = NEEDS_REVIEW
        reasons = ["存在未解决的提醒或需人工核验项，交接前请确认责任归属。"]
    else:
        readiness = READY

    passport["readiness"] = readiness
    # What the records imply, independent of whether a package has been built.
    # The packaged copy uses this, so exporting cannot change what the next
    # export contains -- see _packaged_view.
    passport["content_readiness"] = readiness
    passport["readiness_reasons"] = reasons
    return _store(passport)


def _shell(sku_id: str, platform: str, project_id: str) -> dict[str, Any]:
    return {
        "schema": _SCHEMA,
        "passport_id": "",
        "project_id": project_id,
        "sku_id": sku_id,
        "platform": platform,
        "locale": {},
        "revision_id": "",
        "revision_lineage": [],
        "content_hash": "",
        "field_hashes": {},
        "listing": {"title": "", "fields": []},
        "generator": {},
        "validation": {},
        "evidence_gate": {},
        "facts": [],
        "evidence_documents": [],
        "media": [],
        "policy_snapshots": [],
        "content_packages": [],
        "approvals": [],
        "acknowledgements": [],
        "audit": [],
        "blockers": [],
        "warnings": [],
        "manual_review": [],
        "readiness": BLOCKED,
        "content_readiness": BLOCKED,
        "readiness_reasons": [],
        "built_at": _now(),
        "content_digest": "",
        "export": None,
    }


def _without_timestamps(value: Any) -> Any:
    """Drop computation timestamps at any depth, for digest purposes only."""
    if isinstance(value, dict):
        return {
            k: _without_timestamps(v) for k, v in value.items() if k not in _VOLATILE_KEYS
        }
    if isinstance(value, list):
        return [_without_timestamps(v) for v in value]
    return value


def content_digest(passport: dict[str, Any]) -> str:
    """Hash of the business content, with rebuild-volatile fields excluded.

    Two builds a minute apart over unchanged records produce the same digest.
    That is what lets the UI say "nothing has changed" truthfully instead of
    showing a new identity every time someone opens the page -- and it is what
    stops an export from being superseded by the next rebuild of itself.
    """
    stable = {k: v for k, v in passport.items() if k not in _VOLATILE}
    return _sha256(_canonical(_without_timestamps(stable)))


def _store(passport: dict[str, Any]) -> dict[str, Any]:
    passport["content_digest"] = content_digest(passport)
    with _LOCK:
        ledger = read_ledger()
        # One passport per sku+platform+content: rebuilding unchanged records
        # updates the existing entry rather than accumulating duplicates.
        existing = next(
            (
                p
                for p in ledger["passports"].values()
                if p["sku_id"] == passport["sku_id"]
                and p["platform"] == passport["platform"]
                and p["content_digest"] == passport["content_digest"]
            ),
            None,
        )
        if existing:
            passport["passport_id"] = existing["passport_id"]
            passport["built_at"] = existing["built_at"]
            passport["export"] = existing.get("export")
            if existing.get("export"):
                passport["readiness"] = EXPORTED
        else:
            ledger["seq"] = int(ledger.get("seq") or 0) + 1
            passport["passport_id"] = f"psp-{ledger['seq']:04d}"
            # A passport for the same sku+platform whose content moved on is
            # superseded, not deleted: an exported package must stay explicable.
            for other in ledger["passports"].values():
                if (
                    other["sku_id"] == passport["sku_id"]
                    and other["platform"] == passport["platform"]
                    and other["readiness"] != SUPERSEDED
                ):
                    other["readiness"] = SUPERSEDED
                    other["readiness_reasons"] = [
                        f"已被 {passport['passport_id']} 取代（内容或依据发生变化）。"
                    ]
        ledger["passports"][passport["passport_id"]] = passport
        _write_ledger(ledger)
    return dict(passport)


def get(passport_id: str) -> dict[str, Any]:
    row = read_ledger()["passports"].get(passport_id)
    if row is None:
        raise PassportError("unknown_passport", "找不到该发布护照。", status=404)
    return dict(row)


def list_passports(*, sku_id: str = "", platform: str = "") -> list[dict[str, Any]]:
    rows = [
        p
        for p in read_ledger()["passports"].values()
        if (not sku_id or p["sku_id"] == sku_id) and (not platform or p["platform"] == platform)
    ]
    return sorted(rows, key=lambda p: p["passport_id"])


# --------------------------------------------------------------------------- #
# Export package                                                               #
# --------------------------------------------------------------------------- #

_SAFE_SEGMENT = re.compile(r"[^A-Za-z0-9._-]+")


def safe_path(*segments: str) -> str:
    """A normalised relative POSIX path that cannot escape the archive root.

    Every path in a package is generated from entity ids rather than from
    user-supplied filenames, so this is a guard rather than a sanitiser -- but
    it is the guard that makes ``../`` and ``/etc/passwd`` impossible to express
    even if a future caller passes something careless.
    """
    cleaned: list[str] = []
    for raw in segments:
        part = _SAFE_SEGMENT.sub("-", str(raw or "").strip()).strip("-.")
        if not part or part in (".", ".."):
            continue
        cleaned.append(part[:80])
    if not cleaned:
        raise PassportError("bad_path", "无法为导出文件生成安全的相对路径。")
    path = posixpath.normpath("/".join(cleaned))
    if path.startswith("/") or path.startswith("..") or "\\" in path:
        raise PassportError("bad_path", "导出文件路径不合法。")
    return path


def _listing_markdown(passport: dict[str, Any]) -> str:
    listing = passport["listing"]
    lines = [
        f"# {listing['title'] or '(无标题)'}",
        "",
        f"- SKU: `{passport['sku_id']}`",
        f"- 平台: `{passport['platform']}`",
        f"- 市场 / 语言: `{passport['locale'].get('market', '')}` / `{passport['locale'].get('language', '')}`",
        f"- 修订: `{passport['revision_id']}`",
        f"- 内容指纹: `{passport['content_hash']}`",
        "",
        "## 字段",
        "",
    ]
    for field in listing["fields"]:
        lines.append(f"### {field['label']}")
        lines.append("")
        lines.append(field["value"] or "(空)")
        lines.append("")
    return "\n".join(lines)


_README = """# 交接包 / Handoff package

这个压缩包是一次**交接**，不是一次发布。

- 本工具**没有**向任何平台提交或发布这份 listing。
- 通过本工具的检查**不代表**平台会通过审核。
- 包内标记为「需人工核验 / manual_review」的项目**尚未被任何自动检查判定**，
  由操作者自行负责确认。

## 包内文件

| 文件 | 内容 |
|---|---|
| `manifest.json` | 每个文件的相对路径、字节数、SHA-256 与来源实体 |
| `release-passport.json` | 完整的发布护照（所有实体 ID 与哈希） |
| `listing.json` | 已批准修订的结构化文案 |
| `listing.md` | 同一份文案的可读版本 |
| `validation-report.json` | 确定性校验结果与所依据的政策快照 |
| `evidence-index.json` | 引用到的证据文件清单（哈希与出处，不含文件本身） |
| `approvals.json` | 审批记录与审计事件 |
| `policy-snapshots.json` | 校验所依据的政策快照元数据与规则哈希 |
| `media/` | 已检查的图片原件，文件名即资产 ID |

`manifest.json` 不列出它自身。校验方式：对包内其余每个文件计算 SHA-256，
与 manifest 中的记录逐条比对。

## 可复现性

同一份已存储的护照导出两次，字节完全一致：条目顺序固定，条目时间戳固定，
不写入导出时刻。业务内容没变，包就没变。
"""


def _packaged_view(passport: dict[str, Any]) -> dict[str, Any]:
    """The passport as it appears inside the package.

    Exporting records an export on the stored passport and moves its readiness
    to ``exported``. Neither belongs in the archive: they describe the act of
    packaging, not the thing packaged, and including them would make the second
    export of an unchanged passport differ from the first.
    """
    view = {k: v for k, v in passport.items() if k not in _UNPACKAGED}
    view["readiness"] = passport.get("content_readiness") or passport["readiness"]
    return view


def _entries(passport: dict[str, Any]) -> list[tuple[str, bytes, str]]:
    """``(relative path, bytes, originating entity)`` for every packaged file."""
    out: list[tuple[str, bytes, str]] = []

    def add(path: str, payload: Any, entity: str) -> None:
        data = payload if isinstance(payload, bytes) else _canonical(payload)
        out.append((path, data, entity))

    add(safe_path("release-passport.json"), passport, f"passport:{passport['passport_id']}")
    add(safe_path("listing.json"), passport["listing"], f"revision:{passport['revision_id']}")
    out.append(
        (
            safe_path("listing.md"),
            _listing_markdown(passport).encode("utf-8"),
            f"revision:{passport['revision_id']}",
        )
    )
    add(
        safe_path("validation-report.json"),
        {"validation": passport["validation"], "evidence_gate": passport["evidence_gate"]},
        f"validation:{passport['validation'].get('validation_id', '')}",
    )
    add(
        safe_path("evidence-index.json"),
        {"facts": passport["facts"], "documents": passport["evidence_documents"]},
        "evidence:index",
    )
    add(
        safe_path("approvals.json"),
        {
            "approvals": passport["approvals"],
            "acknowledgements": passport["acknowledgements"],
            "audit": passport["audit"],
        },
        f"revision:{passport['revision_id']}",
    )
    add(safe_path("policy-snapshots.json"), passport["policy_snapshots"], "policy:snapshots")
    out.append((safe_path("README.md"), _README.encode("utf-8"), "package:readme"))

    for asset in passport["media"]:
        if not asset.get("present"):
            # A missing file is reported in the manifest's absence and in the
            # passport's readiness, never faked with a placeholder.
            continue
        try:
            blob, _ = mediaassets.read_blob(asset["asset_id"])
        except Exception:
            continue
        ext = {
            "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp",
            "image/gif": "gif", "image/tiff": "tif", "image/bmp": "bmp",
        }.get(asset["mime_type"], "bin")
        out.append(
            (
                safe_path("media", f"{asset['asset_id']}.{ext}"),
                blob,
                f"asset:{asset['asset_id']}",
            )
        )
    return out


def _assert_no_secrets(payload: Any, where: str = "$") -> None:
    """Fail loudly rather than ship a credential inside a handoff package."""
    if isinstance(payload, dict):
        for key, value in payload.items():
            lowered = str(key).lower()
            if any(bad == lowered or lowered.endswith("_" + bad) for bad in _FORBIDDEN_KEYS):
                raise PassportError(
                    "secret_in_package",
                    "导出包中出现了不应包含的敏感字段，已中止导出。",
                    status=500,
                )
            _assert_no_secrets(value, f"{where}.{key}")
    elif isinstance(payload, list):
        for i, item in enumerate(payload):
            _assert_no_secrets(item, f"{where}[{i}]")


def build_package(passport_id: str, *, record: bool = True) -> dict[str, Any]:
    """Build, verify and optionally record a deterministic ZIP handoff package.

    Refuses to package a blocked passport: an export is a statement that this
    is what is being handed over, and a blocked passport has nothing to hand.

    ``record=False`` builds the package without writing an export to the ledger.
    Showing an operator what a package *would* contain is not the same event as
    handing one over, and must not leave a record saying it was.
    """
    passport = get(passport_id)
    if passport["readiness"] == BLOCKED:
        raise PassportError(
            "not_ready",
            "该护照仍处于阻断状态，未生成交接包。请先解决阻断项。",
            status=409,
        )
    if passport["readiness"] == SUPERSEDED:
        raise PassportError(
            "superseded",
            "该护照已被更新的版本取代，请重新生成后再导出。",
            status=409,
        )

    _assert_no_secrets(passport)
    packaged = _packaged_view(passport)
    entries = _entries(packaged)

    if len(entries) + 1 > MAX_PACKAGE_FILES:
        raise PassportError("package_too_many_files", "交接包文件数超出上限。", status=413)
    total = sum(len(data) for _, data, _ in entries)
    if total > MAX_PACKAGE_BYTES:
        raise PassportError("package_too_large", "交接包体积超出上限。", status=413)

    seen: set[str] = set()
    for path, _, _ in entries:
        if path in seen:
            raise PassportError("path_collision", f"导出文件路径重复：{path}", status=500)
        seen.add(path)

    manifest = {
        "schema": PACKAGE_SCHEMA,
        "passport_id": passport["passport_id"],
        "content_digest": passport["content_digest"],
        "sku_id": passport["sku_id"],
        "platform": passport["platform"],
        "revision_id": passport["revision_id"],
        "readiness": packaged["readiness"],
        # Deliberately no export timestamp: it would make two exports of the
        # same stored passport differ while the business content is identical.
        "files": [
            {
                "path": path,
                "size_bytes": len(data),
                "sha256": _sha256(data),
                "entity": entity,
            }
            for path, data, entity in sorted(entries, key=lambda e: e[0])
        ],
        "note": "manifest.json 不列出自身；校验时对其余文件逐一比对 SHA-256。",
    }

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for path, data, _ in sorted(entries, key=lambda e: e[0]) + [
            (safe_path("manifest.json"), _canonical(manifest), "package:manifest")
        ]:
            info = zipfile.ZipInfo(path, date_time=_ZIP_EPOCH)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, data)

    package = buffer.getvalue()
    verification = verify_package(package, manifest)
    if not verification["ok"]:
        raise PassportError(
            "package_verification_failed",
            "交接包生成后校验失败，未标记为已导出。",
            status=500,
        )

    export_record = {
        "digest": _sha256(package),
        "files": len(manifest["files"]) + 1,
        "bytes": len(package),
        "content_digest": passport["content_digest"],
        "exported_at": _now(),
        "verified": True,
    }
    if record:
        with _LOCK:
            ledger = read_ledger()
            stored = ledger["passports"].get(passport_id)
            if stored is not None:
                # Re-exporting keeps the first export time: the package is
                # identical, so claiming a new export moment would invent an event.
                previous = stored.get("export") or {}
                if previous.get("digest") == export_record["digest"]:
                    export_record["exported_at"] = previous.get(
                        "exported_at", export_record["exported_at"]
                    )
                stored["export"] = export_record
                stored["readiness"] = EXPORTED
                _write_ledger(ledger)

    return {"package": package, "manifest": manifest, "export": export_record}


def verify_package(package: bytes, manifest: "dict[str, Any] | None" = None) -> dict[str, Any]:
    """Re-open a package and re-hash every entry against its manifest."""
    problems: list[str] = []
    try:
        with zipfile.ZipFile(io.BytesIO(package)) as zf:
            if zf.testzip() is not None:
                return {"ok": False, "problems": ["压缩包内有损坏的条目。"], "files": 0}
            names = set(zf.namelist())
            if manifest is None:
                manifest = json.loads(zf.read("manifest.json").decode("utf-8"))
            for row in manifest["files"]:
                if row["path"] not in names:
                    problems.append(f"缺少文件 {row['path']}")
                    continue
                data = zf.read(row["path"])
                if len(data) != row["size_bytes"]:
                    problems.append(f"{row['path']} 字节数不符")
                if _sha256(data) != row["sha256"]:
                    problems.append(f"{row['path']} 校验和不符")
            extra = names - {row["path"] for row in manifest["files"]} - {"manifest.json"}
            if extra:
                problems.append(f"包内存在未列入 manifest 的文件：{sorted(extra)}")
    except (zipfile.BadZipFile, KeyError, json.JSONDecodeError, ValueError) as exc:
        return {"ok": False, "problems": [f"无法读取交接包：{type(exc).__name__}"], "files": 0}

    return {"ok": not problems, "problems": problems, "files": len(manifest["files"]) + 1}
