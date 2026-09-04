from __future__ import annotations

import asyncio
import base64
import binascii
import logging

from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, File, Form, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import (
    FileResponse,
    HTMLResponse,
    JSONResponse,
    Response,
    StreamingResponse,
)
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import agent_plan
import evidence
import imagecheck
import mediaassets
import passport
import migration
import policy
import portfolio
import review
import agent_stream
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


@app.middleware("http")
async def scope_evidence_ledger(request: Request, call_next):
    """Keep the public demo's mutable data browser/product isolated.

    Review revisions and inspected media live in the same scoped directory as
    the evidence they are graded against, so they share one scope rather than
    inventing a second.

    The scope normally arrives in headers. Query parameters are accepted as a
    fallback because an ``<img src>`` cannot carry headers, and the inspected
    original has to be openable in the lightbox. That is not a weakening: these
    ids are client-supplied isolation keys, not credentials, and the store
    hashes them before they become a path segment either way.
    """
    if not request.url.path.startswith(
        ("/api/evidence", "/api/review", "/api/media/assets", "/api/passport")
    ):
        return await call_next(request)
    params = request.query_params
    tokens = evidence.store.push_scope(
        request.headers.get("x-workspace-id") or params.get("workspace") or "public",
        request.headers.get("x-product-id") or params.get("product") or "default-product",
    )
    try:
        return await call_next(request)
    finally:
        evidence.store.pop_scope(tokens)


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


async def _read_bounded_upload(file: UploadFile) -> bytes:
    """Never materialise an unbounded public upload in process memory."""
    return await file.read(evidence.store.MAX_UPLOAD_BYTES + 1)


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
    data = await _read_bounded_upload(file)
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


# --------------------------------------------------------------------------- #
# Listing review — editable revisions, deterministic validation, human         #
# approval. Nothing here calls a model, and nothing here publishes anywhere.   #
# --------------------------------------------------------------------------- #


def _review_error(exc: review.ReviewError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.http_status,
        content={"code": 1, "error": exc.code, "message": exc.safe_message},
    )


class RevisionContent(BaseModel):
    title: str = ""
    fields: list[dict[str, Any]] = Field(default_factory=list)


class CreateRevisionBody(BaseModel):
    sku_id: str
    platform: Literal["amazon", "tiktok", "shopify"]
    content: RevisionContent
    project_id: str = ""
    market: str = "US"
    locale: str = "en-US"
    source: str = "generated"
    generator: dict[str, Any] = Field(default_factory=dict)
    product_name: str = ""
    points: str = ""
    asset_mode: Literal["compliant", "promo"] = "compliant"


@app.post("/api/review/revisions")
def review_create_revision(body: CreateRevisionBody):
    """Register a generated listing as revision 1 of a reviewable lineage.

    Idempotent for identical generated content, so reopening the reviewer or
    reloading the page cannot manufacture review history.
    """
    try:
        revision = review.create_revision(
            sku_id=body.sku_id,
            platform=body.platform,
            content=body.content.model_dump(),
            project_id=body.project_id,
            market=body.market,
            locale=body.locale,
            source=body.source,
            generator=body.generator,
            product_name=body.product_name,
            points=body.points,
            asset_mode=body.asset_mode,
        )
    except review.ReviewError as exc:
        return _review_error(exc)
    return {"code": 0, "data": {"revision": revision}}


@app.get("/api/review/revisions")
def review_list_revisions(sku_id: str = Query(""), platform: str = Query("")):
    return {
        "code": 0,
        "data": {"revisions": review.list_revisions(sku_id=sku_id, platform=platform)},
    }


@app.get("/api/review/revisions/{revision_id}")
def review_get_revision(revision_id: str):
    try:
        return {"code": 0, "data": review.revision_view(revision_id)}
    except review.ReviewError as exc:
        return _review_error(exc)


class SaveDraftBody(BaseModel):
    content: RevisionContent
    operator: str = ""


@app.post("/api/review/revisions/{revision_id}/draft")
def review_save_draft(revision_id: str, body: SaveDraftBody):
    """Save edited copy. Forks a new revision if this one has left ``draft``."""
    try:
        revision = review.save_draft(
            revision_id, body.content.model_dump(), operator=body.operator
        )
    except review.ReviewError as exc:
        return _review_error(exc)
    return {"code": 0, "data": {"revision": revision, "forked": revision["revision_id"] != revision_id}}


