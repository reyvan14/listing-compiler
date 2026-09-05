"""Policy Watch: fetch safely, notice change, activate nothing.

Every network interaction is an ``httpx.MockTransport``; no test contacts a live
platform. The assertions that matter are refusals -- an off-allowlist host, a
redirect that leaves the allowlist, a hostname resolving into the perimeter, an
oversized body, a timeout, an unparseable page -- and the invariant underneath
all of them: no code path here writes or activates a policy rule.
"""

from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

import localization
import policy
import policywatch
from app import app

client = TestClient(app)

WATCH = "watch-amazon-us"
PAGE_V1 = "<html><body><h1>Title policy</h1><p>Titles must be under 200 characters.</p></body></html>"
PAGE_V2 = "<html><body><h1>Title policy</h1><p>Titles must be under 180 characters.</p></body></html>"


def transport(handler):
    """Install a mocked network for the duration of one test."""
    def _make(timeout=policywatch.FETCH_TIMEOUT_S):
        return httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=False)

    return _make


@pytest.fixture(autouse=True)
def _allow_dns(monkeypatch):
    """Resolve watched hosts to a public address without touching real DNS."""
    monkeypatch.setattr(policywatch, "_resolve", lambda host, port: ["93.184.216.34"])
    yield


@pytest.fixture
def watched(monkeypatch):
    """A watch whose source URL is on the allowlist."""
    monkeypatch.setattr(
        policywatch,
        "default_watches",
        lambda: [
            {
                "watch_id": WATCH,
                "platform": "amazon",
                "market": "US",
                "source_url": "https://sell.amazon.com/blog/product-photos",
                "source_name": "Amazon photo requirements",
                "snapshot_id": "amazon-us-2025.01.21",
                "snapshot_hash": "abc123",
                "allowed": True,
                "last_checked_at": "",
                "last_status": 0,
                "etag": "",
                "last_modified": "",
                "content_hash": "",
                "last_result": "",
            }
        ],
    )
    return WATCH


# --------------------------------------------------------------------------- #
# Outbound safety                                                              #
# --------------------------------------------------------------------------- #


def test_only_allowlisted_hosts_may_be_fetched():
    assert policywatch.host_allowed("https://sell.amazon.com/x") is True
    assert policywatch.host_allowed("https://evil.example.com/x") is False
    assert policywatch.host_allowed("ftp://sell.amazon.com/x") is False


def test_an_off_allowlist_host_is_refused_before_dns():
    with pytest.raises(policywatch.PolicyWatchError) as exc:
        policywatch.assert_fetchable("https://evil.example.com/policy")
    assert exc.value.code == "host_not_allowed"
    assert exc.value.http_status == 403


def test_the_cloud_metadata_address_is_refused():
    with pytest.raises(policywatch.PolicyWatchError) as exc:
        policywatch.assert_fetchable("http://169.254.169.254/latest/meta-data/")
    assert exc.value.code == "host_not_allowed"


def test_an_allowlisted_host_resolving_into_the_perimeter_is_refused(monkeypatch):
    """DNS rebinding: the name is fine, the address is not."""
    monkeypatch.setattr(policywatch, "_resolve", lambda host, port: ["127.0.0.1"])
    with pytest.raises(policywatch.PolicyWatchError) as exc:
        policywatch.assert_fetchable("https://sell.amazon.com/x")
    assert exc.value.code == "private_address"


@pytest.mark.parametrize(
    "address",
    ["10.0.0.5", "192.168.1.1", "172.16.0.1", "169.254.169.254", "::1", "0.0.0.0"],
)
def test_every_internal_range_is_blocked(monkeypatch, address):
    monkeypatch.setattr(policywatch, "_resolve", lambda host, port: [address])
    with pytest.raises(policywatch.PolicyWatchError):
        policywatch.assert_fetchable("https://sell.amazon.com/x")


def test_a_public_address_passes():
    assert policywatch.assert_fetchable("https://sell.amazon.com/x") == ["93.184.216.34"]


