"""Deterministic TikTok Shop title sanitizer.

Splits a social-caption-style title into:
  * a clean product title (brand/product type + factual attributes + size), and
  * the hashtags, which belong in a separate optional social-caption field.

Deterministic and offline — this is the suggested correction shown next to each
violation, never an auto-applied rewrite. Nothing here decides whether a listing
may proceed; that stays with the blocking-violation gate in ``checker.py``.
"""

from __future__ import annotations

import re

from policy import text_rules

#: Field label for the optional social caption that carries the hashtags.
SOCIAL_CAPTION_LABEL = "社交文案"

_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?！？])\s+|\n+")


def extract_hashtags(title: str) -> list[str]:
    """Hashtags found in *title*, in order, deduplicated."""
    return text_rules.find_hashtags(title)


def social_caption(title: str) -> str:
    """The optional social caption: just the hashtags, space separated.

    Empty when the title carries none — the field is optional and we never
    invent copy that the operator did not write.
    """
    return " ".join(extract_hashtags(title))


def _strip_lead_in(text: str) -> str:
    """Drop a conversational lead-in such as 'Meet the ' so the sentence starts
    on the brand / product type."""
    return re.sub(
        r"^(?:meet the|meet|introducing|check out|say hello to|this is)\s+",
        "",
        text.strip(),
        flags=re.IGNORECASE,
    ).strip()


_WORD_COUNT_RE = re.compile(r"[A-Za-z0-9][\w.-]*|[一-鿿]")

#: A leading sentence is only discarded when stripping its promotional phrase
#: leaves fewer than this many words — i.e. it was nothing but a hook.
_MIN_SUBSTANTIVE_WORDS = 3


def _is_pure_hook(sentence: str) -> bool:
    """True when the sentence is only a promotional hook, carrying no product
    facts worth keeping."""
    if text_rules.find_size_tokens(sentence):
        return False  # carries a real attribute — never discard
    promos = text_rules.find_promotional(sentence)
    if not promos:
        return False
    residue = sentence.lower()
    for hit in promos:
        residue = residue.replace(hit["phrase"], " ")
    return len(_WORD_COUNT_RE.findall(residue)) < _MIN_SUBSTANTIVE_WORDS


def _drop_promotional_sentences(text: str) -> str:
    """Remove leading sentences that are *purely* a promotional hook.

    A conversational lead-in ("Meet the AeroFold…") is resolved by stripping the
    lead-in, not by discarding the sentence — that sentence carries the brand
    and product type, which the title must lead with.
    """
    parts = [p.strip() for p in _SENTENCE_SPLIT_RE.split(text) if p.strip()]
    kept: list[str] = []
    for i, part in enumerate(parts):
        stripped = _strip_lead_in(part) if not kept else part
        if not kept and _is_pure_hook(stripped) and i < len(parts) - 1:
            continue  # leading hook with nothing substantive in it
        kept.append(stripped if not kept else part)
    # Sentence breaks become commas so the result reads as one product title
    # rather than a run-on of caption sentences.
    return ", ".join(p.rstrip(".!?！？").strip() for p in kept if p.strip())


def suggest_title(title: str, *, max_length: int = 200) -> str:
    """A cleaned-up product title: no emoji, no hashtags, no promo hook.

    Deterministic string surgery only. It may still fail the minimum-length
    rule (there is no invented copy to pad it with) — the caller surfaces that
    as a remaining violation rather than fabricating attributes.
    """
    body = text_rules.strip_hashtags(text_rules.strip_emojis(title or ""))
    body = text_rules.collapse_whitespace(body)
    body = _drop_promotional_sentences(body)
    # The exclamation marks that made it a caption are prohibited symbols too.
    body = re.sub(r"[~!*$?_{}<>|;^¬¦]+", "", body)
    # A trailing period reads as prose, not as a product title.
    body = text_rules.collapse_whitespace(body).rstrip(".")
    body = text_rules.collapse_whitespace(body)
    if len(body) > max_length:
        cut = body[:max_length]
        boundary = re.search(r"[\s,;:\-–—/|]+\S*$", cut)
        if boundary and boundary.start() >= int(max_length * 0.5):
            cut = cut[: boundary.start()]
        body = cut.rstrip(" ,;:-–—/|")
    return body


def split_title(title: str, *, max_length: int = 200) -> dict[str, object]:
    """``{"title", "social_caption", "hashtags", "removed_emojis", "changed"}``."""
    cleaned = suggest_title(title, max_length=max_length)
    hashtags = extract_hashtags(title)
    emojis = text_rules.find_emojis(title or "")
    return {
        "title": cleaned,
        "social_caption": " ".join(hashtags),
        "hashtags": hashtags,
        "removed_emojis": emojis,
        "changed": cleaned != (title or "").strip(),
    }
