"""Token Plan image / video protocol: selection, parsing, success, failure, timeout.

All network calls are stubbed with ``httpx.MockTransport``; nothing here reaches
the internet. Legacy OpenAI-compatible behaviour is covered by
``test_media_endpoints.py`` and must keep working unchanged.
"""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest
from fastapi.testclient import TestClient

import app as app_module
import images
import media
import token_plan

client = TestClient(app_module.app)

TOKEN_PLAN_HOST = "https://token-plan.cn-beijing.maas.aliyuncs.com"
IMAGE_PATH = "/api/v1/services/aigc/multimodal-generation/generation"
VIDEO_SUBMIT_PATH = "/api/v1/services/aigc/video-generation/video-synthesis"


def run(coro):
    return asyncio.run(coro)


def mock_transport(handler):
    def factory(timeout=180.0):
        return httpx.AsyncClient(transport=httpx.MockTransport(handler), timeout=timeout)

    return factory


def tp_image_body(url="https://cdn.token-plan.test/out.png"):
    return {
        "output": {
            "choices": [
                {"message": {"role": "assistant", "content": [{"text": "ok"}, {"image": url}]}}
            ]
        }
    }


# --------------------------------------------------------------------------- #
# provider selection / config fallback                                        #
# --------------------------------------------------------------------------- #


def test_select_media_provider_explicit_wins_over_autodetect():
    # base url is a token-plan host, but an explicit "legacy" choice overrides it.
    assert token_plan.select_media_provider("legacy", (TOKEN_PLAN_HOST,)) == "legacy"
    assert token_plan.select_media_provider("token_plan", ("https://work.poloapi.com/v1",)) == "token_plan"
    assert token_plan.select_media_provider("Token-Plan", ()) == "token_plan"


def test_select_media_provider_autodetects_token_plan_host():
    assert token_plan.select_media_provider("", (TOKEN_PLAN_HOST + "/api/v1",)) == "token_plan"
    assert token_plan.select_media_provider("", ("", "https://work.poloapi.com/v1")) == "legacy"
    assert token_plan.select_media_provider("", ()) == "legacy"


def test_token_plan_media_base_url_override_and_autodetect(monkeypatch):
    assert token_plan.token_plan_media_base_url("https://work.poloapi.com/v1") == TOKEN_PLAN_HOST
    # origin is extracted, path is dropped
    assert (
        token_plan.token_plan_media_base_url(TOKEN_PLAN_HOST + "/compatible-mode/v1")
        == TOKEN_PLAN_HOST
    )
    monkeypatch.setenv("TOKEN_PLAN_MEDIA_BASE_URL", "https://proxy.internal:8443/base/")
    assert token_plan.token_plan_media_base_url("") == "https://proxy.internal:8443"


def test_image_provider_falls_back_to_legacy_when_unset():
    assert images._image_provider() == "legacy"
    assert media._video_provider() == "legacy"


# --------------------------------------------------------------------------- #
# image — Token Plan protocol                                                 #
# --------------------------------------------------------------------------- #


def test_image_token_plan_selected_by_provider_env(monkeypatch):
    monkeypatch.setenv("LISTING_IMAGE_PROVIDER", "token_plan")
    monkeypatch.setenv("LISTING_IMAGE_API_KEY", "sk-img-tp")
    seen = {}

    def handler(request):
        if request.url.path == IMAGE_PATH:
            seen["url"] = str(request.url)
            seen["auth"] = request.headers.get("authorization")
            seen["body"] = json.loads(request.content)
            return httpx.Response(200, json=tp_image_body("https://cdn.token-plan.test/a.png"))
        # fetch of the returned image URL -> raw png bytes
        return httpx.Response(200, content=b"\x89PNG\r\n\x1a\n" + b"0" * 16, headers={"content-type": "image/png"})

    monkeypatch.setattr(images, "_make_client", mock_transport(handler))
    r = client.post("/api/media/image", json={"prompt": "a cup on white", "aspect_ratio": "1:1"})

    assert r.status_code == 200
    assert r.json()["data"]["url"].startswith("data:image/png;base64,")
    assert seen["url"] == TOKEN_PLAN_HOST + IMAGE_PATH
    assert seen["auth"] == "Bearer sk-img-tp"
    assert seen["body"]["model"] == "qwen-image-2.0"
    assert seen["body"]["input"]["messages"] == [
        {"role": "user", "content": [{"text": "a cup on white"}]}
    ]
    assert seen["body"]["parameters"]["size"] == "1024*1024"