def test_a_redirect_off_the_allowlist_is_refused(monkeypatch, watched):
    """The first host being allowed says nothing about where it points."""
    def handler(request):
        if request.url.host == "sell.amazon.com":
            return httpx.Response(302, headers={"location": "https://evil.example.com/steal"})
        return httpx.Response(200, text="should never be reached")

    monkeypatch.setattr(policywatch, "_make_client", transport(handler))
    result = policywatch.check_watch(watched)

    assert result["result"] == policywatch.FAILED
    assert result["error"] == "host_not_allowed"
    assert result["candidate"] is None


def test_a_redirect_to_a_private_address_is_refused(monkeypatch, watched):
    def handler(request):
        return httpx.Response(302, headers={"location": "https://help.shopify.com/internal"})

    resolutions = {"sell.amazon.com": ["93.184.216.34"], "help.shopify.com": ["10.1.2.3"]}
    monkeypatch.setattr(policywatch, "_resolve", lambda host, port: resolutions[host])
    monkeypatch.setattr(policywatch, "_make_client", transport(handler))

    result = policywatch.check_watch(watched)
    assert result["result"] == policywatch.FAILED
    assert result["error"] == "private_address"


def test_an_oversized_response_is_refused(monkeypatch, watched):
    def handler(request):
        return httpx.Response(200, text="x" * (policywatch.MAX_RESPONSE_BYTES + 10))

    monkeypatch.setattr(policywatch, "_make_client", transport(handler))
    result = policywatch.check_watch(watched)

    assert result["result"] == policywatch.FAILED
    assert result["error"] == "response_too_large"


def test_a_timeout_changes_nothing(monkeypatch, watched):
    def handler(request):
        raise httpx.ConnectTimeout("slow")

    monkeypatch.setattr(policywatch, "_make_client", transport(handler))
    result = policywatch.check_watch(watched)

    assert result["result"] == policywatch.FAILED
    assert result["error"] == "timeout"
    assert policywatch.list_candidates() == []


# --------------------------------------------------------------------------- #
# Change detection                                                             #
# --------------------------------------------------------------------------- #


def test_an_unchanged_etag_produces_no_candidate(monkeypatch, watched):
    def handler(request):
        if request.headers.get("if-none-match") == '"v1"':
            return httpx.Response(304)
        return httpx.Response(200, text=PAGE_V1, headers={"etag": '"v1"'})

    monkeypatch.setattr(policywatch, "_make_client", transport(handler))

    first = policywatch.check_watch(watched)
    assert first["result"] == policywatch.CHANGED  # first sight is always new

    second = policywatch.check_watch(watched)
    assert second["result"] == policywatch.UNCHANGED
    assert second["candidate"] is None
    assert len(policywatch.list_candidates()) == 1


def test_identical_content_under_a_new_etag_is_still_unchanged(monkeypatch, watched):
    """Hashing normalised text, not raw HTML, keeps noise out of the diff."""
    responses = [
        httpx.Response(200, text=PAGE_V1, headers={"etag": '"a"'}),
        httpx.Response(
            200,
            text=PAGE_V1.replace("<body>", '<body data-nonce="xyz">'),
            headers={"etag": '"b"'},
        ),
    ]
    monkeypatch.setattr(policywatch, "_make_client", transport(lambda r: responses.pop(0)))

    policywatch.check_watch(watched)
    second = policywatch.check_watch(watched)

    assert second["result"] == policywatch.UNCHANGED


def test_changed_content_creates_a_candidate_and_activates_nothing(monkeypatch, watched):
    responses = [
        httpx.Response(200, text=PAGE_V1, headers={"etag": '"v1"'}),
        httpx.Response(200, text=PAGE_V2, headers={"etag": '"v2"'}),
    ]
    monkeypatch.setattr(policywatch, "_make_client", transport(lambda r: responses.pop(0)))
    before = {v: policy.load_registry()[v].version for v in policy.load_registry()}

    policywatch.check_watch(watched)
    second = policywatch.check_watch(watched)
    candidate = second["candidate"]

    assert second["result"] == policywatch.CHANGED
    assert candidate["state"] == policywatch.CHANGED
    assert candidate["current_snapshot_id"] == "amazon-us-2025.01.21"
    assert candidate["previous_content_hash"] != candidate["content_hash"]
    assert candidate["retrieved_at"]
    assert "180" in candidate["excerpt"] or "characters" in candidate["excerpt"]
    # the live rulebook is untouched
    assert {v: policy.load_registry()[v].version for v in policy.load_registry()} == before


