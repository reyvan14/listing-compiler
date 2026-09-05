"""Post-launch feedback: measure, suggest, and never claim to have proved.

Performance data is where a listing tool is most tempted to lie. It is easy to
write "this title change lifted CTR 18%" from two numbers that merely differ,
and almost nobody checks. So the rules here are narrow on purpose.

**Correlation is reported as correlation.** Comparisons carry both sample sizes
and both time windows, and every summary says what it observed rather than what
it caused. There is no uplift prediction anywhere in this module, because there
is no experiment design behind the imported rows that would justify one.

**Signals become candidates, never edits.** A detected problem produces a
proposal -- affected field, suggested direction, the rows that support it, the
risk of acting on it -- which enters the existing revision lifecycle as a draft.
Nothing here writes to an approved revision.

**Bad rows do not poison good ones.** Each row is validated on its own; the
invalid ones are reported with their line numbers and the rest are kept.

Everything is deterministic arithmetic over imported rows. No model is called,
and no marketplace is contacted -- this is a spreadsheet importer, and it says
so rather than implying a live integration.
"""

from __future__ import annotations

import csv
import io
import json
import os
import re
import statistics
import tempfile
import threading
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

from evidence import store

_LOCK = threading.RLock()
_SCHEMA = "listing-feedback/v1"

MAX_IMPORT_BYTES = 8 * 1024 * 1024
MAX_ROWS = 5000

#: The columns the template ships with. Only a few are mandatory; the rest widen
#: what can be detected but never block an import.
COLUMNS = (
    "sku",
    "platform",
    "revision_id",
    "period_start",
    "period_end",
    "impressions",
    "clicks",
    "add_to_cart",
    "purchases",
    "revenue",
    "returns",
    "return_reason",
    "review_text",
    "rating",
)

REQUIRED_COLUMNS = ("sku", "platform", "revision_id", "period_start", "period_end", "impressions")

TEMPLATE_CSV = (
    ",".join(COLUMNS)
    + "\n"
    + "AERO-350,amazon,rev-0001,2026-08-01,2026-08-14,12000,180,40,12,358.80,1,尺寸与描述不符,"
    "杯子比想象中小,3\n"
    "AERO-350,amazon,rev-0002,2026-08-15,2026-08-28,11800,412,96,31,926.90,1,,"
    "折叠很方便,5\n"
    "AERO-350,tiktok,rev-0003,2026-08-15,2026-08-28,9400,290,70,9,268.20,3,颜色偏差,"
    "颜色和图片不一样,2\n"
)

PLATFORMS = ("amazon", "tiktok", "shopify")


class FeedbackError(ValueError):
    def __init__(self, code: str, message: str, status: int = 400) -> None:
        self.code = code
        self.safe_message = message
        self.http_status = status
        super().__init__(message)


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


# --------------------------------------------------------------------------- #
# Parsing                                                                      #
# --------------------------------------------------------------------------- #


def _number(raw: Any, *, field: str, line: int, allow_blank: bool = True) -> "float | None":
    text = str(raw if raw is not None else "").strip().replace(",", "")
    if not text:
        if allow_blank:
            return None
        raise FeedbackError("missing_value", f"第 {line} 行缺少 {field}")
    try:
        value = float(text)
    except ValueError as exc:
        raise FeedbackError("bad_number", f"第 {line} 行的 {field} 不是数字：{text[:40]}") from exc
    if value < 0:
        raise FeedbackError("negative_value", f"第 {line} 行的 {field} 不能为负数")
    return value


def _iso_date(raw: Any, *, field: str, line: int) -> str:
    text = str(raw or "").strip()
    if not text:
        raise FeedbackError("missing_value", f"第 {line} 行缺少 {field}")
    try:
        return date.fromisoformat(text).isoformat()
    except ValueError as exc:
        raise FeedbackError("bad_date", f"第 {line} 行的 {field} 不是 YYYY-MM-DD：{text[:40]}") from exc


