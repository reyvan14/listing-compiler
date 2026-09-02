from __future__ import annotations

from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

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
