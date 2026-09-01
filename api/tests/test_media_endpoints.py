"""Media endpoints return meaningful HTTP status codes and safe messages."""

from __future__ import annotations

import base64
import json

import httpx
from fastapi.testclient import TestClient

import app as app_module
import images
import media

client = TestClient(app_module.app)


def mock_transport(handler):
    def factory(timeout=180.0):
        return httpx.AsyncClient(transport=httpx.MockTransport(handler), timeout=timeout)

    return factory


# --------------------------------------------------------------------------- #
# unconfigured provider -> 503                                                 #
# --------------------------------------------------------------------------- #


def test_image_unconfigured_returns_503_safe():
    r = client.post("/api/media/image", json={"prompt": "a cup on white"})
    assert r.status_code == 503
    body = r.json()
    assert body["code"] == 1
    assert body["error"] == "provider_unconfigured"
    assert body["message"] == "当前未配置图片模型。"
    # no env var name / provider text leaked
    assert "LISTING_IMAGE_API_KEY" not in r.text
    assert "Authorization" not in r.text


def test_video_unconfigured_returns_503_safe():
    r = client.post("/api/media/video", json={"prompt": "a cup unfolding"})
    assert r.status_code == 503
    body = r.json()
    assert body["error"] == "provider_unconfigured"
    assert body["message"] == "当前未配置视频模型。"
    assert "LISTING_VIDEO_API_KEY" not in r.text


# --------------------------------------------------------------------------- #
# invalid input -> 422                                                         #
# --------------------------------------------------------------------------- #


def test_image_empty_prompt_returns_422():
    r = client.post("/api/media/image", json={"prompt": "   "})
    assert r.status_code == 422
    assert r.json()["error"] == "invalid_input"


def test_video_empty_prompt_returns_422():
    r = client.post("/api/media/video", json={"prompt": ""})
    assert r.status_code == 422
    assert r.json()["error"] == "invalid_input"


# --------------------------------------------------------------------------- #
# provider failure -> 502 / timeout -> 504, no body leak                       #
# --------------------------------------------------------------------------- #


def test_image_provider_500_returns_502_without_leak(monkeypatch):
    monkeypatch.setenv("LISTING_IMAGE_API_KEY", "sk-img-test")

    def handler(request):
        return httpx.Response(500, json={"error": "PROVIDER-INTERNAL-SHOULD-NOT-LEAK"})

    monkeypatch.setattr(images, "_make_client", mock_transport(handler))
    r = client.post("/api/media/image", json={"prompt": "a cup on white"})
    assert r.status_code == 502
    assert r.json()["error"] == "provider_failure"
    assert "SHOULD-NOT-LEAK" not in r.text
    assert "sk-img-test" not in r.text


def test_image_provider_timeout_returns_504(monkeypatch):
    monkeypatch.setenv("LISTING_IMAGE_API_KEY", "sk-img-test")

    def handler(request):
        raise httpx.ReadTimeout("slow", request=request)

    monkeypatch.setattr(images, "_make_client", mock_transport(handler))
    r = client.post("/api/media/image", json={"prompt": "a cup on white"})
    assert r.status_code == 504
    assert r.json()["error"] == "provider_timeout"
    assert r.json()["message"] == "模型服务响应超时，请稍后重试。"


def test_video_provider_400_returns_502(monkeypatch):
    monkeypatch.setenv("LISTING_VIDEO_API_KEY", "sk-vid-test")

    def handler(request):
        return httpx.Response(400, json={"error": "bad model name leak"})

    monkeypatch.setattr(media, "_make_client", mock_transport(handler))
    r = client.post("/api/media/video", json={"prompt": "a cup unfolding"})
    assert r.status_code == 502
    assert r.json()["error"] == "provider_failure"
    assert "leak" not in r.text


def test_video_transport_error_returns_502(monkeypatch):
    monkeypatch.setenv("LISTING_VIDEO_API_KEY", "sk-vid-test")

    def handler(request):
        raise httpx.ConnectError("no route", request=request)

    monkeypatch.setattr(media, "_make_client", mock_transport(handler))
    r = client.post("/api/media/video", json={"prompt": "a cup unfolding"})
    assert r.status_code == 502
    assert r.json()["error"] == "provider_failure"


def test_video_provider_timeout_returns_504(monkeypatch):
    monkeypatch.setenv("LISTING_VIDEO_API_KEY", "sk-vid-test")

    def handler(request):
        raise httpx.ReadTimeout("slow", request=request)

    monkeypatch.setattr(media, "_make_client", mock_transport(handler))
    r = client.post("/api/media/video", json={"prompt": "a cup unfolding"})
    assert r.status_code == 504
    assert r.json()["error"] == "provider_timeout"
    assert r.json()["message"] == "模型服务响应超时，请稍后重试。"
    assert "sk-vid-test" not in r.text


def test_video_legacy_ignores_first_frame_and_keeps_its_body(monkeypatch):
    """The legacy /videos protocol has no image input: a first_frame_url must
    not change the request it sends."""
    monkeypatch.setenv("LISTING_VIDEO_API_KEY", "sk-vid-test")
    seen = {}

    def handler(request):
        if request.url.path.endswith("/videos"):
            seen["body"] = json.loads(request.content)
            return httpx.Response(200, json={"url": "data:video/mp4;base64,QQ=="})
        return httpx.Response(404)

    monkeypatch.setattr(media, "_make_client", mock_transport(handler))
    r = client.post(
        "/api/media/video",
        json={
            "prompt": "a cup unfolding",
            "aspect_ratio": "16:9",
            "duration": "5s",
            "first_frame_url": "https://cdn.example.test/cup.png",
        },
    )
    assert r.status_code == 200
    assert seen["body"] == {
        "model": "sora-2",
        "prompt": "a cup unfolding",
        "seconds": "5",
        "size": "1280x720",
    }


# --------------------------------------------------------------------------- #
# happy path still 200                                                         #
# --------------------------------------------------------------------------- #


def test_image_success_returns_200(monkeypatch):
    monkeypatch.setenv("LISTING_IMAGE_API_KEY", "sk-img-test")
    png = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"0" * 32).decode("ascii")

    def handler(request):
        return httpx.Response(200, json={"data": [{"b64_json": png}]})

    monkeypatch.setattr(images, "_make_client", mock_transport(handler))
    r = client.post("/api/media/image", json={"prompt": "a cup on white"})
    assert r.status_code == 200
    body = r.json()
    assert body["code"] == 0
    assert body["data"]["url"].startswith("data:image/")
