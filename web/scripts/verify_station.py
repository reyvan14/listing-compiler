#!/usr/bin/env python3
from pathlib import Path

from playwright.sync_api import sync_playwright

SHOTS = Path("/Volumes/DataDisk/Projects/yipin-santai/web/scripts")
CHROME = Path.home() / (
    "Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/"
    "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
)
URL = "http://localhost:8091"


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path=str(CHROME) if CHROME.exists() else None,
            headless=True,
            args=["--disable-gpu", "--disable-software-rasterizer"],
        )
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.goto(URL, wait_until="domcontentloaded", timeout=30000)
        page.wait_for_selector("#station-generate", timeout=20000)
        page.wait_for_timeout(800)
        page.click("#station-fill")
        page.wait_for_timeout(300)
        page.click("#station-generate")
        page.wait_for_function(
            """() => {
              const el = document.querySelector('[data-screen]');
              return el && (el.getAttribute('data-screen') === 'result'
                || el.getAttribute('data-screen') === 'conflict');
            }""",
            timeout=20000,
        )
        page.wait_for_timeout(600)
        out = SHOTS / "verify-result.png"
        page.screenshot(path=str(out), full_page=False)
        screen = page.get_attribute("[data-screen]", "data-screen")
        amazon = page.locator("text=Amazon").count()
        print(f"screen={screen} amazon_text={amazon} shot={out}")
        browser.close()
        return 0 if screen in {"result", "conflict"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
