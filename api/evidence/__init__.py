"""Evidence-backed product fact ledger.

``store``   content-addressed persistence for uploaded documents
``extract`` deterministic text extraction, with the method recorded
``facts``   atomic facts, their states, and their links to evidence locations
``gate``    the release gate: is every commercial claim actually backed?
"""

from __future__ import annotations

from . import extract, facts, gate, store
from .store import EvidenceError

__all__ = ["extract", "facts", "gate", "store", "EvidenceError"]
