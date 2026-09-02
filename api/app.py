from __future__ import annotations

from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, File, Form, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import evidence
import migration
import policy
from agent import agent_reply
from checker import apply_checks
from generate import generate_drafts
from media import generate_media_image, generate_media_video
from media_errors import MediaError

ROOT = Path(__file__).resolve().parent
DIST = ROOT.parent / "web" / "dist"
# Legacy rules payload is now assembled from the versioned policy snapshots
# (policy/snapshots/*.yaml) so /api/rules stays backward compatible.
RULES = policy.build_legacy_rules()

app = FastAPI(title="跨境上架编译器 listing-api", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class GenerateBody(BaseModel):
    product_name: str = ""
    points: str = ""
    platforms: list[Literal["amazon", "tiktok", "shopify"]] = Field(
        default_factory=lambda: ["amazon", "tiktok", "shopify"]
    )
    asset_mode: Literal["compliant", "promo"] = "compliant"
    uploads: list[str] = Field(default_factory=list)


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/api/rules")
def rules():
    return {"code": 0, "data": RULES}


async def _generate(body: GenerateBody):
    platforms = list(body.platforms) or ["amazon", "tiktok", "shopify"]
    drafts, source = await generate_drafts(
        body.product_name, body.points, platforms, body.asset_mode, body.uploads
    )
    return {"code": 0, "data": {"drafts": drafts, "source": source}}


@app.post("/api/listing/generate")
async def listing_generate(body: GenerateBody):
    return await _generate(body)


@app.post("/api/generate")
async def generate_alias(body: GenerateBody):
    return await _generate(body)


class ValidateBody(BaseModel):
    """Re-grade already-generated drafts against the current policy snapshots."""

    drafts: list[dict[str, Any]] = Field(default_factory=list)
    product_name: str = ""
    points: str = ""
    asset_mode: Literal["compliant", "promo"] = "compliant"


@app.post("/api/listing/validate")
def listing_validate(body: ValidateBody):
    """Run the deterministic checker over supplied drafts.

    Same code path as generation, so an edited or externally-supplied title is
    graded by exactly the rules that gate a generated one. No model is called.
    """
    out = []
    for draft in body.drafts:
        if not isinstance(draft, dict) or draft.get("id") not in ("amazon", "tiktok", "shopify"):
            continue
        out.append(
            apply_checks(
                draft,
                product_name=body.product_name,
                points=body.points,
                asset_mode=body.asset_mode,
            )
        )
    return {"code": 0, "data": {"drafts": out}}


# --------------------------------------------------------------------------- #
# Evidence ledger — uploaded documents, atomic facts, and the release gate.    #
# Deterministic end to end; no model is called by any endpoint here.           #
# --------------------------------------------------------------------------- #


def _evidence_error(exc: evidence.EvidenceError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.http_status,
        content={"code": 1, "error": exc.code, "message": exc.safe_message},
    )


@app.post("/api/evidence/upload")
async def evidence_upload(
    file: UploadFile = File(...),
    expires_on: str = Form(""),
    label: str = Form(""),
):
    """Store one evidence document and fold what it states into the ledger.

    The response never echoes file contents beyond the bounded excerpts that
    become fact links, and nothing about the upload is logged except its id,
    family and size.
    """
    data = await file.read()
    try:
        source = evidence.store.put_source(
            filename=file.filename or "upload",
            declared_mime=file.content_type or "",
            data=data,
            expires_on=expires_on.strip(),
            label=label.strip(),
        )
        locations = evidence.extract.extract_locations(source["family"], data)
        touched = evidence.facts.ingest_document(
            source["source_id"], locations, expires_on=source.get("expires_on", "")
        )
    except evidence.EvidenceError as exc:
        return _evidence_error(exc)

    return {
        "code": 0,
        "data": {
            "source": source,
            "locations": [
                {k: v for k, v in loc.items() if k != "excerpt"} | {
                    "excerpt": (loc.get("excerpt") or "")[:400]
                }
                for loc in locations
            ],
            "facts": touched,
        },
    }


@app.get("/api/evidence/sources")
def evidence_sources():
    return {"code": 0, "data": {"sources": evidence.store.list_sources()}}


@app.delete("/api/evidence/sources/{source_id}")
def evidence_delete_source(source_id: str):
    removed = evidence.store.delete_source(source_id)
    if not removed:
        return _bad("找不到该证据文件。", "unknown_source", 404)
    # Erase the document's contribution to the ledger too, or its values would
    # keep taking part in conflict detection after it is gone.
    touched = evidence.facts.purge_source(source_id)
    return {"code": 0, "data": {"deleted": source_id, "facts_updated": touched}}


class SourceExpiryBody(BaseModel):
    expires_on: str = ""


@app.post("/api/evidence/sources/{source_id}/expiry")
def evidence_set_expiry(source_id: str, body: SourceExpiryBody):
    try:
        return {
            "code": 0,
            "data": {"source": evidence.store.set_expiry(source_id, body.expires_on.strip())},
        }
    except evidence.EvidenceError as exc:
        return _evidence_error(exc)


@app.get("/api/evidence/facts")
def evidence_list_facts():
    return {"code": 0, "data": {"facts": evidence.facts.list_facts()}}


class FactStateBody(BaseModel):
    state: str
    value: str | None = None
    note: str = ""


@app.post("/api/evidence/facts/{fact_id}/state")
def evidence_fact_state(fact_id: str, body: FactStateBody):
    """Operator confirmation or correction — the only route to `verified`."""
    try:
        fact = evidence.facts.set_fact_state(
            fact_id, body.state, value=body.value, note=body.note
        )
    except evidence.EvidenceError as exc:
        return _evidence_error(exc)
    return {"code": 0, "data": {"fact": fact}}


class DeclareFactBody(BaseModel):
    key: str
    claim_type: str = "numeric"
    value: str = ""
    state: str = "unsupported"
    note: str = ""


@app.post("/api/evidence/facts")
def evidence_declare_fact(body: DeclareFactBody):
    try:
        fact = evidence.facts.declare_fact(
            body.key, body.claim_type, value=body.value, state=body.state, note=body.note
        )
    except evidence.EvidenceError as exc:
        return _evidence_error(exc)
    return {"code": 0, "data": {"fact": fact}}


@app.delete("/api/evidence/facts/{fact_id}")
def evidence_delete_fact(fact_id: str):
    if not evidence.facts.delete_fact(fact_id):
        return _bad("找不到该产品事实。", "unknown_fact", 404)
    return {"code": 0, "data": {"deleted": fact_id}}


class EvidenceGateBody(BaseModel):
    drafts: list[dict[str, Any]] = Field(default_factory=list)
    #: The SKU selling points, gated as their own pseudo-field so a claim the
    #: operator asserted in the truth source is checked even when a platform's
    #: generated copy does not repeat it.
    source_points: str = ""


@app.post("/api/evidence/gate")
def evidence_gate(body: EvidenceGateBody):
    """Run the release gate over already-generated drafts.

    Separate from /api/listing/validate on purpose: that endpoint answers
    "does this satisfy the marketplace's formatting rules?", this one answers
    "is every commercial claim backed by evidence we hold?".
    """
    ledger = evidence.facts.facts_by_id()
    results = [
        evidence.gate.evaluate_draft(d, ledger, source_points=body.source_points)
        for d in body.drafts
        if isinstance(d, dict)
    ]
    return {
        "code": 0,
        "data": {
            "results": results,
            "checks": {r["platform"]: evidence.gate.to_checks(r) for r in results},
            "summary": {
                "blocked": sum(1 for r in results if r["verdict"] == "blocked"),
                "needs_review": sum(1 for r in results if r["verdict"] == "needs_review"),
                "ok": sum(1 for r in results if r["verdict"] == "ok"),
                "claims": sum(r["claim_count"] for r in results),
            },
        },
    }


class MediaImageBody(BaseModel):
    prompt: str = ""
    aspect_ratio: str = "1:1"
    resolution: str = "2K"


class MediaVideoBody(BaseModel):
    prompt: str = ""
    aspect_ratio: str = "9:16"
    duration: str = "5s"
    resolution: str = "720p"
    # Optional first frame for image-to-video. HTTP(S) URL or image data URL;
    # anything else is ignored and the request stays text-to-video. With a
    # usable first frame the prompt may be empty (image-to-video needs no
    # motion description); without one a prompt is still required.
    first_frame_url: str | None = None


def _media_error_response(exc: MediaError) -> JSONResponse:
    # code stays 1 for backward compatibility; `error` is the stable slug.
    return JSONResponse(
        status_code=exc.http_status,
        content={"code": 1, "error": exc.code, "message": exc.safe_message},
    )


def _media_unknown_response() -> JSONResponse:
    return JSONResponse(
        status_code=502,
        content={"code": 1, "error": "provider_failure", "message": "模型服务暂时不可用，请稍后重试。"},
    )


@app.post("/api/media/image")
async def media_image(body: MediaImageBody):
    try:
        url = await generate_media_image(body.prompt, body.aspect_ratio)
    except MediaError as exc:
        return _media_error_response(exc)
    except ValueError:
        return _media_unknown_response()
    return {"code": 0, "data": {"url": url}}


@app.post("/api/media/video")
async def media_video(body: MediaVideoBody):
    try:
        url = await generate_media_video(
            body.prompt, body.aspect_ratio, body.duration, body.first_frame_url
        )
    except MediaError as exc:
        return _media_error_response(exc)
    except ValueError:
        return _media_unknown_response()
    return {"code": 0, "data": {"url": url}}


class AgentChatBody(BaseModel):
    messages: list[dict] = Field(default_factory=list)


@app.post("/api/agent/chat")
async def agent_chat(body: AgentChatBody):
    reply = await agent_reply(body.messages)
    return {"code": 0, "data": {"reply": reply}}


# --------------------------------------------------------------------------- #
# Self-healing Listing CI/CD — versioned policy packs + migration workflow.    #
# All deterministic; no endpoint here calls a model unless a request opts in   #
# via `use_model` AND Token Plan is configured.                                #
# --------------------------------------------------------------------------- #


def _bad(message: str, error: str = "bad_request", status: int = 400) -> JSONResponse:
    return JSONResponse(status_code=status, content={"code": 1, "error": error, "message": message})


@app.get("/api/policy/snapshots")
def policy_snapshots():
    return {"code": 0, "data": {"snapshots": policy.list_snapshot_meta()}}


@app.get("/api/policy/diff")
def policy_diff(base: str = Query(...), candidate: str = Query(...)):
    try:
        base_snap = policy.get_snapshot(base)
        cand_snap = policy.get_snapshot(candidate)
    except policy.PolicyError as exc:
        return _bad(str(exc), "unknown_policy_version")
    if base_snap.platform != cand_snap.platform:
        return _bad("两个快照的平台不一致，无法比较。", "platform_mismatch")
    return {"code": 0, "data": policy.diff_snapshots(base_snap, cand_snap).to_dict()}


class ImpactBody(BaseModel):
    artifacts: list[dict[str, Any]] = Field(default_factory=list)
    facts_before: dict[str, str] = Field(default_factory=dict)
    facts_after: dict[str, str] = Field(default_factory=dict)
    base_policy_version: str | None = None
    candidate_policy_version: str | None = None


@app.post("/api/migration/impact")
def migration_impact(body: ImpactBody):
    try:
        data = migration.analyze_impact(
            body.artifacts,
            facts_before=body.facts_before,
            facts_after=body.facts_after,
            base_policy_version=body.base_policy_version,
            candidate_policy_version=body.candidate_policy_version,
        )
    except policy.PolicyError as exc:
        return _bad(str(exc), "unknown_policy_version")
    return {"code": 0, "data": data}


class CandidateBody(BaseModel):
    artifacts: list[dict[str, Any]] = Field(default_factory=list)
    impact: dict[str, Any] = Field(default_factory=dict)
    targets: list[list[str]] | None = None
    facts_before: dict[str, str] = Field(default_factory=dict)
    facts_after: dict[str, str] = Field(default_factory=dict)
    base_policy_version: str | None = None
    candidate_policy_version: str | None = None
    use_model: bool = False


@app.post("/api/migration/candidate")
async def migration_candidate(body: CandidateBody):
    impact = body.impact
    if not impact:
        try:
            impact = migration.analyze_impact(
                body.artifacts,
                facts_before=body.facts_before,
                facts_after=body.facts_after,
                base_policy_version=body.base_policy_version,
                candidate_policy_version=body.candidate_policy_version,
            )
        except policy.PolicyError as exc:
            return _bad(str(exc), "unknown_policy_version")

    targets = (
        [tuple(t) for t in body.targets] if body.targets is not None else None
    )
    model_patch = None
    if body.use_model:
        model_patch = await migration.request_model_patch(
            body.artifacts,
            targets or sorted(migration.impacted_targets(impact)),
            facts_after=body.facts_after,
            candidate_policy_version=body.candidate_policy_version,
        )
    try:
        data = migration.build_candidate_patches(
            body.artifacts,
            impact,
            facts_before=body.facts_before,
            facts_after=body.facts_after,
            base_policy_version=body.base_policy_version,
            candidate_policy_version=body.candidate_policy_version,
            targets=targets,
            model_patch=model_patch,
        )
    except ValueError as exc:
        return _bad(str(exc), "unrelated_target")
    except policy.PolicyError as exc:
        return _bad(str(exc), "unknown_policy_version")
    return {"code": 0, "data": data}


class ApplyBody(BaseModel):
    artifacts: list[dict[str, Any]] = Field(default_factory=list)
    approved_patches: list[dict[str, Any]] = Field(default_factory=list)
    facts_after: dict[str, str] = Field(default_factory=dict)
    candidate_policy_version: str | None = None


@app.post("/api/migration/apply")
def migration_apply(body: ApplyBody):
    try:
        data = migration.apply_patches(
            body.artifacts,
            body.approved_patches,
            facts_after=body.facts_after,
            candidate_policy_version=body.candidate_policy_version,
        )
    except policy.PolicyError as exc:
        return _bad(str(exc), "unknown_policy_version")
    return {"code": 0, "data": data}


class RollbackBody(BaseModel):
    snapshot: dict[str, Any] = Field(default_factory=dict)


@app.post("/api/migration/rollback")
def migration_rollback(body: RollbackBody):
    try:
        data = migration.rollback(body.snapshot)
    except ValueError as exc:
        return _bad(str(exc), "bad_snapshot")
    return {"code": 0, "data": data}


class ReportBody(BaseModel):
    impact: dict[str, Any] = Field(default_factory=dict)
    candidate: dict[str, Any] | None = None
    apply_result: dict[str, Any] | None = None
    status: str = "candidate"
    base_policy_version: str | None = None
    candidate_policy_version: str | None = None
    validation_before: list[dict[str, Any]] | None = None
    validation_after: list[dict[str, Any]] | None = None


@app.post("/api/migration/report")
def migration_report(body: ReportBody, format: str = Query("json")):
    try:
        report = migration.build_report(
            impact=body.impact,
            candidate=body.candidate,
            apply_result=body.apply_result,
            status=body.status,
            base_policy_version=body.base_policy_version,
            candidate_policy_version=body.candidate_policy_version,
            validation_before=body.validation_before,
            validation_after=body.validation_after,
        )
    except (ValueError, KeyError, policy.PolicyError) as exc:
        return _bad(str(exc), "bad_report_input")
    if format == "html":
        return HTMLResponse(migration.render_report_html(report))
    return {"code": 0, "data": report}


if DIST.is_dir():
    assets = DIST / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    @app.get("/")
    def index():
        return FileResponse(DIST / "index.html", headers={"Cache-Control": "no-cache"})

    @app.get("/{path:path}")
    def spa(path: str):
        target = (DIST / path).resolve()
        if DIST in target.parents and target.is_file():
            return FileResponse(target)
        return FileResponse(DIST / "index.html", headers={"Cache-Control": "no-cache"})
