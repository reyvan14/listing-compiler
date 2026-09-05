"""Policy Watch: notice that a rule page changed, and stop there.

A scraper that edits its own rulebook is a liability. This module fetches
watched policy pages, notices when their content moves, and records a
**candidate** — nothing else. No fetch, diff, hash or model reading can activate
a policy snapshot; only a named human can, through ``approve_candidate``.

The fetch path is treated as hostile in both directions.

*Outbound*, because a URL is an instruction to make a request from inside the
network: every host must be on an explicit allowlist, every DNS resolution is
checked against private, loopback, link-local, multicast, reserved and cloud
metadata ranges, and every redirect hop is re-validated from scratch. Redirects
are followed manually for exactly that reason.

*Inbound*, because a policy page is a stranger's text: responses are size- and
time-bounded, parsing failure produces an evidence record rather than a rule
change, and a model reading of the diff is labelled model-assisted and never
outranks the deterministic policy engine.
"""

from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import re
import socket
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx

import policy
from evidence import store

_LOCK = threading.RLock()
_SCHEMA = "listing-policy-watch/v1"

# Candidate states ----------------------------------------------------------- #

UNCHANGED = "unchanged"
CHANGED = "changed"
APPROVED = "approved"
REJECTED = "rejected"
FAILED = "failed"

CANDIDATE_STATES = (UNCHANGED, CHANGED, APPROVED, REJECTED, FAILED)

#: Hostnames we are willing to fetch. Anything else is refused before DNS.
#: Deliberately explicit: a wildcard here would make this a general-purpose
#: request forwarder wearing a policy-watch costume.
DEFAULT_ALLOWLIST: tuple[str, ...] = (
    "sellercentral.amazon.com",
    "sell.amazon.com",
    "www.amazon.com",
    "seller-us.tiktok.com",
    "seller.tiktokglobalshop.com",
    "help.shopify.com",
    "www.shopify.com",
)

MAX_RESPONSE_BYTES = 2 * 1024 * 1024
FETCH_TIMEOUT_S = 15.0
MAX_REDIRECTS = 3


class PolicyWatchError(ValueError):
    def __init__(self, code: str, message: str, status: int = 400) -> None:
        self.code = code
        self.safe_message = message
        self.http_status = status
        super().__init__(message)


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


# --------------------------------------------------------------------------- #
# Outbound safety                                                              #
# --------------------------------------------------------------------------- #


def allowlist() -> tuple[str, ...]:
    """Hosts this deployment may fetch. Override with LISTING_POLICY_HOSTS."""
    raw = (os.environ.get("LISTING_POLICY_HOSTS") or "").strip()
    if not raw:
        return DEFAULT_ALLOWLIST
    return tuple(h.strip().lower() for h in raw.split(",") if h.strip())


def host_allowed(url: str) -> bool:
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    if parsed.scheme not in ("http", "https"):
        return False
    return (parsed.hostname or "").lower() in allowlist()


def _is_forbidden_ip(address: str) -> bool:
    """Any address that could reach something inside the perimeter."""
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return True
    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
        # 169.254.169.254 is link-local and already covered; named for clarity.
        or str(ip) in ("169.254.169.254", "fd00:ec2::254")
    )