def parse_rows(data: bytes) -> dict[str, Any]:
    """Parse an import. Each row stands or falls alone.

    A file where row 3 is malformed still imports rows 1, 2 and 4 -- losing a
    whole month of data to one bad cell would be a worse failure than the cell.
    """
    if not data:
        raise FeedbackError("empty_file", "文件为空。")
    if len(data) > MAX_IMPORT_BYTES:
        raise FeedbackError(
            "file_too_large", f"文件超过 {MAX_IMPORT_BYTES // (1024 * 1024)} MB 上限。", status=413
        )

    text = data.decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        raise FeedbackError("no_header", "缺少表头行。")

    header = {(name or "").strip().lower() for name in reader.fieldnames}
    missing = [c for c in REQUIRED_COLUMNS if c not in header]
    if missing:
        raise FeedbackError("missing_columns", f"缺少必需列：{'、'.join(missing)}")

    rows: list[dict[str, Any]] = []
    problems: list[dict[str, Any]] = []

    for index, raw in enumerate(reader, start=2):
        if index - 1 > MAX_ROWS:
            problems.append({"line": index, "code": "too_many_rows", "message": f"超过 {MAX_ROWS} 行上限，其余未导入。"})
            break
        clean = {(k or "").strip().lower(): (v or "").strip() for k, v in raw.items() if k}
        try:
            rows.append(_row(clean, index))
        except FeedbackError as exc:
            problems.append({"line": index, "code": exc.code, "message": exc.safe_message})

    return {"rows": rows, "problems": problems}


def _row(clean: dict[str, str], line: int) -> dict[str, Any]:
    platform = clean.get("platform", "").lower()
    if platform not in PLATFORMS:
        raise FeedbackError("bad_platform", f"第 {line} 行的平台无法识别：{platform or '(空)'}")
    if not clean.get("sku"):
        raise FeedbackError("missing_value", f"第 {line} 行缺少 sku")
    if not clean.get("revision_id"):
        raise FeedbackError("missing_value", f"第 {line} 行缺少 revision_id")

    start = _iso_date(clean.get("period_start"), field="period_start", line=line)
    end = _iso_date(clean.get("period_end"), field="period_end", line=line)
    if end < start:
        raise FeedbackError("bad_period", f"第 {line} 行的结束日期早于开始日期")

    impressions = _number(clean.get("impressions"), field="impressions", line=line, allow_blank=False)
    clicks = _number(clean.get("clicks"), field="clicks", line=line)
    add_to_cart = _number(clean.get("add_to_cart"), field="add_to_cart", line=line)
    purchases = _number(clean.get("purchases"), field="purchases", line=line)
    revenue = _number(clean.get("revenue"), field="revenue", line=line)
    returns = _number(clean.get("returns"), field="returns", line=line)
    rating = _number(clean.get("rating"), field="rating", line=line)

    if clicks is not None and impressions is not None and clicks > impressions:
        raise FeedbackError("impossible_row", f"第 {line} 行的点击数超过曝光数")
    if purchases is not None and clicks is not None and purchases > clicks:
        raise FeedbackError("impossible_row", f"第 {line} 行的成交数超过点击数")

    return {
        "line": line,
        "sku": clean["sku"],
        "platform": platform,
        "revision_id": clean["revision_id"],
        "period_start": start,
        "period_end": end,
        "impressions": impressions,
        "clicks": clicks,
        "add_to_cart": add_to_cart,
        "purchases": purchases,
        "revenue": revenue,
        "returns": returns,
        "return_reason": clean.get("return_reason", "")[:200],
        "review_text": clean.get("review_text", "")[:500],
        "rating": rating,
    }


# --------------------------------------------------------------------------- #
# Metrics                                                                      #
# --------------------------------------------------------------------------- #


def _ratio(numerator: "float | None", denominator: "float | None") -> "float | None":
    if numerator is None or denominator in (None, 0):
        return None
    return round(numerator / denominator, 6)