def test_image_token_plan_selected_by_base_url_host(monkeypatch):
    monkeypatch.setenv("LISTING_IMAGE_BASE_URL", TOKEN_PLAN_HOST)
    monkeypatch.setenv("LISTING_IMAGE_API_KEY", "sk-img-tp")
    seen = {}

    def handler(request):
        if request.url.path == IMAGE_PATH:
            seen["hit"] = True
            return httpx.Response(200, json=tp_image_body())
        return httpx.Response(200, content=b"mp", headers={"content-type": "image/png"})

    monkeypatch.setattr(images, "_make_client", mock_transport(handler))
    r = client.post("/api/media/image", json={"prompt": "cup", "aspect_ratio": "1:1"})
    assert r.status_code == 200
    assert seen.get("hit") is True


def test_image_token_plan_key_falls_back_to_token_plan_api_key(monkeypatch):
    monkeypatch.setenv("LISTING_IMAGE_PROVIDER", "token_plan")
    monkeypatch.setenv("TOKEN_PLAN_API_KEY", "sk-shared-secret")
    seen = {}

    def handler(request):
        if request.url.path == IMAGE_PATH:
            seen["auth"] = request.headers.get("authorization")
            return httpx.Response(200, json=tp_image_body())
        return httpx.Response(200, content=b"x", headers={"content-type": "image/png"})

    monkeypatch.setattr(images, "_make_client", mock_transport(handler))
    r = client.post("/api/media/image", json={"prompt": "cup", "aspect_ratio": "1:1"})
    assert r.status_code == 200
    assert seen["auth"] == "Bearer sk-shared-secret"


def test_image_token_plan_size_is_normalised_for_non_square(monkeypatch):
    monkeypatch.setenv("LISTING_IMAGE_PROVIDER", "token_plan")
    monkeypatch.setenv("LISTING_IMAGE_API_KEY", "sk-img-tp")
    seen = {}

    def handler(request):
        if request.url.path == IMAGE_PATH:
            seen["size"] = json.loads(request.content)["parameters"]["size"]
            return httpx.Response(200, json=tp_image_body())
        return httpx.Response(200, content=b"x", headers={"content-type": "image/png"})

    monkeypatch.setattr(images, "_make_client", mock_transport(handler))
    r = client.post("/api/media/image", json={"prompt": "cup", "aspect_ratio": "16:9"})
    assert r.status_code == 200
    assert seen["size"] == "1792*1024"


def test_image_token_plan_missing_image_url_is_bad_response(monkeypatch):
    monkeypatch.setenv("LISTING_IMAGE_PROVIDER", "token_plan")
    monkeypatch.setenv("LISTING_IMAGE_API_KEY", "sk-img-tp")

    def handler(request):
        return httpx.Response(200, json={"output": {"choices": [{"message": {"content": [{"text": "no image"}]}}]}})

    monkeypatch.setattr(images, "_make_client", mock_transport(handler))
    r = client.post("/api/media/image", json={"prompt": "cup", "aspect_ratio": "1:1"})
    assert r.status_code == 502
    assert r.json()["error"] == "provider_failure"


def test_image_token_plan_provider_500_maps_to_502_without_leak(monkeypatch):
    monkeypatch.setenv("LISTING_IMAGE_PROVIDER", "token_plan")
    monkeypatch.setenv("LISTING_IMAGE_API_KEY", "sk-img-tp")

    def handler(request):
        return httpx.Response(500, json={"message": "PRIVATE-PROVIDER-DETAIL"})

    monkeypatch.setattr(images, "_make_client", mock_transport(handler))
    r = client.post("/api/media/image", json={"prompt": "cup", "aspect_ratio": "1:1"})
    assert r.status_code == 502
    assert "PRIVATE-PROVIDER-DETAIL" not in r.text
    assert "sk-img-tp" not in r.text


def test_image_token_plan_data_url_passthrough(monkeypatch):
    monkeypatch.setenv("LISTING_IMAGE_PROVIDER", "token_plan")
    monkeypatch.setenv("LISTING_IMAGE_API_KEY", "sk-img-tp")
    inline = "data:image/png;base64,QUJD"

    def handler(request):
        assert request.url.path == IMAGE_PATH  # no extra fetch when already inline
        return httpx.Response(200, json=tp_image_body(inline))

    monkeypatch.setattr(images, "_make_client", mock_transport(handler))
    r = client.post("/api/media/image", json={"prompt": "cup", "aspect_ratio": "1:1"})
    assert r.status_code == 200
    assert r.json()["data"]["url"] == inline