class OperatorBody(BaseModel):
    operator: str = ""
    reason: str = ""


@app.post("/api/review/revisions/{revision_id}/validate")
def review_validate(revision_id: str, body: OperatorBody):
    try:
        revision = review.submit_for_validation(revision_id, operator=body.operator)
    except review.ReviewError as exc:
        return _review_error(exc)
    return {"code": 0, "data": review.revision_view(revision["revision_id"])}


@app.post("/api/review/revisions/{revision_id}/approve")
def review_approve(revision_id: str, body: OperatorBody):
    try:
        result = review.approve(revision_id, operator=body.operator, reason=body.reason)
    except review.ReviewError as exc:
        return _review_error(exc)
    return {
        "code": 0,
        "data": {**review.revision_view(revision_id), "superseded": result["superseded"]},
    }


@app.post("/api/review/revisions/{revision_id}/request-changes")
def review_request_changes(revision_id: str, body: OperatorBody):
    try:
        review.request_changes(revision_id, operator=body.operator, reason=body.reason)
    except review.ReviewError as exc:
        return _review_error(exc)
    return {"code": 0, "data": review.revision_view(revision_id)}


@app.post("/api/review/revisions/{revision_id}/rollback")
def review_rollback(revision_id: str, body: OperatorBody):
    """Restore this revision's exact content as a new, re-validated revision."""
    try:
        result = review.rollback_to(revision_id, operator=body.operator, reason=body.reason)
    except review.ReviewError as exc:
        return _review_error(exc)
    return {
        "code": 0,
        "data": {
            **review.revision_view(result["revision"]["revision_id"]),
            "rolled_back": result["rolled_back"],
        },
    }


class AcknowledgeBody(BaseModel):
    warning_ids: list[str] = Field(default_factory=list)
    operator: str = ""
    reason: str = ""


@app.post("/api/review/revisions/{revision_id}/acknowledge")
def review_acknowledge(revision_id: str, body: AcknowledgeBody):
    try:
        review.acknowledge_warnings(
            revision_id, body.warning_ids, operator=body.operator, reason=body.reason
        )
    except review.ReviewError as exc:
        return _review_error(exc)
    return {"code": 0, "data": review.revision_view(revision_id)}


@app.get("/api/review/diff")
def review_diff(base: str = Query(...), target: str = Query(...)):
    try:
        return {"code": 0, "data": review.diff_revisions(base, target)}
    except review.ReviewError as exc:
        return _review_error(exc)


# --------------------------------------------------------------------------- #
# Image compliance inspection. Every verdict is measured from decoded pixels    #
# against the same versioned policy snapshots that gate the text; nothing here  #
# infers a result from a prompt, a filename or an asset mode.                   #
# --------------------------------------------------------------------------- #


def _image_error(exc: imagecheck.ImageInspectionError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.http_status,
        content={"code": 1, "error": exc.code, "message": exc.safe_message},
    )


def _decode_data_url(value: str) -> "tuple[bytes, str]":
    """Bytes and declared MIME from a ``data:image/...;base64,`` URL.

    Only data URLs are accepted. Fetching an arbitrary caller-supplied URL from
    the server would make this endpoint a request forwarder into whatever the
    backend can reach, which is not a trade worth making for a convenience.
    """
    raw = (value or "").strip()
    if not raw.startswith("data:"):
        raise imagecheck.ImageInspectionError(
            "unsupported_source",
            "只接受 data: 开头的图片内容；服务器不会代为抓取任意 URL。",
            status=422,
        )
    header, _, payload = raw.partition(",")
    if not payload:
        raise imagecheck.ImageInspectionError("bad_data_url", "图片内容为空或格式不正确。")
    mime = header[5:].split(";")[0].strip().lower()
    if "base64" not in header:
        raise imagecheck.ImageInspectionError("bad_data_url", "仅支持 base64 编码的 data URL。")
    # Bound the decode: a 20 MB image is ~27 MB of base64.
    if len(payload) > imagecheck.MAX_IMAGE_BYTES * 2:
        raise imagecheck.ImageInspectionError(
            "image_too_large",
            f"图片超过 {imagecheck.MAX_IMAGE_BYTES // (1024 * 1024)} MB 上限。",
            status=413,
        )
    try:
        return base64.b64decode(payload, validate=True), mime
    except (binascii.Error, ValueError):
        raise imagecheck.ImageInspectionError("bad_data_url", "图片内容不是有效的 base64。")


