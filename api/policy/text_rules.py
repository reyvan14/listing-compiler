"""Deterministic text detectors shared by the policy engine and the title sanitizer.

Pure functions over a title string. No model, no network, no I/O.
"""

from __future__ import annotations

import re

# --------------------------------------------------------------------------- #
# Emoji / pictographs                                                          #
# --------------------------------------------------------------------------- #
# Python's `re` has no \p{Emoji}, so the ranges are spelled out. This covers the
# pictographic blocks that actually show up in social captions (emoticons,
# transport, symbols, supplemental/extended pictographs, dingbats, misc symbols)
# plus the ZWJ / variation-selector / skin-tone joiners that glue sequences
# together (e.g. "🧘‍♀️" = U+1F9D8 ZWJ U+2640 VS16).
_EMOJI_CORE = (
    "\U0001F300-\U0001F5FF"  # misc symbols & pictographs
    "\U0001F600-\U0001F64F"  # emoticons
    "\U0001F680-\U0001F6FF"  # transport & map
    "\U0001F900-\U0001F9FF"  # supplemental symbols & pictographs
    "\U0001FA70-\U0001FAFF"  # symbols & pictographs extended-A
    "\U00002600-\U000026FF"  # misc symbols (☕ ✨ ♀)
    "\U00002700-\U000027BF"  # dingbats
    "\U0001F1E6-\U0001F1FF"  # regional indicators (flags)
)
# Modifiers (skin tone, variation selectors) attach to the element before them;
# ZWJ glues elements into one grapheme. Neither is a violation on its own.
_EMOJI_MOD = "️︎\U0001F3FB-\U0001F3FF"
_ZWJ = "‍"
_EMOJI_JOINER = _EMOJI_MOD + _ZWJ

# element = base + modifiers; sequence = element (ZWJ element)*
# Spelling the ZWJ out — rather than lumping it into a character class — keeps
# "🧘‍♀️✨" reported as two findings (the ZWJ sequence, then ✨) instead of one.
_ELEMENT = f"[{_EMOJI_CORE}][{_EMOJI_MOD}]*"
_EMOJI_SEQ_RE = re.compile(f"{_ELEMENT}(?:{_ZWJ}{_ELEMENT})*")
_JOINER_RE = re.compile(f"[{_EMOJI_JOINER}]")

# --------------------------------------------------------------------------- #
# Hashtags                                                                     #
# --------------------------------------------------------------------------- #
# A hashtag is '#' immediately followed by a LETTER. '#' before a digit (e.g.
# "Size #2") is a prohibited *symbol*, reported by the special-character rule,
# not by the hashtag rule — keeping the two findings from double-counting.
_HASHTAG_RE = re.compile(r"#[^\W\d_][\w一-鿿-]*")

# --------------------------------------------------------------------------- #
# Promotional / clickbait openings                                             #
# --------------------------------------------------------------------------- #
# Matched case-insensitively against the *opening* of the title (the first
# sentence / clause) so a factual attribute later in the title is not punished.
DEFAULT_PROMO_OPENERS: tuple[str, ...] = (
    "stop carrying",
    "stop buying",
    "stop using",
    "you won't believe",
    "you wont believe",
    "you'll never",
    "must-have",
    "must have",
    "best ever",
    "best seller",
    "bestseller",
    "game changer",
    "game-changer",
    "life changing",
    "life-changing",
    "say goodbye",
    "meet the",
    "introducing",
    "the only",
    "viral",
    "tiktok made me buy",
    "trust me",
    "obsessed",
)

# Promotional claims TikTok names explicitly, wherever they appear in the title.
DEFAULT_PROMO_PHRASES: tuple[str, ...] = (
    "best seller",
    "bestseller",
    "tiktok exclusive",
    "new release",
    "low stock",
    "free shipping",
    "100% satisfaction",
    "satisfaction guaranteed",
    "% off",
    "limited time",
    "flash sale",
    "hot sale",
)

# The title's "opening" for opener matching: up to the first sentence break.
_OPENING_RE = re.compile(r"^[^.!?！？\n]{0,120}")

# --------------------------------------------------------------------------- #
# Size / capacity attributes                                                   #
# --------------------------------------------------------------------------- #
_SIZE_UNIT = (
    r"(?:ml|cl|l|oz|fl\s?oz|lbs?|kg|g|cm|mm|m|in(?:ch(?:es)?)?|ft|"
    r"mah|w|v|hz|pcs?|pack|count|ct)"
)
_SIZE_RE = re.compile(rf"\b\d+(?:\.\d+)?\s*{_SIZE_UNIT}\b", re.IGNORECASE)


def find_emojis(text: str) -> list[str]:
    """Distinct emoji sequences in *text*, in first-appearance order."""
    seen: list[str] = []
    for match in _EMOJI_SEQ_RE.finditer(text or ""):
        token = match.group(0)
        if token not in seen:
            seen.append(token)
    return seen


def find_hashtags(text: str) -> list[str]:
    """Distinct hashtags (including the leading '#'), in first-appearance order."""
    seen: list[str] = []
    for match in _HASHTAG_RE.finditer(text or ""):
        token = match.group(0)
        if token not in seen:
            seen.append(token)
    return seen


def find_promotional(
    text: str,
    *,
    openers: "tuple[str, ...] | list[str] | None" = None,
    phrases: "tuple[str, ...] | list[str] | None" = None,
) -> list[dict[str, str]]:
    """Promotional / clickbait findings.

    Openers only count at the start of the title (that is what makes them a
    clickbait *opening*); the explicitly-named promo phrases count anywhere.
    """
    body = text or ""
    lowered = body.lower()
    opening = _OPENING_RE.match(lowered)
    opening_text = opening.group(0) if opening else ""

    found: list[dict[str, str]] = []
    seen: set[str] = set()

    for opener in openers if openers is not None else DEFAULT_PROMO_OPENERS:
        needle = str(opener).lower().strip()
        if needle and needle in opening_text and needle not in seen:
            seen.add(needle)
            found.append({"kind": "opening", "phrase": needle})

    for phrase in phrases if phrases is not None else DEFAULT_PROMO_PHRASES:
        needle = str(phrase).lower().strip()
        if needle and needle in lowered and needle not in seen:
            seen.add(needle)
            found.append({"kind": "phrase", "phrase": needle})

    return found


def find_size_tokens(text: str) -> list[str]:
    """Size / capacity attributes such as '350ml', '4.5 cm', '2 pack'."""
    seen: list[str] = []
    for match in _SIZE_RE.finditer(text or ""):
        token = re.sub(r"\s+", "", match.group(0))
        if token not in seen:
            seen.append(token)
    return seen


def strip_emojis(text: str) -> str:
    """Remove emoji sequences (and their orphaned joiners) from *text*."""
    return _JOINER_RE.sub("", _EMOJI_SEQ_RE.sub(" ", text or ""))


def strip_hashtags(text: str) -> str:
    return _HASHTAG_RE.sub(" ", text or "")


def collapse_whitespace(text: str) -> str:
    """Normalise runs of whitespace and the punctuation islands left by removals."""
    out = re.sub(r"\s+", " ", text or "").strip()
    out = re.sub(r"\s+([,.;:!?])", r"\1", out)
    out = re.sub(r"([,;:])\s*([,.;:!?])", r"\1", out)
    return out.strip(" ,;:-–—|")