def test_a_page_that_cannot_be_parsed_records_evidence_and_no_rule_change(monkeypatch, watched):
    def handler(request):
        return httpx.Response(200, text="<html><head><script>var a=1;</script></head></html>")

    monkeypatch.setattr(policywatch, "_make_client", transport(handler))
    result = policywatch.check_watch(watched)

    assert result["result"] == policywatch.FAILED
    assert result["error"] == "parse_failed"
    assert policywatch.list_candidates() == []
    events = [e["event"] for e in policywatch.events()]
    assert "check_failed" in events


def test_an_http_error_is_recorded_without_a_candidate(monkeypatch, watched):
    monkeypatch.setattr(
        policywatch, "_make_client", transport(lambda r: httpx.Response(503, text="down"))
    )
    result = policywatch.check_watch(watched)

    assert result["result"] == policywatch.FAILED
    assert result["error"] == "http_status"
    assert policywatch.list_candidates() == []


# --------------------------------------------------------------------------- #
# Review                                                                       #
# --------------------------------------------------------------------------- #


def _one_candidate(monkeypatch, watched):
    responses = [
        httpx.Response(200, text=PAGE_V1, headers={"etag": '"v1"'}),
        httpx.Response(200, text=PAGE_V2, headers={"etag": '"v2"'}),
    ]
    monkeypatch.setattr(policywatch, "_make_client", transport(lambda r: responses.pop(0)))
    policywatch.check_watch(watched)
    return policywatch.check_watch(watched)["candidate"]


def test_approval_requires_a_named_operator(monkeypatch, watched):
    candidate = _one_candidate(monkeypatch, watched)
    with pytest.raises(policywatch.PolicyWatchError) as exc:
        policywatch.approve_candidate(candidate["candidate_id"], operator="   ")
    assert exc.value.code == "missing_operator"


def test_approval_confirms_the_change_but_still_writes_no_snapshot(monkeypatch, watched):
    candidate = _one_candidate(monkeypatch, watched)
    before = sorted(policy.load_registry())

    approved = policywatch.approve_candidate(
        candidate["candidate_id"], operator="lottie", reason="确认官方页面已更新"
    )

    assert approved["state"] == policywatch.APPROVED
    assert approved["reviewed_by"] == "lottie"
    assert approved["activation"]["activated"] is False
    assert "人工提交" in approved["activation"]["note"]
    assert sorted(policy.load_registry()) == before


def test_a_candidate_cannot_be_reviewed_twice(monkeypatch, watched):
    candidate = _one_candidate(monkeypatch, watched)
    policywatch.approve_candidate(candidate["candidate_id"], operator="lottie")

    with pytest.raises(policywatch.PolicyWatchError) as exc:
        policywatch.approve_candidate(candidate["candidate_id"], operator="lottie")
    assert exc.value.code == "already_reviewed"


def test_rejecting_needs_a_reason(monkeypatch, watched):
    candidate = _one_candidate(monkeypatch, watched)
    with pytest.raises(policywatch.PolicyWatchError):
        policywatch.reject_candidate(candidate["candidate_id"], operator="lottie", reason="")

    rejected = policywatch.reject_candidate(
        candidate["candidate_id"], operator="lottie", reason="只是排版调整"
    )
    assert rejected["state"] == policywatch.REJECTED