class InspectImageBody(BaseModel):
    """Register and inspect an image the browser already holds as a data URL."""

    data_url: str
    platform: Literal["amazon", "tiktok", "shopify"]
    origin: Literal["generated", "uploaded"] = "generated"
    revision_id: str = ""
    node_id: str = ""
    label: str = ""


@app.post("/api/media/assets")
def media_asset_register(body: InspectImageBody):
    try:
        data, mime = _decode_data_url(body.data_url)
        record = mediaassets.put_asset(
            data,
            platform=body.platform,
            origin=body.origin,
            revision_id=body.revision_id,
            node_id=body.node_id,
            label=body.label,
            declared_mime=mime,
        )
    except imagecheck.ImageInspectionError as exc:
        return _image_error(exc)
    return {"code": 0, "data": {"asset": record}}


@app.post("/api/media/assets/upload")
async def media_asset_upload(
    file: UploadFile = File(...),
    platform: str = Form("amazon"),
    revision_id: str = Form(""),
    node_id: str = Form(""),
    label: str = Form(""),
):
    """Upload one image. Same decode, same rules, same records as a generated one."""
    if platform not in ("amazon", "tiktok", "shopify"):
        return _image_error(
            imagecheck.ImageInspectionError("bad_platform", f"未知平台：{platform}")
        )
    data = await file.read(imagecheck.MAX_IMAGE_BYTES + 1)
    try:
        record = mediaassets.put_asset(
            data,
            platform=platform,
            origin=mediaassets.UPLOADED,
            revision_id=revision_id,
            node_id=node_id,
            label=label,
            filename=file.filename or "",
            declared_mime=file.content_type or "",
        )
    except imagecheck.ImageInspectionError as exc:
        return _image_error(exc)
    return {"code": 0, "data": {"asset": record}}


@app.get("/api/media/assets")
def media_assets_list(revision_id: str = Query(""), platform: str = Query("")):
    return {
        "code": 0,
        "data": {"assets": mediaassets.list_assets(revision_id=revision_id, platform=platform)},
    }


@app.get("/api/media/assets/{asset_id}")
def media_asset_get(asset_id: str):
    try:
        return {"code": 0, "data": {"asset": mediaassets.get_asset(asset_id)}}
    except imagecheck.ImageInspectionError as exc:
        return _image_error(exc)


@app.get("/api/media/assets/{asset_id}/original")
def media_asset_original(asset_id: str):
    """The exact bytes that were inspected, for the existing lightbox."""
    try:
        data, mime = mediaassets.read_blob(asset_id)
    except imagecheck.ImageInspectionError as exc:
        return _image_error(exc)
    return Response(
        content=data,
        media_type=mime,
        headers={"Cache-Control": "private, max-age=300", "Content-Disposition": "inline"},
    )


@app.post("/api/media/assets/{asset_id}/verify")
def media_asset_verify(asset_id: str):
    try:
        return {"code": 0, "data": mediaassets.verify_asset(asset_id)}
    except imagecheck.ImageInspectionError as exc:
        return _image_error(exc)


@app.delete("/api/media/assets/{asset_id}")
def media_asset_delete(asset_id: str):
    return {"code": 0, "data": {"removed": mediaassets.delete_asset(asset_id)}}


# --------------------------------------------------------------------------- #
# Release Passport. Assembles a handoff record from stored entity ids and       #
# exports a deterministic package. Nothing here publishes to a marketplace.     #
# --------------------------------------------------------------------------- #


def _passport_error(exc: passport.PassportError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.http_status,
        content={"code": 1, "error": exc.code, "message": exc.safe_message},
    )


class BuildPassportBody(BaseModel):
    sku_id: str
    platform: Literal["amazon", "tiktok", "shopify"]
    project_id: str = ""
    #: Operator declarations. Never inferred from product data.
    language: str = ""
    currency: str = ""
    unit_system: str = ""