def aggregate(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Deterministic totals and rates, with missing inputs reported not guessed."""
    if not rows:
        return {"rows": 0, "warnings": ["没有可用数据。"]}

    def total(field: str) -> "float | None":
        values = [r[field] for r in rows if r.get(field) is not None]
        return sum(values) if values else None

    impressions = total("impressions")
    clicks = total("clicks")
    purchases = total("purchases")
    add_to_cart = total("add_to_cart")
    revenue = total("revenue")
    returns = total("returns")

    warnings: list[str] = []
    for field, value in (
        ("clicks", clicks), ("purchases", purchases), ("revenue", revenue), ("returns", returns),
    ):
        missing = sum(1 for r in rows if r.get(field) is None)
        if missing:
            warnings.append(f"{missing}/{len(rows)} 行缺少 {field}，相关比率按有数据的行计算。")

    return {
        "rows": len(rows),
        "impressions": impressions,
        "clicks": clicks,
        "add_to_cart": add_to_cart,
        "purchases": purchases,
        "revenue": revenue,
        "returns": returns,
        "ctr": _ratio(clicks, impressions),
        "cvr": _ratio(purchases, clicks),
        "atc_rate": _ratio(add_to_cart, clicks),
        "return_rate": _ratio(returns, purchases),
        "period_start": min(r["period_start"] for r in rows),
        "period_end": max(r["period_end"] for r in rows),
        "warnings": warnings,
    }


def compare(
    left_rows: list[dict[str, Any]], right_rows: list[dict[str, Any]], *, left: str, right: str
) -> dict[str, Any]:
    """Compare two groups, reporting both sample sizes and both windows.

    The deltas here are differences between observations. They are not effects,
    and this function will not describe them as effects: an A/B label on
    imported spreadsheet rows is not a controlled experiment, and pretending
    otherwise is the failure mode this whole module is written against.
    """
    a = aggregate(left_rows)
    b = aggregate(right_rows)

    def delta(metric: str) -> "dict[str, Any] | None":
        x, y = a.get(metric), b.get(metric)
        if x is None or y is None:
            return None
        return {
            "left": x,
            "right": y,
            "absolute": round(y - x, 6),
            "relative": round((y - x) / x, 6) if x else None,
        }

    low_sample = (a.get("impressions") or 0) < 1000 or (b.get("impressions") or 0) < 1000
    return {
        "left_label": left,
        "right_label": right,
        "left": a,
        "right": b,
        "deltas": {m: delta(m) for m in ("ctr", "cvr", "atc_rate", "return_rate", "revenue")},
        "left_sample": {"rows": a["rows"], "impressions": a.get("impressions"), "window": [a.get("period_start"), a.get("period_end")]},
        "right_sample": {"rows": b["rows"], "impressions": b.get("impressions"), "window": [b.get("period_start"), b.get("period_end")]},
        "low_sample": low_sample,
        # Said in the payload, not only in the UI, so no caller can lose it.
        "causality_note": (
            "这是两组观测数据的差异，不是因果结论。时间窗口、季节性、投放预算与其他改动都可能造成差异。"
        ),
        "warnings": a["warnings"] + b["warnings"] + (
            ["样本量偏小（任一组曝光不足 1000），差异可能只是噪声。"] if low_sample else []
        ),
    }


# --------------------------------------------------------------------------- #
# Signals                                                                      #
# --------------------------------------------------------------------------- #

#: Thresholds for the four detections the spec names. Conservative, and stated
#: in the output so a reader can disagree with them.
CTR_FLOOR = 0.01
CVR_FLOOR = 0.02
RETURN_CEILING = 0.08
MIN_IMPRESSIONS = 1000
MIN_CLICKS = 50
THEME_MIN_COUNT = 2

_STOPWORDS = frozenset(
    {"的", "了", "和", "是", "很", "也", "就", "都", "but", "the", "and", "for", "with", "this", "that"}
)


def detect_signals(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Deterministic detections over the imported rows."""
    signals: list[dict[str, Any]] = []
    by_revision: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        by_revision.setdefault(row["revision_id"], []).append(row)

    for revision_id, group in sorted(by_revision.items()):
        stats = aggregate(group)
        lines = [r["line"] for r in group]

        if (stats.get("impressions") or 0) >= MIN_IMPRESSIONS and stats.get("ctr") is not None:
            if stats["ctr"] < CTR_FLOOR:
                signals.append(
                    _signal(
                        "high_impressions_low_ctr",
                        revision_id,
                        f"曝光 {int(stats['impressions'])}，点击率 {stats['ctr']:.2%}，低于 {CTR_FLOOR:.0%}。",
                        field="标题",
                        proposal="标题未能吸引点击：把最具体的事实属性（规格/容量/材质）前置，去掉泛化形容词。",
                        rows=lines,
                        confidence="medium",
                        risks="点击率也受主图、价格与排名影响；仅凭本数据无法归因到标题。",
                        observed={"impressions": stats["impressions"], "ctr": stats["ctr"]},
                    )
                )
            elif (stats.get("clicks") or 0) >= MIN_CLICKS and stats.get("cvr") is not None and stats["cvr"] < CVR_FLOOR:
                signals.append(
                    _signal(
                        "acceptable_ctr_low_cvr",
                        revision_id,
                        f"点击率 {stats['ctr']:.2%} 尚可，但转化率 {stats['cvr']:.2%} 低于 {CVR_FLOOR:.0%}。",
                        field="五点/描述",
                        proposal="点进来后没被说服：在五点中补齐尺寸、材质与使用场景等可核实事实。",
                        rows=lines,
                        confidence="medium",
                        risks="转化率同样受价格、评价数与库存状态影响。",
                        observed={"ctr": stats["ctr"], "cvr": stats["cvr"]},
                    )
                )

        if stats.get("return_rate") is not None and stats["return_rate"] > RETURN_CEILING:
            signals.append(
                _signal(
                    "elevated_return_rate",
                    revision_id,
                    f"退货率 {stats['return_rate']:.2%}，高于 {RETURN_CEILING:.0%}。",
                    field="描述/主图",
                    proposal="退货率偏高常源于预期不符：核对尺寸、容量与颜色描述是否与实物一致。",
                    rows=lines,
                    confidence="high",
                    risks="退货原因可能与物流或批次质量有关，与文案无关。",
                    observed={"return_rate": stats["return_rate"], "returns": stats.get("returns")},
                )
            )

        themes = _themes(group)
        for theme, occurrences in themes:
            signals.append(
                _signal(
                    "repeated_theme",
                    revision_id,
                    f"「{theme}」在退货原因或评价中出现 {len(occurrences)} 次。",
                    field="描述",
                    proposal=f"多位买家提到「{theme}」：核对该点在文案中的表述是否准确。",
                    rows=[o["line"] for o in occurrences],
                    confidence="low" if len(occurrences) < 3 else "medium",
                    risks="重复词只是共现，不代表原因；需要人工阅读原文判断。",
                    observed={"theme": theme, "count": len(occurrences)},
                    quotes=[o["quote"] for o in occurrences][:5],
                )
            )

    return signals


def _signal(
    kind: str,
    revision_id: str,
    observed_text: str,
    *,
    field: str,
    proposal: str,
    rows: list[int],
    confidence: str,
    risks: str,
    observed: dict[str, Any],
    quotes: "list[str] | None" = None,
) -> dict[str, Any]:
    return {
        "signal": kind,
        "revision_id": revision_id,
        "observed": observed_text,
        "measurements": observed,
        "affected_field": field,
        "proposal": proposal,
        "supporting_rows": rows,
        "quotes": quotes or [],
        "confidence": confidence,
        "risks": risks,
        # Every signal carries this. It is a correlation, and it says so.
        "causality": "观测到的相关性，不是因果结论。",
    }


def _themes(rows: list[dict[str, Any]]) -> list[tuple[str, list[dict[str, Any]]]]:
    """Repeated words across return reasons and review text, with their sources."""
    buckets: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        blob = f"{row.get('return_reason', '')} {row.get('review_text', '')}".strip()
        if not blob:
            continue
        for token in _tokens(blob):
            buckets.setdefault(token, []).append({"line": row["line"], "quote": blob[:120]})
    return [
        (token, hits)
        for token, hits in sorted(buckets.items())
        if len(hits) >= THEME_MIN_COUNT
    ]


def _tokens(text: str) -> set[str]:
    words = re.findall(r"[A-Za-z]{3,}|[一-鿿]{2,}", text.lower())
    return {w for w in words if w not in _STOPWORDS}


# --------------------------------------------------------------------------- #
# Persistence                                                                  #
# --------------------------------------------------------------------------- #


def _ledger_path() -> Path:
    return store.store_dir() / "feedback.json"


def _blank() -> dict[str, Any]:
    return {"schema": _SCHEMA, "seq": 0, "imports": {}, "experiments": {}, "promotions": {}}


def read_ledger() -> dict[str, Any]:
    path = _ledger_path()
    if not path.exists():
        return _blank()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return _blank()
    if not isinstance(data, dict) or not isinstance(data.get("imports"), dict):
        return _blank()
    data.setdefault("experiments", {})
    data.setdefault("promotions", {})
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


def _next_id(ledger: dict[str, Any], prefix: str) -> str:
    ledger["seq"] = int(ledger.get("seq") or 0) + 1
    return f"{prefix}-{ledger['seq']:04d}"


def create_import(data: bytes, *, filename: str = "") -> dict[str, Any]:
    parsed = parse_rows(data)
    with _LOCK:
        ledger = read_ledger()
        import_id = _next_id(ledger, "imp")
        record = {
            "import_id": import_id,
            "filename": filename[:200],
            "imported_at": _now(),
            "row_count": len(parsed["rows"]),
            "problem_count": len(parsed["problems"]),
            "rows": parsed["rows"],
            "problems": parsed["problems"],
            "source": "spreadsheet",
            # Stated in the record: this is an import, not a marketplace feed.
            "live_integration": False,
            "note": "数据来自人工导入的表格，不是平台实时接口。",
        }
        ledger["imports"][import_id] = record
        _write_ledger(ledger)
    return {k: v for k, v in record.items() if k != "rows"} | {"rows": parsed["rows"][:50]}


def get_import(import_id: str) -> dict[str, Any]:
    found = read_ledger()["imports"].get(import_id)
    if found is None:
        raise FeedbackError("unknown_import", "找不到该导入记录。", status=404)
    return dict(found)


def list_imports() -> list[dict[str, Any]]:
    return [
        {k: v for k, v in row.items() if k != "rows"}
        for row in sorted(read_ledger()["imports"].values(), key=lambda r: r["import_id"])
    ]


def analyze_import(import_id: str) -> dict[str, Any]:
    """Aggregate, detect and propose. Deterministic; writes no revision."""
    record = get_import(import_id)
    rows = record["rows"]
    signals = detect_signals(rows)

    by_platform: dict[str, list[dict[str, Any]]] = {}
    by_revision: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        by_platform.setdefault(row["platform"], []).append(row)
        by_revision.setdefault(row["revision_id"], []).append(row)

    return {
        "import_id": import_id,
        "overall": aggregate(rows),
        "by_platform": {k: aggregate(v) for k, v in sorted(by_platform.items())},
        "by_revision": {k: aggregate(v) for k, v in sorted(by_revision.items())},
        "signals": signals,
        "candidate_count": len(signals),
        "problems": record["problems"],
        "live_integration": False,
        "note": "全部为导入数据的确定性统计；提出的都是候选改进项，不会自动修改任何修订。",
    }


def compare_revisions(import_id: str, left: str, right: str) -> dict[str, Any]:
    record = get_import(import_id)
    rows = record["rows"]
    return compare(
        [r for r in rows if r["revision_id"] == left],
        [r for r in rows if r["revision_id"] == right],
        left=left,
        right=right,
    )


def compare_platforms(import_id: str, left: str, right: str) -> dict[str, Any]:
    record = get_import(import_id)
    rows = record["rows"]
    return compare(
        [r for r in rows if r["platform"] == left],
        [r for r in rows if r["platform"] == right],
        left=left,
        right=right,
    )


def compare_periods(import_id: str, split_date: str) -> dict[str, Any]:
    record = get_import(import_id)
    rows = record["rows"]
    return compare(
        [r for r in rows if r["period_end"] < split_date],
        [r for r in rows if r["period_start"] >= split_date],
        left=f"< {split_date}",
        right=f"≥ {split_date}",
    )


# --------------------------------------------------------------------------- #
# Candidates into the review lifecycle                                         #
# --------------------------------------------------------------------------- #


def promote_signal(
    import_id: str,
    signal_index: int,
    *,
    operator: str,
    content: dict[str, Any],
    idempotency_key: str = "",
) -> dict[str, Any]:
    """Turn a signal into a candidate revision through the existing workflow.

    It goes in as a draft via ``review.save_draft``, which forks rather than
    overwrites when the source revision has been approved. A feedback signal
    never edits a live listing.

    The promotion is recorded against an idempotency key so a double click, a
    retry or a reconnect produces one candidate rather than a pile of
    near-identical drafts. The record is also the provenance link: import →
    signal → candidate revision, kept so a reviewer can ask where a change came
    from months later.
    """
    import review

    operator = (operator or "").strip()[:120]
    if not operator:
        raise FeedbackError("missing_operator", "请填写操作人。")

    key = (idempotency_key or f"{import_id}:{signal_index}").strip()[:160]
    with _LOCK:
        ledger = read_ledger()
        previous = (ledger.get("promotions") or {}).get(key)
    if previous:
        return {**previous, "replayed": True}

    analysis = analyze_import(import_id)
    try:
        signal = analysis["signals"][signal_index]
    except (IndexError, TypeError) as exc:
        raise FeedbackError("unknown_signal", "找不到该改进信号。", status=404) from exc

    try:
        revision = review.save_draft(signal["revision_id"], content, operator=operator)
    except review.ReviewError as exc:
        raise FeedbackError(exc.code, exc.safe_message, status=exc.http_status) from exc

    result = {
        "signal": signal,
        "revision": revision,
        "baseline_revision_id": signal["revision_id"],
        "forked": revision["revision_id"] != signal["revision_id"],
        # The traceable chain the spec asks for, stored rather than reconstructed.
        "provenance": {
            "import_id": import_id,
            "signal_index": signal_index,
            "signal": signal["signal"],
            "baseline_revision_id": signal["revision_id"],
            "candidate_revision_id": revision["revision_id"],
            "supporting_rows": signal["supporting_rows"],
            "operator": operator,
            "at": _now(),
        },
        "note": "已作为候选修订进入审核流程；原已批准修订未被改动。",
        "replayed": False,
    }
    with _LOCK:
        ledger = read_ledger()
        ledger.setdefault("promotions", {})[key] = result
        _write_ledger(ledger)
    return result


def promotions() -> list[dict[str, Any]]:
    """Every feedback-driven candidate, with its provenance chain."""
    return [row["provenance"] for row in (read_ledger().get("promotions") or {}).values()]


# --------------------------------------------------------------------------- #
# Experiments                                                                  #
# --------------------------------------------------------------------------- #

EXPERIMENT_STATES = ("draft", "running", "stopped", "concluded")


def create_experiment(
    *,
    hypothesis: str,
    baseline_revision_id: str,
    candidate_revision_id: str = "",
    changed_fields: "list[str] | None" = None,
    start_date: str = "",
    end_date: str = "",
    primary_metric: str = "cvr",
    guardrail_metrics: "list[str] | None" = None,
) -> dict[str, Any]:
    hypothesis = (hypothesis or "").strip()[:500]
    if not hypothesis:
        raise FeedbackError("missing_hypothesis", "请填写实验假设。")
    if not (baseline_revision_id or "").strip():
        raise FeedbackError("missing_baseline", "请指定基线修订。")

    with _LOCK:
        ledger = read_ledger()
        experiment_id = _next_id(ledger, "exp")
        experiment = {
            "experiment_id": experiment_id,
            "hypothesis": hypothesis,
            "baseline_revision_id": baseline_revision_id.strip(),
            "candidate_revision_id": (candidate_revision_id or "").strip(),
            "changed_fields": list(changed_fields or []),
            "start_date": start_date,
            "end_date": end_date,
            "primary_metric": primary_metric,
            "guardrail_metrics": list(guardrail_metrics or ["return_rate", "revenue"]),
            "state": "draft",
            "created_at": _now(),
            "result": None,
            "note": "实验记录只描述计划与观测，不预测提升幅度。",
        }
        ledger["experiments"][experiment_id] = experiment
        _write_ledger(ledger)
    return dict(experiment)


def list_experiments() -> list[dict[str, Any]]:
    return sorted(read_ledger()["experiments"].values(), key=lambda e: e["experiment_id"])


def set_experiment_state(experiment_id: str, state: str) -> dict[str, Any]:
    if state not in EXPERIMENT_STATES:
        raise FeedbackError("bad_state", f"未知的实验状态：{state}")
    with _LOCK:
        ledger = read_ledger()
        experiment = ledger["experiments"].get(experiment_id)
        if experiment is None:
            raise FeedbackError("unknown_experiment", "找不到该实验。", status=404)
        experiment["state"] = state
        experiment["updated_at"] = _now()
        _write_ledger(ledger)
        return dict(experiment)


def conclude_experiment(experiment_id: str, import_id: str) -> dict[str, Any]:
    """Attach an observed comparison to an experiment. Still not a causal claim."""
    with _LOCK:
        ledger = read_ledger()
        experiment = ledger["experiments"].get(experiment_id)
        if experiment is None:
            raise FeedbackError("unknown_experiment", "找不到该实验。", status=404)

    if not experiment["candidate_revision_id"]:
        raise FeedbackError("missing_candidate", "该实验没有候选修订，无法比较。")

    observed = compare_revisions(
        import_id, experiment["baseline_revision_id"], experiment["candidate_revision_id"]
    )
    with _LOCK:
        ledger = read_ledger()
        experiment = ledger["experiments"][experiment_id]
        experiment["state"] = "concluded"
        experiment["result"] = {
            "import_id": import_id,
            "observed": observed,
            "primary_metric": experiment["primary_metric"],
            "concluded_at": _now(),
            "interpretation": (
                "以上为两组观测数据的差异。是否采纳需人工判断，本工具不做因果推断，"
                "也不预测提升幅度。"
            ),
        }
        _write_ledger(ledger)
        return dict(experiment)
