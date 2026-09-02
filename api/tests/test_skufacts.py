"""Stable SKU fact IDs + deterministic fact-reference extraction."""

from __future__ import annotations

import skufacts
from tests.helpers import NAME, POINTS_300, POINTS_350


def test_parse_sku_facts_gives_stable_ids():
    facts = skufacts.parse_sku_facts(NAME, POINTS_350)
    assert list(facts) == ["name", "fact-1", "fact-2", "fact-3", "fact-4", "fact-5"]
    assert facts["name"] == NAME
    assert facts["fact-3"] == "防漏盖，350ml"
    # blank lines do not create empty facts or shift later numbering
    facts2 = skufacts.parse_sku_facts("X", "a\n\n\nb")
    assert facts2 == {"name": "X", "fact-1": "a", "fact-2": "b"}


def test_compute_fact_refs_matches_measurements_and_phrases():
    facts = skufacts.parse_sku_facts(NAME, POINTS_350)
    refs = skufacts.compute_fact_refs("Folds flat to 4cm, 350ml leak-proof lid", facts)
    assert "fact-1" in refs  # 4cm
    assert "fact-3" in refs  # 350ml
    assert "fact-2" not in refs  # no temperature mentioned


def test_compute_fact_refs_ignores_incidental_cjk_overlap():
    facts = {"fact-1": "防漏盖，350ml"}
    # "防漏测试" shares two characters but is not the same phrase
    assert skufacts.compute_fact_refs("防漏测试 → 温度范围", facts) == []


def test_validate_fact_refs_drops_unknown_ids():
    facts = skufacts.parse_sku_facts("X", "a\nb")
    assert skufacts.validate_fact_refs(["fact-1", "fact-9", "bogus", "name"], facts) == [
        "name",
        "fact-1",
    ]


def test_diff_facts_reports_only_the_changed_capacity_line():
    before = skufacts.parse_sku_facts(NAME, POINTS_350)
    after = skufacts.parse_sku_facts(NAME, POINTS_300)
    delta = skufacts.diff_facts(before, after)
    assert delta == {"added": [], "removed": [], "changed": ["fact-3"]}


def test_sku_revision_hash_is_stable_and_order_independent():
    a = skufacts.parse_sku_facts("X", "one\ntwo")
    b = {"fact-2": "two", "name": "X", "fact-1": "one"}
    assert skufacts.sku_revision_hash(a) == skufacts.sku_revision_hash(b)