@app.post("/api/passport/build")
def passport_build(body: BuildPassportBody):
    """Recompute readiness from current records and store the passport."""
    try:
        record = passport.build(
            body.sku_id,
            body.platform,
            project_id=body.project_id,
            overrides={
                "language": body.language,
                "currency": body.currency,
                "unit_system": body.unit_system,
            },
        )
    except passport.PassportError as exc:
        return _passport_error(exc)
    return {"code": 0, "data": {"passport": record}}


@app.get("/api/passport/list")
def passport_list(sku_id: str = Query(""), platform: str = Query("")):
    return {
        "code": 0,
        "data": {"passports": passport.list_passports(sku_id=sku_id, platform=platform)},
    }


@app.get("/api/passport/{passport_id}")
def passport_get(passport_id: str):
    try:
        return {"code": 0, "data": {"passport": passport.get(passport_id)}}
    except passport.PassportError as exc:
        return _passport_error(exc)


class ExportPassportBody(BaseModel):
    """Export is a confirmed domain action, so the confirmation is in the payload.

    The flag is not decoration: the endpoint refuses without it, so a stray or
    replayed request cannot produce a handoff package that looks like a
    deliberate one.
    """

    confirm: bool = False


@app.post("/api/passport/{passport_id}/export")
def passport_export(passport_id: str, body: ExportPassportBody):
    if not body.confirm:
        return JSONResponse(
            status_code=428,
            content={
                "code": 1,
                "error": "confirmation_required",
                "message": "导出交接包需要显式确认。本操作不会向任何平台发布。",
            },
        )
    try:
        built = passport.build_package(passport_id)
    except passport.PassportError as exc:
        return _passport_error(exc)

    filename = f"{passport_id}-{built['manifest']['sku_id']}-{built['manifest']['platform']}.zip"
    return Response(
        content=built["package"],
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{passport.safe_path(filename)}"',
            "X-Package-Digest": built["export"]["digest"],
            "X-Package-Files": str(built["export"]["files"]),
        },
    )


@app.get("/api/passport/{passport_id}/manifest")
def passport_manifest(passport_id: str):
    """The manifest alone, so the UI can show package contents before exporting.

    Previewing contents is not exporting, so this records nothing.
    """
    try:
        built = passport.build_package(passport_id, record=False)
    except passport.PassportError as exc:
        return _passport_error(exc)
    return {"code": 0, "data": {"manifest": built["manifest"], "export": built["export"]}}


# --------------------------------------------------------------------------- #
# Batch portfolio migration. Reuses the deterministic single-SKU engine; no    #
# model is called, and nothing here publishes to any marketplace.              #
# --------------------------------------------------------------------------- #


@app.get("/api/portfolio/template")
def portfolio_template():
    """Downloadable CSV template for a portfolio import."""
    return Response(
        content=portfolio.TEMPLATE_CSV,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="portfolio-template.csv"'},
    )


@app.post("/api/portfolio/import")
async def portfolio_import(file: UploadFile = File(...)):
    """Parse a CSV/XLSX portfolio. Malformed rows are reported, not fatal."""
    data = await _read_bounded_upload(file)
    name = (file.filename or "").lower()
    family = "xlsx" if name.endswith(".xlsx") else "csv"
    if not name.endswith((".csv", ".xlsx")):
        return _bad("仅支持 CSV 或 XLSX 组合文件。", "unsupported_type", 415)
    if len(data) > evidence.store.MAX_UPLOAD_BYTES:
        return _bad("文件过大。", "file_too_large", 413)
    return {"code": 0, "data": portfolio.parse_portfolio(data, family)}


class PortfolioAnalyzeBody(BaseModel):
    skus: list[dict[str, Any]] = Field(default_factory=list)
    base_policy_version: str | None = None
    candidate_policy_version: str | None = None
    #: sku -> replacement selling points, for a product-fact drift.
    points_override: dict[str, str] = Field(default_factory=dict)


@app.post("/api/portfolio/impact")
def portfolio_impact(body: PortfolioAnalyzeBody):
    try:
        data = portfolio.analyze_portfolio(
            body.skus,
            base_policy_version=body.base_policy_version,
            candidate_policy_version=body.candidate_policy_version,
            points_override=body.points_override,
        )
    except policy.PolicyError as exc:
        return _bad(str(exc), "unknown_policy_version")
    return {"code": 0, "data": data}


