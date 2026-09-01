from __future__ import annotations

from pathlib import Path
from typing import Literal

import yaml
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from agent import agent_reply
from generate import generate_drafts
from media import generate_media_image, generate_media_video
from media_errors import MediaError

ROOT = Path(__file__).resolve().parent
DIST = ROOT.parent / "web" / "dist"
RULES = yaml.safe_load((ROOT / "rules.yaml").read_text())

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
    # anything else is ignored and the request stays text-to-video.
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