# --------------------------------------------------------------------------- #
# video — Token Plan async submit + poll                                      #
# --------------------------------------------------------------------------- #


def _fast_poll(monkeypatch):
    monkeypatch.setenv("LISTING_VIDEO_POLL_INTERVAL_S", "0.01")
    monkeypatch.setenv("LISTING_VIDEO_POLL_TIMEOUT_S", "5")


def test_video_token_plan_submit_and_poll_success(monkeypatch):
    monkeypatch.setenv("LISTING_VIDEO_PROVIDER", "token_plan")
    monkeypatch.setenv("LISTING_VIDEO_API_KEY", "sk-vid-tp")
    _fast_poll(monkeypatch)
    seen = {"polls": 0}

    def handler(request):
        if request.url.path == VIDEO_SUBMIT_PATH:
            seen["async_header"] = request.headers.get("x-dashscope-async")
            seen["submit_body"] = json.loads(request.content)
            return httpx.Response(200, json={"output": {"task_id": "task-abc", "task_status": "PENDING"}})
        if request.url.path == "/api/v1/tasks/task-abc":
            seen["polls"] += 1
            if seen["polls"] < 2:
                return httpx.Response(200, json={"output": {"task_status": "RUNNING"}})
            return httpx.Response(
                200,
                json={"output": {"task_status": "SUCCEEDED", "video_url": "https://cdn.token-plan.test/v.mp4"}},
            )
        # fetch of the finished mp4
        return httpx.Response(200, content=b"mp4-bytes", headers={"content-type": "video/mp4"})

    monkeypatch.setattr(media, "_make_client", mock_transport(handler))
    r = client.post("/api/media/video", json={"prompt": "a cup unfolding", "aspect_ratio": "16:9", "duration": "5s"})

    assert r.status_code == 200
    assert r.json()["data"]["url"].startswith("data:video/mp4;base64,")
    assert seen["async_header"] == "enable"
    assert seen["submit_body"]["model"] == "happyhorse-1.1-t2v"
    assert seen["submit_body"]["input"] == {"prompt": "a cup unfolding"}
    assert seen["submit_body"]["parameters"] == {"resolution": "720P", "ratio": "16:9", "duration": 5}
    assert seen["polls"] == 2


def test_video_token_plan_maps_size_and_seconds_inputs(monkeypatch):
    monkeypatch.setenv("LISTING_VIDEO_PROVIDER", "token_plan")
    monkeypatch.setenv("LISTING_VIDEO_API_KEY", "sk-vid-tp")
    _fast_poll(monkeypatch)
    seen = {}

    def handler(request):
        if request.url.path == VIDEO_SUBMIT_PATH:
            seen["params"] = json.loads(request.content)["parameters"]
            return httpx.Response(200, json={"output": {"task_id": "t1"}})
        return httpx.Response(
            200, json={"output": {"task_status": "SUCCEEDED", "video_url": "data:video/mp4;base64,QQ=="}}
        )

    monkeypatch.setattr(media, "_make_client", mock_transport(handler))
    r = client.post("/api/media/video", json={"prompt": "x", "aspect_ratio": "9:16", "duration": "8s"})
    assert r.status_code == 200
    assert seen["params"] == {"resolution": "720P", "ratio": "9:16", "duration": 8}


