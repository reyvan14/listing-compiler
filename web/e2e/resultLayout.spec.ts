import { expect, test, type Page } from '@playwright/test';

// Compact result cards + vertical fan-out layout. Detail lives in the
// viewport-level inspector (see listingInspector.spec.ts), so the cards here
// are permanently compact. No model provider is contacted.

const SHOTS = 'e2e/screenshots';

async function waitForStation(page: Page) {
  await page.goto('/');
  await page.waitForSelector('#station-generate', { timeout: 20_000 });
  await page.waitForTimeout(900);
}

function tag(testInfo: { project: { name: string } }) {
  return testInfo.project.name;
}

async function generate(page: Page) {
  await page.click('#station-fill');
  await page.waitForTimeout(150);
  await page.click('#station-generate');
  await page.waitForSelector('[data-testid="listing-result"]', { timeout: 25_000 });
  // let the spawn + layout + one-time auto-frame settle
  await page.waitForTimeout(1200);
}

type CardGeom = {
  platform: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

/** Page-space geometry of every platform result card, top to bottom. */
async function cardGeometry(page: Page): Promise<CardGeom[]> {
  return page.evaluate(() => {
    const editor = (window as unknown as { editor: any }).editor;
    return editor
      .getCurrentPageShapes()
      .filter(
        (s: any) =>
          s.type === 'node' &&
          s.props?.node?.type === 'listing_result' &&
          s.props.node.platform !== 'ad',
      )
      .map((s: any) => {
        const b = editor.getShapePageBounds(s.id);
        return {
          platform: s.props.node.platform,
          x: b.x,
          y: b.y,
          w: b.w,
          h: b.h,
        };
      })
      .sort((a: CardGeom, b: CardGeom) => a.y - b.y);
  });
}

async function skuBounds(page: Page) {
  return page.evaluate(() => {
    const editor = (window as unknown as { editor: any }).editor;
    const sku = editor
      .getCurrentPageShapes()
      .find((s: any) => s.props?.node?.type === 'sku_listing');
    const b = editor.getShapePageBounds(sku.id);
    return { x: b.x, y: b.y, w: b.w, h: b.h };
  });
}

async function camera(page: Page) {
  return page.evaluate(() => (window as unknown as { editor: any }).editor.getCamera());
}

function card(page: Page, platform: string) {
  return page.locator(`[data-testid="listing-result"][data-platform="${platform}"]`);
}

// --------------------------------------------------------------------------- //
// 1. compact by default, consistent dimensions                                //
// --------------------------------------------------------------------------- //

test('all three result cards start compact with identical dimensions', async ({
  page,
}, testInfo) => {
  await waitForStation(page);
  await generate(page);

  const cards = await cardGeometry(page);
  expect(cards.map(c => c.platform).sort()).toEqual(['amazon', 'shopify', 'tiktok']);
  // identical width AND height — no more "Amazon is extremely tall"
  const widths = new Set(cards.map(c => Math.round(c.w)));
  const heights = new Set(cards.map(c => Math.round(c.h)));
  expect([...widths]).toHaveLength(1);
  expect([...heights]).toHaveLength(1);

  // every card renders the compact summary, not the full check list
  for (const c of cards) {
    await expect(card(page, c.platform).getByTestId('check-summary')).toBeVisible();
    await expect(card(page, c.platform).getByTestId('open-details')).toHaveText('查看详情');
  }
  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-layout-01-compact.png` });
});

test('compact cards clamp the title to 2 lines and show at most 3 fields', async ({ page }) => {
  await waitForStation(page);
  await generate(page);

  const amazon = card(page, 'amazon');
  // the Amazon draft has more than three fields; compact shows three
  const fieldRows = amazon.locator('dl > div');
  expect(await fieldRows.count()).toBeLessThanOrEqual(3);

  // title is visually clamped: rendered height fits two lines
  const title = amazon.locator('dl').first().locator('xpath=..').locator('p').first();
  const box = await title.boundingBox();
  const lineHeight = await title.evaluate(
    (el: Element) => parseFloat(getComputedStyle(el).lineHeight) || 17,
  );
  expect(box!.height).toBeLessThanOrEqual(lineHeight * 2 + 2);

  // and the underlying title really is longer than what is displayed
  const full = await page.evaluate(() => {
    const editor = (window as unknown as { editor: any }).editor;
    return editor
      .getCurrentPageShapes()
      .find((s: any) => s.props?.node?.platform === 'amazon').props.node.title as string;
  });
  expect(full.length).toBeGreaterThan(60);
});

// --------------------------------------------------------------------------- //
// 3. vertical fan-out layout                                                  //
// --------------------------------------------------------------------------- //

test('results stack vertically on the right of the SKU node, sharing one X', async ({ page }) => {
  await waitForStation(page);
  await generate(page);

  const sku = await skuBounds(page);
  const cards = await cardGeometry(page);

  // same X for all three, and all to the right of the SKU compiler
  const xs = new Set(cards.map(c => Math.round(c.x)));
  expect([...xs]).toHaveLength(1);
  expect(cards[0].x).toBeGreaterThan(sku.x + sku.w);

  // strictly stacked, non-overlapping, top to bottom
  for (let i = 1; i < cards.length; i++) {
    expect(cards[i].y).toBeGreaterThanOrEqual(cards[i - 1].y + cards[i - 1].h);
  }

  // NOT one very wide horizontal row
  const groupW = Math.max(...cards.map(c => c.x + c.w)) - Math.min(...cards.map(c => c.x));
  const groupH = Math.max(...cards.map(c => c.y + c.h)) - Math.min(...cards.map(c => c.y));
  expect(groupH).toBeGreaterThan(groupW);

  // the stack is vertically centred on the SKU node (or clamped at the origin)
  const groupCentre = Math.min(...cards.map(c => c.y)) + groupH / 2;
  const skuCentre = sku.y + sku.h / 2;
  expect(Math.abs(groupCentre - skuCentre)).toBeLessThan(groupH / 2);
});

test('generation keeps the canvas at a readable zoom', async ({ page }) => {
  await waitForStation(page);
  await generate(page);
  const { z } = await camera(page);
  // MIN_STATION_ZOOM is the readability floor; the old wide row went well below it
  expect(z).toBeGreaterThanOrEqual(0.79);
});

// --------------------------------------------------------------------------- //
// 2. expansion                                                                //
// --------------------------------------------------------------------------- //

test('compact cards do not overflow their own box, Agent open or collapsed', async ({ page }) => {
  await waitForStation(page);
  await generate(page);

  const overflow = async () =>
    page.locator('[data-testid="listing-result"]').evaluateAll((els: Element[]) =>
      els.map(el => ({
        dx: el.scrollWidth - el.clientWidth,
        dy: el.scrollHeight - el.clientHeight,
      })),
    );

  for (const row of await overflow()) {
    expect(row.dx).toBeLessThanOrEqual(1);
    expect(row.dy).toBeLessThanOrEqual(1);
  }

  // toggle the Agent panel and re-check
  const collapse = page.getByRole('button', { name: '收起 Agent 面板' });
  const expand = page.getByRole('button', { name: '展开 Agent 面板' });
  if (await collapse.isVisible().catch(() => false)) await collapse.click();
  else await expand.click();
  await page.waitForTimeout(400);

  for (const row of await overflow()) {
    expect(row.dx).toBeLessThanOrEqual(1);
    expect(row.dy).toBeLessThanOrEqual(1);
  }
});
