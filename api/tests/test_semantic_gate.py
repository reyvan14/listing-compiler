"""P1 — text semantic-fidelity gate for candidate patches."""

from __future__ import annotations

import migration
import semantic_gate
from tests.helpers import POINTS_300, POINTS_350, demo_artifacts, demo_facts


def test_reverse_extract_pulls_measurable_claims():
    got = semantic_gate.reverse_extract_facts("Folds to 4cm, 300ml, rated -40°C to 200°C")
    assert set(got["measurements"]) == {"4cm", "300ml", "-40°c", "200°c"}


def test_fidelity_passes_when_every_claim_is_backed_by_source():
    src = {"fact-3": "防漏盖，300ml", "fact-1": "折叠到 4cm"}
    res = semantic_gate.check_fidelity("Collapsible 300ml cup, folds to 4cm", src)
    assert res["ok"] is True
    assert res["unsupported"] == [] and res["contradictory"] == []


def test_fidelity_blocks_an_unsupported_added_number():
    src = {"fact-3": "防漏盖，300ml"}
    res = semantic_gate.check_fidelity("300ml cup with 1200mAh battery", src)
    assert res["ok"] is False
    assert "1200mah" in res["unsupported"]


def test_fidelity_flags_a_contradiction_on_the_same_unit():
    src = {"fact-3": "防漏盖，300ml"}
    res = semantic_gate.check_fidelity("Roomy 500ml travel cup", src)
    assert res["ok"] is False
    assert res["contradictory"] and res["contradictory"][0]["unit"] == "ml"


def test_candidate_build_uses_an_injected_verifier_not_the_generation_output():
    """The verifier only ever sees (candidate_text, source_facts) — never the
    object that produced the text — so a generation cannot grade itself."""
    seen: list[tuple[str, dict]] = []

    def spy_verifier(text: str, source_facts: dict) -> dict:
        seen.append((text, dict(source_facts)))
        return {"ok": True, "missing": [], "contradictory": [], "unsupported": []}

    arts = demo_artifacts(POINTS_350)
    fb, fa = demo_facts(POINTS_350), demo_facts(POINTS_300)
    impact = migration.analyze_impact(arts, facts_before=fb, facts_after=fa)
    out = migration.build_candidate_patches(
        arts, impact, facts_before=fb, facts_after=fa, verifier=spy_verifier
    )
    assert seen, "verifier should have been consulted"
    for text, source_facts in seen:
        assert isinstance(text, str)
        assert all(isinstance(v, str) for v in source_facts.values())
    # every patch reports the (mocked) semantic result
    assert all("semantic" in p["validation"] for p in out["patches"])


def test_failing_verifier_forces_human_review():
    def reject(_text: str, _src: dict) -> dict:
        return {"ok": False, "missing": [], "contradictory": [], "unsupported": ["9v"]}

    arts = demo_artifacts(POINTS_350)
    fb, fa = demo_facts(POINTS_350), demo_facts(POINTS_300)
    impact = migration.analyze_impact(arts, facts_before=fb, facts_after=fa)
    out = migration.build_candidate_patches(
        arts, impact, facts_before=fb, facts_after=fa, verifier=reject
    )
    assert out["patches"]
    assert all(p["needs_human_review"] for p in out["patches"])