def test_video_token_plan_first_frame_switches_to_i2v(monkeypatch):
    """A first frame => happyhorse-1.1-i2v, input.media, and no parameters.ratio."""
    monkeypatch.setenv("LISTING_VIDEO_PROVIDER", "token_plan")
    monkeypatch.setenv("LISTING_VIDEO_API_KEY", "sk-vid-tp")
    _fast_poll(monkeypatch)
    seen = {}

    def handler(request):
        if request.url.path == VIDEO_SUBMIT_PATH:
            seen["body"] = json.loads(request.content)
            return httpx.Response(200, json={"output": {"task_id": "t-i2v"}})
        return httpx.Response(
            200, json={"output": {"task_status": "SUCCEEDED", "video_url": "data:video/mp4;base64,QQ=="}}
        )

    monkeypatch.setattr(media, "_make_client", mock_transport(handler))
    r = client.post(
        "/api/media/video",
        json={
            "prompt": "cup unfolds",
            "aspect_ratio": "1:1",
            "duration": "5s",
            "first_frame_url": "https://cdn.example.test/cup.png",
        },
    )

    assert r.status_code == 200
    body = seen["body"]
    assert body["model"] == "happyhorse-1.1-i2v"
    assert body["input"] == {
        "prompt": "cup unfolds",
        "media": [{"type": "first_frame", "url": "https://cdn.example.test/cup.png"}],
    }
    # i2v follows the source image ratio: no ratio is sent.
    assert "ratio" not in body["parameters"]
    assert body["parameters"] == {"resolution": "720P", "duration": 5}


def test_video_token_plan_first_frame_accepts_image_data_url(monkeypatch):
    monkeypatch.setenv("LISTING_VIDEO_PROVIDER", "token_plan")
    monkeypatch.setenv("LISTING_VIDEO_API_KEY", "sk-vid-tp")
    _fast_poll(monkeypatch)
    data_url = "data:image/png;base64,iVBORw0KGgo="
    seen = {}

    def handler(request):
        if request.url.path == VIDEO_SUBMIT_PATH:
            seen["body"] = json.loads(request.content)
            return httpx.Response(200, json={"output": {"task_id": "t-data"}})
        return httpx.Response(
            200, json={"output": {"task_status": "SUCCEEDED", "video_url": "data:video/mp4;base64,QQ=="}}
        )

    monkeypatch.setattr(media, "_make_client", mock_transport(handler))
    r = client.post(
        "/api/media/video",
        json={"prompt": "x", "aspect_ratio": "9:16", "first_frame_url": data_url},
    )
    assert r.status_code == 200
    assert seen["body"]["model"] == "happyhorse-1.1-i2v"
    assert seen["body"]["input"]["media"] == [{"type": "first_frame", "url": data_url}]


def test_video_token_plan_image_model_override(monkeypatch):
    monkeypatch.setenv("LISTING_VIDEO_PROVIDER", "token_plan")
    monkeypatch.setenv("LISTING_VIDEO_API_KEY", "sk-vid-tp")
    monkeypatch.setenv("LISTING_VIDEO_IMAGE_MODEL", "happyhorse-9.9-i2v")
    # The t2v override must not leak into an image-to-video request.
    monkeypatch.setenv("LISTING_VIDEO_MODEL", "custom-t2v")
    _fast_poll(monkeypatch)
    seen = {}

    def handler(request):
        if request.url.path == VIDEO_SUBMIT_PATH:
            seen["model"] = json.loads(request.content)["model"]
            return httpx.Response(200, json={"output": {"task_id": "t-ov"}})
        return httpx.Response(
            200, json={"output": {"task_status": "SUCCEEDED", "video_url": "data:video/mp4;base64,QQ=="}}
        )

    monkeypatch.setattr(media, "_make_client", mock_transport(handler))
    r = client.post(
        "/api/media/video",
        json={"prompt": "x", "aspect_ratio": "16:9", "first_frame_url": "https://cdn.example.test/a.jpg"},
    )
    assert r.status_code == 200
    assert seen["model"] == "happyhorse-9.9-i2v"


def test_video_token_plan_unusable_first_frame_stays_text_to_video(monkeypatch):
    """A site-relative path / non-image data URL is not something the provider
    can fetch, so the request falls back to t2v with its ratio."""
    monkeypatch.setenv("LISTING_VIDEO_PROVIDER", "token_plan")
    monkeypatch.setenv("LISTING_VIDEO_API_KEY", "sk-vid-tp")
    _fast_poll(monkeypatch)
    seen = {}

    def handler(request):
        if request.url.path == VIDEO_SUBMIT_PATH:
            seen["body"] = json.loads(request.content)
            return httpx.Response(200, json={"output": {"task_id": "t-rel"}})
        return httpx.Response(
            200, json={"output": {"task_status": "SUCCEEDED", "video_url": "data:video/mp4;base64,QQ=="}}
        )

    monkeypatch.setattr(media, "_make_client", mock_transport(handler))
    r = client.post(
        "/api/media/video",
        json={"prompt": "x", "aspect_ratio": "16:9", "first_frame_url": "/station/cup-white.svg"},
    )
    assert r.status_code == 200
    assert seen["body"]["model"] == "happyhorse-1.1-t2v"
    assert "media" not in seen["body"]["input"]
    assert seen["body"]["parameters"]["ratio"] == "16:9"


