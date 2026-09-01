from __future__ import annotations

import os
from pathlib import Path


def _load_dotenv() -> None:
    path = Path(__file__).resolve().parent / ".env"
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv()


def upstream() -> str:
    return os.environ.get("LISTING_UPSTREAM_URL", "").rstrip("/")


def upstream_user() -> str:
    return os.environ.get("LISTING_UPSTREAM_USER", "listing-demo")
