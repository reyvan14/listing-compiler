"""Market and locale boundaries: say which markets are actually covered.

The dangerous shortcut in a multi-market tool is to run US rules against a
German listing and print a green tick. The rules would execute, the tick would
render, and nothing would be true. So coverage is a first-class answer here:
a market with no snapshot of its own returns ``政策未覆盖，需人工复核`` and its
checks are never marked verified.

Unit conversion is deterministic and keeps its provenance: every converted
value carries the original reading, the factor applied, and the canonical
result, so a number in a listing can always be traced back to what a document
actually said.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import factsregistry
import policy

# Coverage verdicts ---------------------------------------------------------- #

COVERED = "covered"
NOT_COVERED = "not_covered"

NOT_COVERED_LABEL = "政策未覆盖，需人工复核"


@dataclass(frozen=True)
class MarketProfile:
    """Localization metadata for one target market."""

    market: str
    label: str
    language: str
    language_label: str
    currency: str
    currency_symbol: str
    measurement_system: str
    decimal_separator: str
    thousands_separator: str
    date_format: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "market": self.market,
            "label": self.label,
            "language": self.language,
            "language_label": self.language_label,
            "currency": self.currency,
            "currency_symbol": self.currency_symbol,
            "measurement_system": self.measurement_system,
            "decimal_separator": self.decimal_separator,
            "thousands_separator": self.thousands_separator,
            "date_format": self.date_format,
        }


#: The five markets the spec names. Metadata only -- presence here says nothing
#: about whether we hold a policy snapshot for the market.
MARKETS: dict[str, MarketProfile] = {
    "US": MarketProfile(
        market="US", label="美国", language="en-US", language_label="English (US)",
        currency="USD", currency_symbol="$", measurement_system="imperial",
        decimal_separator=".", thousands_separator=",", date_format="MM/DD/YYYY",
    ),
    "UK": MarketProfile(
        market="UK", label="英国", language="en-GB", language_label="English (UK)",
        currency="GBP", currency_symbol="£", measurement_system="metric",
        decimal_separator=".", thousands_separator=",", date_format="DD/MM/YYYY",
    ),
    "DE": MarketProfile(
        market="DE", label="德国", language="de-DE", language_label="Deutsch",
        currency="EUR", currency_symbol="€", measurement_system="metric",
        decimal_separator=",", thousands_separator=".", date_format="DD.MM.YYYY",
    ),
    "FR": MarketProfile(
        market="FR", label="法国", language="fr-FR", language_label="Français",
        currency="EUR", currency_symbol="€", measurement_system="metric",
        decimal_separator=",", thousands_separator=" ", date_format="DD/MM/YYYY",
    ),
    "JP": MarketProfile(
        market="JP", label="日本", language="ja-JP", language_label="日本語",
        currency="JPY", currency_symbol="¥", measurement_system="metric",
        decimal_separator=".", thousands_separator=",", date_format="YYYY/MM/DD",
    ),
}

DEFAULT_MARKET = "US"

#: Imperial display units per unit family, for markets that use them. Values are
#: still *stored* canonically; this only affects presentation.
_IMPERIAL_DISPLAY: dict[str, tuple[str, float]] = {
    "volume": ("fl oz", 1 / 29.5735),
    "length": ("in", 1 / 2.54),
    "mass": ("oz", 1 / 28.3495),
}


def profile(market: str) -> MarketProfile:
    return MARKETS.get((market or "").upper(), MARKETS[DEFAULT_MARKET])


def markets() -> list[dict[str, Any]]:
    """Every known market, each annotated with its real policy coverage."""
    return [{**p.as_dict(), **coverage(p.market)} for p in MARKETS.values()]


def coverage(market: str, platform: str = "") -> dict[str, Any]:
    """Whether we hold a policy snapshot for this market.

    A snapshot for another market is never reused: an Amazon US snapshot governs
    Amazon US. Answering "covered" for DE on the strength of US rules would be
    the exact fabrication this function exists to prevent.
    """
    market_key = (market or "").upper()
    platforms: dict[str, dict[str, Any]] = {}
    try:
        registry = policy.load_registry()
    except Exception:  # pragma: no cover - defensive
        registry = {}

    wanted = [platform] if platform else sorted({s.platform for s in registry.values()})
    for name in wanted:
        match = next(
            (
                s
                for s in registry.values()
                if s.platform == name
                and s.status == "current"
                and (s.market or "").upper() == market_key
            ),
            None,
        )
        platforms[name] = {
            "platform": name,
            "covered": match is not None,
            "snapshot_id": match.version if match else "",
            "effective_date": match.effective_date if match else "",
            "label": "" if match else NOT_COVERED_LABEL,
        }

    any_covered = any(p["covered"] for p in platforms.values())
    return {
        "market": market_key,
        "coverage": COVERED if any_covered else NOT_COVERED,
        "covered_platforms": sorted(k for k, v in platforms.items() if v["covered"]),
        "uncovered_platforms": sorted(k for k, v in platforms.items() if not v["covered"]),
        "platforms": platforms,
        "label": "" if any_covered else NOT_COVERED_LABEL,
        # Verified compliance is only claimable where a real snapshot exists.
        "verifiable": any_covered,
        "note": (
            ""
            if any_covered
            else f"没有 {market_key} 市场的政策快照，不会套用其他市场的规则，相关检查一律需人工复核。"
        ),
    }


def may_mark_verified(market: str, platform: str) -> bool:
    """Only a market with its own current snapshot may report a verified check."""
    return coverage(market, platform)["platforms"].get(platform, {}).get("covered", False)


@dataclass(frozen=True)
class Conversion:
    """One traceable unit conversion."""

    key: str
    original_value: str
    original_unit: str
    canonical_value: str
    canonical_unit: str
    display_value: str
    display_unit: str
    factor: float
    method: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "original": f"{self.original_value} {self.original_unit}".strip(),
            "canonical": f"{self.canonical_value} {self.canonical_unit}".strip(),
            "display": f"{self.display_value} {self.display_unit}".strip(),
            "factor": self.factor,
            "method": self.method,
        }


def convert_for_market(key: str, value: str, unit: str, market: str) -> Conversion:
    """Present one fact in a market's measurement system, keeping the original.

    The canonical value is what the ledger stores and what comparisons use. The
    display value is presentation only -- converting for display never rewrites
    a stored fact, so a German listing and a US listing quote the same evidence.
    """
    spec = factsregistry.definition(key)
    family = spec.unit_family if spec else ""
    market_profile = profile(market)

    try:
        canonical_number, canonical_unit = factsregistry.normalize_unit(
            float(value), unit, family=family
        )
    except (factsregistry.UnitError, TypeError, ValueError):
        return Conversion(
            key=key, original_value=str(value), original_unit=unit,
            canonical_value=str(value), canonical_unit=unit,
            display_value=str(value), display_unit=unit,
            factor=1.0, method="unconverted",
        )

    display_number, display_unit, factor = canonical_number, canonical_unit, 1.0
    if market_profile.measurement_system == "imperial" and family in _IMPERIAL_DISPLAY:
        display_unit, factor = _IMPERIAL_DISPLAY[family]
        display_number = canonical_number * factor

    return Conversion(
        key=key,
        original_value=_trim(float(value)),
        original_unit=unit,
        canonical_value=_trim(canonical_number),
        canonical_unit=canonical_unit,
        display_value=_trim(display_number),
        display_unit=display_unit,
        factor=factor,
        method=f"registry:{family or 'none'}",
    )


def _trim(number: float) -> str:
    rounded = round(number, 4)
    return str(int(rounded)) if float(rounded).is_integer() else format(rounded, "g")


def settings(market: str, *, source_language: str = "zh-CN") -> dict[str, Any]:
    """Project localization settings, with coverage attached."""
    market_profile = profile(market)
    return {
        "source_language": source_language,
        "target_market": market_profile.market,
        "target_language": market_profile.language,
        "currency": market_profile.currency,
        "measurement_system": market_profile.measurement_system,
        "profile": market_profile.as_dict(),
        **coverage(market_profile.market),
        # These are operator declarations, not measurements of the product.
        "declared_by": "operator",
        "verified": False,
    }