def test_normalize_first_frame_accepts_only_http_and_image_data_urls():
    assert media.normalize_first_frame("https://a.test/x.png") == "https://a.test/x.png"
    assert media.normalize_first_frame(" http://a.test/x.png ") == "http://a.test/x.png"
    assert media.normalize_first_frame("data:image/jpeg;base64,AA==") == "data:image/jpeg;base64,AA=="
    assert media.normalize_first_frame("data:video/mp4;base64,AA==") == ""
    assert media.normalize_first_frame("/station/cup.svg") == ""
    assert media.normalize_first_frame("file:///tmp/a.png") == ""
    assert media.normalize_first_frame(None) == ""
    assert media.normalize_first_frame("") == ""


def test_video_token_plan_failed_status_returns_502(monkeypatch):
    monkeypatch.setenv("LISTING_VIDEO_PROVIDER", "token_plan")
    monkeypatch.setenv("LISTING_VIDEO_API_KEY", "sk-vid-tp")
    _fast_poll(monkeypatch)

    def handler(request):
        if request.url.path == VIDEO_SUBMIT_PATH:
            return httpx.Response(200, json={"output": {"task_id": "t1"}})
        return httpx.Response(200, json={"output": {"task_status": "FAILED", "message": "SECRET-FAIL-REASON"}})

    monkeypatch.setattr(media, "_make_client", mock_transport(handler))
    r = client.post("/api/media/video", json={"prompt": "x", "aspect_ratio": "16:9"})
    assert r.status_code == 502
    assert r.json()["error"] == "provider_failure"
    assert "SECRET-FAIL-REASON" not in r.text


def test_video_token_plan_times_out_when_never_ready(monkeypatch):
    monkeypatch.setenv("LISTING_VIDEO_PROVIDER", "token_plan")
    monkeypatch.setenv("LISTING_VIDEO_API_KEY", "sk-vid-tp")
    monkeypatch.setenv("LISTING_VIDEO_POLL_INTERVAL_S", "0.01")
    monkeypatch.setenv("LISTING_VIDEO_POLL_TIMEOUT_S", "0.04")

    def handler(request):
        if request.url.path == VIDEO_SUBMIT_PATH:
            return httpx.Response(200, json={"output": {"task_id": "t1"}})
        return httpx.Response(200, json={"output": {"task_status": "RUNNING"}})

    monkeypatch.setattr(media, "_make_client", mock_transport(handler))
    r = client.post("/api/media/video", json={"prompt": "x", "aspect_ratio": "16:9"})
    assert r.status_code == 504
    assert r.json()["error"] == "provider_timeout"


def test_video_token_plan_missing_task_id_is_bad_response(monkeypatch):
    monkeypatch.setenv("LISTING_VIDEO_PROVIDER", "token_plan")
    monkeypatch.setenv("LISTING_VIDEO_API_KEY", "sk-vid-tp")
    _fast_poll(monkeypatch)

    monkeypatch.setattr(
        media, "_make_client", mock_transport(lambda r: httpx.Response(200, json={"output": {}}))
    )
    r = client.post("/api/media/video", json={"prompt": "x", "aspect_ratio": "16:9"})
    assert r.status_code == 502
    assert r.json()["error"] == "provider_failure"


def test_video_token_plan_submit_non_200_returns_502(monkeypatch):
    monkeypatch.setenv("LISTING_VIDEO_PROVIDER", "token_plan")
    monkeypatch.setenv("LISTING_VIDEO_API_KEY", "sk-vid-tp")
    _fast_poll(monkeypatch)

    monkeypatch.setattr(
        media, "_make_client", mock_transport(lambda r: httpx.Response(429, json={"message": "slow down"}))
    )
    r = client.post("/api/media/video", json={"prompt": "x", "aspect_ratio": "16:9"})
    assert r.status_code == 502
    assert r.json()["error"] == "provider_failure"