def _resolve(hostname: str, port: int) -> list[str]:
    try:
        infos = socket.getaddrinfo(hostname, port, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise PolicyWatchError("dns_failed", f"无法解析域名：{hostname}") from exc
    return sorted({info[4][0] for info in infos})


def assert_fetchable(url: str) -> list[str]:
    """Validate one URL completely. Returns the resolved addresses.

    Called for the initial URL *and* every redirect target, because a redirect
    is a fresh request to a host the first check never saw.
    """
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise PolicyWatchError("bad_scheme", f"只允许 http/https：{parsed.scheme or '空'}")
    hostname = (parsed.hostname or "").lower()
    if not hostname:
        raise PolicyWatchError("bad_url", "URL 缺少主机名。")
    if hostname not in allowlist():
        raise PolicyWatchError(
            "host_not_allowed",
            f"主机 {hostname} 不在允许清单内，已拒绝抓取。",
            status=403,
        )
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    addresses = _resolve(hostname, port)
    blocked = [a for a in addresses if _is_forbidden_ip(a)]
    if blocked:
        raise PolicyWatchError(
            "private_address",
            f"域名 {hostname} 解析到内网/保留地址，已拒绝抓取。",
            status=403,
        )
    return addresses


# Seam for tests: overridden to inject an httpx.MockTransport.
def _make_client(timeout: float = FETCH_TIMEOUT_S) -> httpx.Client:
    # Redirects are handled manually so every hop can be revalidated.
    return httpx.Client(timeout=timeout, follow_redirects=False)


def fetch(url: str, *, etag: str = "", last_modified: str = "") -> dict[str, Any]:
    """Fetch one watched page under every guard. Never raises for HTTP status."""
    hops: list[str] = []
    current = url
    headers = {
        "User-Agent": "listing-compiler-policy-watch/1 (+internal review tool)",
        "Accept": "text/html,application/xhtml+xml",
    }
    if etag:
        headers["If-None-Match"] = etag
    if last_modified:
        headers["If-Modified-Since"] = last_modified

    with _make_client() as client:
        for _ in range(MAX_REDIRECTS + 1):
            addresses = assert_fetchable(current)
            hops.append(current)
            response = client.get(current, headers=headers)

            if response.status_code in (301, 302, 303, 307, 308):
                location = response.headers.get("location", "")
                if not location:
                    raise PolicyWatchError("bad_redirect", "重定向缺少目标地址。")
                current = httpx.URL(current).join(location).__str__()
                # Revalidated at the top of the next iteration, allowlist included.
                continue

            if response.status_code == 304:
                return {
                    "status": 304,
                    "unchanged": True,
                    "body": "",
                    "etag": etag,
                    "last_modified": last_modified,
                    "hops": hops,
                    "addresses": addresses,
                    "fetched_at": _now(),
                }

            declared = response.headers.get("content-length")
            if declared and int(declared) > MAX_RESPONSE_BYTES:
                raise PolicyWatchError(
                    "response_too_large",
                    f"响应超过 {MAX_RESPONSE_BYTES // (1024 * 1024)} MB 上限，已中止。",
                )
            body = response.content or b""
            if len(body) > MAX_RESPONSE_BYTES:
                raise PolicyWatchError(
                    "response_too_large",
                    f"响应超过 {MAX_RESPONSE_BYTES // (1024 * 1024)} MB 上限，已中止。",
                )

            return {
                "status": response.status_code,
                "unchanged": False,
                "body": body.decode("utf-8", errors="replace"),
                "etag": response.headers.get("etag", ""),
                "last_modified": response.headers.get("last-modified", ""),
                "hops": hops,
                "addresses": addresses,
                "fetched_at": _now(),
            }

    raise PolicyWatchError("too_many_redirects", "重定向次数过多，已中止。")


# --------------------------------------------------------------------------- #
# Content normalisation                                                        #
# --------------------------------------------------------------------------- #

_TAG = re.compile(r"<[^>]+>")
_SCRIPT = re.compile(r"(?is)<(script|style)\b.*?</\1>")
_WS = re.compile(r"\s+")


def normalize_content(html: str) -> str:
    """Visible text, collapsed.

    Hashing raw HTML would report a change every time a session id, a nonce or
    an ad slot moved. Normalising first means "changed" refers to the words a
    policy team edited.
    """
    text = _SCRIPT.sub(" ", html or "")
    text = _TAG.sub(" ", text)
    text = text.replace("&nbsp;", " ").replace("&amp;", "&")
    return _WS.sub(" ", text).strip()


def content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def excerpt_around(text: str, previous: str, *, width: int = 400) -> str:
    """A readable excerpt centred on the first divergence from *previous*."""
    if not previous:
        return text[:width]
    limit = min(len(text), len(previous))
    index = next((i for i in range(limit) if text[i] != previous[i]), limit)
    start = max(0, index - width // 2)
    return text[start : start + width]


# --------------------------------------------------------------------------- #
# Ledger                                                                       #
# --------------------------------------------------------------------------- #


def _ledger_path() -> Path:
    return store.store_dir() / "policy_watch.json"


def _blank() -> dict[str, Any]:
    return {"schema": _SCHEMA, "seq": 0, "watches": {}, "candidates": {}, "events": []}


def read_ledger() -> dict[str, Any]:
    path = _ledger_path()
    if not path.exists():
        return _blank()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return _blank()
    if not isinstance(data, dict) or not isinstance(data.get("watches"), dict):
        return _blank()
    for key, default in _blank().items():
        data.setdefault(key, default)
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


def _next_id(ledger: dict[str, Any], prefix: str) -> str:
    ledger["seq"] = int(ledger.get("seq") or 0) + 1
    return f"{prefix}-{ledger['seq']:04d}"


def _event(ledger: dict[str, Any], kind: str, **detail: Any) -> None:
    ledger["events"].append({"event": kind, "at": _now(), **detail})


# --------------------------------------------------------------------------- #
# Watches                                                                      #
# --------------------------------------------------------------------------- #


def default_watches() -> list[dict[str, Any]]:
    """One watch per bundled snapshot, pointing at its recorded source URL."""
    out: list[dict[str, Any]] = []
    for snapshot in policy.load_registry().values():
        if snapshot.status != "current" or not snapshot.source_url:
            continue
        out.append(
            {
                "watch_id": f"watch-{snapshot.platform}-{snapshot.market}".lower(),
                "platform": snapshot.platform,
                "market": snapshot.market,
                "source_url": snapshot.source_url,
                "source_name": snapshot.source_name,
                "snapshot_id": snapshot.version,
                "snapshot_hash": _snapshot_hash(snapshot),
                "allowed": host_allowed(snapshot.source_url),
                "last_checked_at": "",
                "last_status": 0,
                "etag": "",
                "last_modified": "",
                "content_hash": "",
                "last_result": "",
            }
        )
    return out


def _snapshot_hash(snapshot: Any) -> str:
    payload = json.dumps(
        [
            {"id": r.id, "kind": r.kind, "severity": r.severity, "params": dict(r.params or {})}
            for r in snapshot.rules
        ],
        sort_keys=True,
        ensure_ascii=False,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def list_watches() -> list[dict[str, Any]]:
    ledger = read_ledger()
    merged: dict[str, dict[str, Any]] = {w["watch_id"]: w for w in default_watches()}
    for watch_id, stored in ledger["watches"].items():
        if watch_id in merged:
            merged[watch_id] = {**merged[watch_id], **stored}
    return [merged[k] for k in sorted(merged)]


def get_watch(watch_id: str) -> dict[str, Any]:
    for watch in list_watches():
        if watch["watch_id"] == watch_id:
            return watch
    raise PolicyWatchError("unknown_watch", "找不到该政策监视项。", status=404)


# --------------------------------------------------------------------------- #
# Checking                                                                     #
# --------------------------------------------------------------------------- #


def check_watch(watch_id: str) -> dict[str, Any]:
    """Fetch one watched page and record what was found. Activates nothing."""
    watch = get_watch(watch_id)

    try:
        result = fetch(
            watch["source_url"], etag=watch.get("etag", ""), last_modified=watch.get("last_modified", "")
        )
    except PolicyWatchError as exc:
        return _record_failure(watch, exc.code, exc.safe_message)
    except httpx.TimeoutException:
        return _record_failure(watch, "timeout", "抓取超时，未做任何改动。")
    except httpx.HTTPError:
        return _record_failure(watch, "network", "网络错误，未做任何改动。")

    if result["unchanged"]:
        return _record_unchanged(watch, result)

    if result["status"] >= 400:
        return _record_failure(
            watch, "http_status", f"来源返回 HTTP {result['status']}，未做任何改动。",
            status_code=result["status"],
        )

    text = normalize_content(result["body"])
    if not text:
        # Parse failure is an evidence record, never a rule change.
        return _record_failure(
            watch, "parse_failed", "抓取成功但未能解析出正文，已记录，未改动任何规则。",
            status_code=result["status"],
        )

    digest = content_hash(text)
    if digest == watch.get("content_hash"):
        return _record_unchanged(watch, result, digest=digest)

    return _record_candidate(watch, result, text=text, digest=digest)


def _persist_watch(watch_id: str, patch: dict[str, Any], ledger: dict[str, Any]) -> None:
    stored = ledger["watches"].setdefault(watch_id, {"watch_id": watch_id})
    stored.update(patch)


def _record_unchanged(
    watch: dict[str, Any], result: dict[str, Any], *, digest: str = ""
) -> dict[str, Any]:
    with _LOCK:
        ledger = read_ledger()
        _persist_watch(
            watch["watch_id"],
            {
                "last_checked_at": result["fetched_at"],
                "last_status": result["status"],
                "etag": result.get("etag") or watch.get("etag", ""),
                "last_modified": result.get("last_modified") or watch.get("last_modified", ""),
                "content_hash": digest or watch.get("content_hash", ""),
                "last_result": UNCHANGED,
            },
            ledger,
        )
        _event(ledger, "checked", watch_id=watch["watch_id"], result=UNCHANGED)
        _write_ledger(ledger)
    return {"result": UNCHANGED, "watch": get_watch(watch["watch_id"]), "candidate": None}


def _record_failure(
    watch: dict[str, Any], code: str, message: str, *, status_code: int = 0
) -> dict[str, Any]:
    """A failed check is evidence, not a reason to touch a rule."""
    with _LOCK:
        ledger = read_ledger()
        _persist_watch(
            watch["watch_id"],
            {
                "last_checked_at": _now(),
                "last_status": status_code,
                "last_result": FAILED,
                "last_error": code,
                "last_error_message": message,
            },
            ledger,
        )
        _event(ledger, "check_failed", watch_id=watch["watch_id"], code=code, message=message)
        _write_ledger(ledger)
    return {
        "result": FAILED,
        "error": code,
        "message": message,
        "watch": get_watch(watch["watch_id"]),
        "candidate": None,
    }


def _record_candidate(
    watch: dict[str, Any], result: dict[str, Any], *, text: str, digest: str
) -> dict[str, Any]:
    with _LOCK:
        ledger = read_ledger()
        previous_excerpt = ledger.get("last_text", {}).get(watch["watch_id"], "")
        candidate_id = _next_id(ledger, "polcand")
        candidate = {
            "candidate_id": candidate_id,
            "watch_id": watch["watch_id"],
            "platform": watch["platform"],
            "market": watch["market"],
            "source_url": watch["source_url"],
            "source_name": watch.get("source_name", ""),
            "retrieved_at": result["fetched_at"],
            "http_status": result["status"],
            "etag": result.get("etag", ""),
            "last_modified": result.get("last_modified", ""),
            "previous_content_hash": watch.get("content_hash", ""),
            "content_hash": digest,
            "current_snapshot_id": watch["snapshot_id"],
            "current_snapshot_hash": watch["snapshot_hash"],
            "excerpt": excerpt_around(text, previous_excerpt),
            "redirect_hops": result.get("hops", []),
            # A candidate is a *notice*, not a rule. There is no field here that
            # a later step could mistake for an executable policy.
            "state": CHANGED,
            "interpretation": None,
            "reviewed_by": "",
            "reviewed_at": "",
            "review_note": "",
        }
        ledger["candidates"][candidate_id] = candidate
        ledger.setdefault("last_text", {})[watch["watch_id"]] = text[:4000]
        _persist_watch(
            watch["watch_id"],
            {
                "last_checked_at": result["fetched_at"],
                "last_status": result["status"],
                "etag": result.get("etag", ""),
                "last_modified": result.get("last_modified", ""),
                "content_hash": digest,
                "last_result": CHANGED,
            },
            ledger,
        )
        _event(ledger, "candidate_created", watch_id=watch["watch_id"], candidate_id=candidate_id)
        _write_ledger(ledger)
    return {"result": CHANGED, "watch": get_watch(watch["watch_id"]), "candidate": candidate}


def check_all() -> list[dict[str, Any]]:
    """Manual 检查更新 over every watch. Still activates nothing."""
    return [check_watch(watch["watch_id"]) for watch in list_watches()]


# --------------------------------------------------------------------------- #
# Review                                                                       #
# --------------------------------------------------------------------------- #


def list_candidates(*, state: str = "") -> list[dict[str, Any]]:
    rows = [c for c in read_ledger()["candidates"].values() if not state or c["state"] == state]
    return sorted(rows, key=lambda c: c["candidate_id"])


def get_candidate(candidate_id: str) -> dict[str, Any]:
    found = read_ledger()["candidates"].get(candidate_id)
    if found is None:
        raise PolicyWatchError("unknown_candidate", "找不到该政策候选记录。", status=404)
    return dict(found)


def attach_interpretation(
    candidate_id: str, summary: str, *, provider: str = "", model: str = ""
) -> dict[str, Any]:
    """Record a model reading of the change, labelled as exactly that.

    The deterministic policy engine remains authoritative. This is a reading
    aid; it carries no rule and cannot be executed.
    """
    with _LOCK:
        ledger = read_ledger()
        candidate = ledger["candidates"].get(candidate_id)
        if candidate is None:
            raise PolicyWatchError("unknown_candidate", "找不到该政策候选记录。", status=404)
        candidate["interpretation"] = {
            "summary": str(summary or "")[:2000],
            "assisted_by": "model",
            "provider": provider,
            "model": model,
            "authoritative": False,
            "note": "模型解读仅供参考；规则判定以确定性政策引擎与人工复核为准。",
            "at": _now(),
        }
        _write_ledger(ledger)
        return dict(candidate)


def approve_candidate(
    candidate_id: str, *, operator: str, reason: str = ""
) -> dict[str, Any]:
    """Mark a candidate reviewed and cleared for a human to write a snapshot.

    Note what this does *not* do: it does not write a YAML file, register a
    snapshot, or change any rule. Promoting a reviewed change into an executable
    snapshot stays a deliberate authoring step under version control, because a
    rulebook that edits itself from a web page is the failure this whole module
    exists to prevent.
    """
    operator = (operator or "").strip()[:120]
    if not operator:
        raise PolicyWatchError("missing_operator", "请填写复核人。")

    with _LOCK:
        ledger = read_ledger()
        candidate = ledger["candidates"].get(candidate_id)
        if candidate is None:
            raise PolicyWatchError("unknown_candidate", "找不到该政策候选记录。", status=404)
        if candidate["state"] in (APPROVED, REJECTED):
            raise PolicyWatchError("already_reviewed", "该候选记录已复核过。", status=409)
        candidate["state"] = APPROVED
        candidate["reviewed_by"] = operator
        candidate["reviewed_at"] = _now()
        candidate["review_note"] = str(reason or "")[:1000]
        candidate["activation"] = {
            "activated": False,
            "note": (
                "已确认来源确实发生变化。写入并启用新的政策快照仍需在 "
                "api/policy/snapshots/ 中人工提交，不由本流程自动完成。"
            ),
        }
        _event(ledger, "candidate_approved", candidate_id=candidate_id, operator=operator)
        _write_ledger(ledger)
        return dict(candidate)


def reject_candidate(candidate_id: str, *, operator: str, reason: str) -> dict[str, Any]:
    operator = (operator or "").strip()[:120]
    if not operator:
        raise PolicyWatchError("missing_operator", "请填写复核人。")
    if not (reason or "").strip():
        raise PolicyWatchError("missing_reason", "请说明否决原因。")

    with _LOCK:
        ledger = read_ledger()
        candidate = ledger["candidates"].get(candidate_id)
        if candidate is None:
            raise PolicyWatchError("unknown_candidate", "找不到该政策候选记录。", status=404)
        candidate["state"] = REJECTED
        candidate["reviewed_by"] = operator
        candidate["reviewed_at"] = _now()
        candidate["review_note"] = reason.strip()[:1000]
        _event(ledger, "candidate_rejected", candidate_id=candidate_id, operator=operator)
        _write_ledger(ledger)
        return dict(candidate)


def events() -> list[dict[str, Any]]:
    return list(read_ledger()["events"])