class PortfolioApplyBody(BaseModel):
    artifacts: dict[str, list[dict[str, Any]]] = Field(default_factory=dict)
    approved: list[dict[str, Any]] = Field(default_factory=list)
    candidate_policy_version: str | None = None


@app.post("/api/portfolio/apply")
def portfolio_apply(body: PortfolioApplyBody):
    """Apply approved patches across the batch.

    Rows marked review_required are rejected rather than applied, so bulk
    approval of the safe set can never widen into approving the risky ones.
    """
    try:
        data = portfolio.apply_batch(
            body.artifacts,
            body.approved,
            candidate_policy_version=body.candidate_policy_version,
        )
    except policy.PolicyError as exc:
        return _bad(str(exc), "unknown_policy_version")
    return {"code": 0, "data": data}


class PortfolioRollbackBody(BaseModel):
    snapshot: dict[str, Any] = Field(default_factory=dict)
    #: omit to roll the whole batch back, or name one SKU
    sku: str | None = None


@app.post("/api/portfolio/rollback")
def portfolio_rollback(body: PortfolioRollbackBody):
    try:
        data = portfolio.rollback_batch(body.snapshot, only_sku=body.sku)
    except ValueError as exc:
        return _bad(str(exc), "bad_snapshot")
    return {"code": 0, "data": data}


class PortfolioReportBody(BaseModel):
    analysis: dict[str, Any] = Field(default_factory=dict)
    apply_result: dict[str, Any] | None = None
    status: str = "candidate"
    approver: str = ""
    evidence_versions: list[dict[str, Any]] | None = None
    rollback: dict[str, Any] | None = None


@app.post("/api/portfolio/report")
def portfolio_report(body: PortfolioReportBody, format: str = Query("json")):
    report = portfolio.build_batch_report(
        analysis=body.analysis,
        apply_result=body.apply_result,
        status=body.status,
        approver=body.approver,
        evidence_versions=body.evidence_versions,
        rollback=body.rollback,
    )
    if format == "html":
        return HTMLResponse(portfolio.render_batch_report_html(report))
    return {"code": 0, "data": report}


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
    #: Compact canvas snapshot. Treated as untrusted data by the agent prompt,
    #: never as instructions.
    context: dict[str, Any] = Field(default_factory=dict)


@app.post("/api/agent/chat")
async def agent_chat(body: AgentChatBody):
    """Reply plus an OPTIONAL structured canvas plan.

    A plan is a proposal only: the client validates it again and applies it in
    one transaction after the user approves. Nothing here mutates a canvas.
    """
    result = await agent_reply(body.messages, body.context)
    plan = result.get("plan")
    if plan is not None:
        last_user = next(
            (
                str(m.get("content") or "")
                for m in reversed(body.messages)
                if m.get("role") == "user"
            ),
            "",
        )
        plan = agent_plan.with_rationale(plan, text=last_user, context=body.context)
    return {"code": 0, "data": {"reply": result["reply"], "plan": plan}}


#: Headers that keep an SSE body flowing instead of being buffered. The
#: X-Accel-Buffering hint is what stops Nginx from holding the whole response
#: until the generator finishes; the matching server config is in docs/DEPLOY.md.
_SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


@app.post("/api/agent/chat/stream")
async def agent_chat_stream(body: AgentChatBody):
    """The same turn as ``/api/agent/chat``, delivered as it is produced.

    SSE over POST, because the request carries the conversation and the canvas
    snapshot. The non-streaming endpoint above stays available unchanged, and
    the client falls back to it when this route is unreachable.
    """

    async def events():
        try:
            async for event in agent_stream.stream_agent_events(
                body.messages, body.context
            ):
                yield agent_stream.sse_frame(event)
        except asyncio.CancelledError:
            # The client went away (Stop, navigation, closed tab). Unwinding
            # here is what propagates cancellation into the upstream request.
            raise
        except Exception:  # noqa: BLE001 - never leak provider detail to a client
            logging.getLogger("listing.agent").exception("agent stream failed")
            yield agent_stream.sse_frame(
                {
                    "event": "error",
                    "data": {
                        "category": "internal",
                        "message": "Agent 服务出错，请重试。",
                        "retryable": True,
                    },
                }
            )

    return StreamingResponse(
        events(),
        media_type="text/event-stream; charset=utf-8",
        headers=_SSE_HEADERS,
    )


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