def test_video_token_plan_poll_http_error_returns_502(monkeypatch):
    monkeypatch.setenv("LISTING_VIDEO_PROVIDER", "token_plan")
    monkeypatch.setenv("LISTING_VIDEO_API_KEY", "sk-vid-tp")
    _fast_poll(monkeypatch)

    def handler(request):
        if request.url.path == VIDEO_SUBMIT_PATH:
            return httpx.Response(200, json={"output": {"task_id": "t1"}})
        return httpx.Response(500, json={"message": "poll boom"})

    monkeypatch.setattr(media, "_make_client", mock_transport(handler))
    r = client.post("/api/media/video", json={"prompt": "x", "aspect_ratio": "16:9"})
    assert r.status_code == 502
    assert "poll boom" not in r.text


def test_video_token_plan_selected_by_base_url_host(monkeypatch):
    monkeypatch.setenv("LISTING_VIDEO_BASE_URL", TOKEN_PLAN_HOST)
    monkeypatch.setenv("LISTING_VIDEO_API_KEY", "sk-vid-tp")
    _fast_poll(monkeypatch)
    seen = {}

    def handler(request):
        if request.url.path == VIDEO_SUBMIT_PATH:
            seen["hit"] = True
            return httpx.Response(200, json={"output": {"task_id": "t1"}})
        return httpx.Response(
            200, json={"output": {"task_status": "SUCCEEDED", "video_url": "data:video/mp4;base64,QQ=="}}
        )

    monkeypatch.setattr(media, "_make_client", mock_transport(handler))
    r = client.post("/api/media/video", json={"prompt": "x", "aspect_ratio": "16:9"})
    assert r.status_code == 200
    assert seen.get("hit") is True


def test_video_token_plan_key_falls_back_to_token_plan_api_key(monkeypatch):
    monkeypatch.setenv("LISTING_VIDEO_PROVIDER", "token_plan")
    monkeypatch.setenv("TOKEN_PLAN_API_KEY", "sk-shared-secret")
    _fast_poll(monkeypatch)
    seen = {}

    def handler(request):
        if request.url.path == VIDEO_SUBMIT_PATH:
            seen["auth"] = request.headers.get("authorization")
            return httpx.Response(200, json={"output": {"task_id": "t1"}})
        return httpx.Response(
            200, json={"output": {"task_status": "SUCCEEDED", "video_url": "data:video/mp4;base64,QQ=="}}
        )

    monkeypatch.setattr(media, "_make_client", mock_transport(handler))
    r = client.post("/api/media/video", json={"prompt": "x", "aspect_ratio": "16:9"})
    assert r.status_code == 200
    assert seen["auth"] == "Bearer sk-shared-secret"


def test_video_token_plan_unconfigured_returns_503(monkeypatch):
    monkeypatch.setenv("LISTING_VIDEO_PROVIDER", "token_plan")
    r = client.post("/api/media/video", json={"prompt": "x", "aspect_ratio": "16:9"})
    assert r.status_code == 503
    assert r.json()["error"] == "provider_unconfigured"


def test_video_token_plan_succeeded_without_url_is_bad_response(monkeypatch):
    monkeypatch.setenv("LISTING_VIDEO_PROVIDER", "token_plan")
    monkeypatch.setenv("LISTING_VIDEO_API_KEY", "sk-vid-tp")
    _fast_poll(monkeypatch)

    def handler(request):
        if request.url.path == VIDEO_SUBMIT_PATH:
            return httpx.Response(200, json={"output": {"task_id": "t1"}})
        return httpx.Response(200, json={"output": {"task_status": "SUCCEEDED"}})

    monkeypatch.setattr(media, "_make_client", mock_transport(handler))
    r = client.post("/api/media/video", json={"prompt": "x", "aspect_ratio": "16:9"})
    assert r.status_code == 502
    assert r.json()["error"] == "provider_failure"


# --------------------------------------------------------------------------- #
# legacy protocol still the default                                           #
# --------------------------------------------------------------------------- #


def test_legacy_image_protocol_untouched_when_no_token_plan_config(monkeypatch):
    monkeypatch.setenv("LISTING_IMAGE_API_KEY", "sk-legacy")
    seen = {}

    def handler(request):
        seen["path"] = request.url.path
        return httpx.Response(200, json={"data": [{"b64_json": "QUJD"}]})

    monkeypatch.setattr(images, "_make_client", mock_transport(handler))
    r = client.post("/api/media/image", json={"prompt": "cup", "aspect_ratio": "1:1"})
    assert r.status_code == 200
    assert seen["path"].endswith("/images/generations")