def test_a_model_reading_is_labelled_and_never_authoritative(monkeypatch, watched):
    candidate = _one_candidate(monkeypatch, watched)
    annotated = policywatch.attach_interpretation(
        candidate["candidate_id"], "标题上限似乎从 200 降到 180", provider="aliyun", model="qwen"
    )

    interpretation = annotated["interpretation"]
    assert interpretation["assisted_by"] == "model"
    assert interpretation["authoritative"] is False
    assert "确定性" in interpretation["note"]


# --------------------------------------------------------------------------- #
# HTTP surface                                                                 #
# --------------------------------------------------------------------------- #


def test_the_watch_endpoint_exposes_the_allowlist():
    data = client.get("/api/policy/watch").json()["data"]
    assert "sell.amazon.com" in data["allowlist"]
    assert "evil.example.com" not in data["allowlist"]


def test_checking_an_unknown_watch_is_a_404():
    assert client.post("/api/policy/watch/nope/check").status_code == 404


# --------------------------------------------------------------------------- #
# Localization boundaries                                                      #
# --------------------------------------------------------------------------- #


def test_the_us_market_is_covered_by_real_snapshots():
    result = localization.coverage("US")
    assert result["coverage"] == localization.COVERED
    assert "amazon" in result["covered_platforms"]
    assert result["verifiable"] is True


def test_a_market_without_a_snapshot_says_so_instead_of_borrowing_us_rules():
    result = localization.coverage("DE")
    assert result["coverage"] == localization.NOT_COVERED
    assert result["label"] == "政策未覆盖，需人工复核"
    assert result["verifiable"] is False
    assert result["covered_platforms"] == []


def test_no_market_may_report_verified_without_its_own_snapshot():
    assert localization.may_mark_verified("US", "amazon") is True
    for market in ("UK", "DE", "FR", "JP"):
        assert localization.may_mark_verified(market, "amazon") is False, market


def test_the_five_named_markets_have_localization_metadata():
    for market in ("US", "UK", "DE", "FR", "JP"):
        found = localization.profile(market)
        assert found.language and found.currency and found.measurement_system


def test_conversion_is_deterministic_and_keeps_the_original():
    conversion = localization.convert_for_market("capacity", "0.35", "L", "DE")
    assert conversion.original_value == "0.35"
    assert conversion.canonical_value == "350"
    assert conversion.canonical_unit == "ml"
    assert conversion.display_value == "350"
    assert localization.convert_for_market("capacity", "0.35", "L", "DE") == conversion


def test_an_imperial_market_converts_for_display_without_moving_the_canonical_value():
    conversion = localization.convert_for_market("capacity", "350", "ml", "US")
    assert conversion.canonical_value == "350"
    assert conversion.canonical_unit == "ml"
    assert conversion.display_unit == "fl oz"
    assert conversion.display_value.startswith("11.8")


def test_an_unconvertible_reading_is_left_alone_rather_than_guessed():
    conversion = localization.convert_for_market("capacity", "about a cup", "", "US")
    assert conversion.method == "unconverted"
    assert conversion.canonical_value == "about a cup"


def test_localization_settings_are_marked_declared_not_verified():
    settings = localization.settings("DE")
    assert settings["target_market"] == "DE"
    assert settings["target_language"] == "de-DE"
    assert settings["currency"] == "EUR"
    assert settings["declared_by"] == "operator"
    assert settings["verified"] is False
    assert settings["label"] == "政策未覆盖，需人工复核"


def test_the_markets_endpoint_annotates_each_market_with_real_coverage():
    markets = client.get("/api/localization/markets").json()["data"]["markets"]
    by_market = {m["market"]: m for m in markets}

    assert by_market["US"]["coverage"] == "covered"
    assert by_market["JP"]["coverage"] == "not_covered"
    assert by_market["JP"]["label"] == "政策未覆盖，需人工复核"


def test_the_convert_endpoint_returns_a_traceable_conversion():
    data = client.post(
        "/api/localization/convert",
        json={"key": "folded_height", "value": "40", "unit": "mm", "market": "DE"},
    ).json()["data"]["conversion"]

    assert data["original"] == "40 mm"
    assert data["canonical"] == "4 cm"
    assert data["method"] == "registry:length"
