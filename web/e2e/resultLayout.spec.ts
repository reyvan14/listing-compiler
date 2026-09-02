import { expect, test, type Page } from '@playwright/test';

// Compact result cards + vertical fan-out layout + single-card expansion.
// Runs against the production-like build; no model provider is contacted.

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
  expanded: boolean;
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
          expanded: !!s.props.node.expanded,
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

/**
 * Pan the camera so one card is fully on screen.
 *
 * A three-card vertical stack is taller than a 900px viewport, so the bottom
 * card starts below the fold — the same scroll a user does. Panning is a plain
 * camera move; the expand/collapse assertions snapshot the camera *after* this
 * so they still prove that toggling detail leaves it untouched.
 */
async function bringIntoView(page: Page, platform: string) {
  await page.evaluate(p => {
    const editor = (window as unknown as { editor: any }).editor;
    const shape = editor
      .getCurrentPageShapes()
      .find((s: any) => s.props?.node?.platform === p && s.props?.node?.type === 'listing_result');
    const b = editor.getShapePageBounds(shape.id);
    const vsb = editor.getViewportScreenBounds();
    const z = editor.getCamera().z;
    // Align the card's TOP near the top of the viewport rather than centring:
    // an expanded card can be taller than the screen, and its header (which
    // carries the detail toggle) must stay clear of the floating toolbar.
    editor.setCamera(
      {
        x: (vsb.w - 372) / 2 / z - (b.x + b.w / 2),
        y: 90 / z - b.y,
        z,
      },
      { immediate: true },
    );
  }, platform);
  await page.waitForTimeout(250);
}

/**
 * Double-click a card on the canvas.
 *
 * The card body has pointer-events disabled (so the node stays draggable), so
 * a DOM dblclick is swallowed by the tldraw background. Dispatching real mouse
 * events at the card's screen position is what a user actually does, and lets
 * tldraw hit-test the shape and route to NodeShapeUtil.onDoubleClick.
 */
async function dblclickCard(page: Page, platform: string) {
  const box = await card(page, platform).boundingBox();
  if (!box) throw new Error(`card ${platform} has no box`);
  // near the top-left of the card, clear of the floating toolbar at the bottom
  await page.mouse.dblclick(box.x + 40, box.y + 24);
  await page.waitForTimeout(300);
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
  expect(cards.every(c => !c.expanded)).toBe(true);

  // identical width AND height — no more "Amazon is extremely tall"
  const widths = new Set(cards.map(c => Math.round(c.w)));
  const heights = new Set(cards.map(c => Math.round(c.h)));
  expect([...widths]).toHaveLength(1);
  expect([...heights]).toHaveLength(1);

  // every card renders the compact summary, not the full check list
  for (const c of cards) {
    await expect(card(page, c.platform).getByTestId('check-summary')).toBeVisible();
    await expect(card(page, c.platform).getByTestId('toggle-details')).toHaveText('查看详情');
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

test('View details expands one card and only one at a time', async ({ page }, testInfo) => {
  await waitForStation(page);
  await generate(page);
  const before = await cardGeometry(page);
  const compactH = before[0].h;

  await bringIntoView(page, 'amazon');
  await card(page, 'amazon').getByTestId('toggle-details').click();
  await page.waitForTimeout(300);

  let cards = await cardGeometry(page);
  let byPlatform = Object.fromEntries(cards.map(c => [c.platform, c]));
  expect(byPlatform.amazon.expanded).toBe(true);
  expect(byPlatform.amazon.h).toBeGreaterThan(compactH);
  expect(byPlatform.tiktok.expanded).toBe(false);
  expect(byPlatform.shopify.expanded).toBe(false);
  await expect(card(page, 'amazon').getByTestId('toggle-details')).toHaveText('收起详情');
  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-layout-02-expanded.png` });

  // expanding another collapses the first
  await bringIntoView(page, 'shopify');
  await card(page, 'shopify').getByTestId('toggle-details').click();
  await page.waitForTimeout(300);
  cards = await cardGeometry(page);
  byPlatform = Object.fromEntries(cards.map(c => [c.platform, c]));
  expect(byPlatform.shopify.expanded).toBe(true);
  expect(byPlatform.amazon.expanded).toBe(false);
  expect(cards.filter(c => c.expanded)).toHaveLength(1);
});

test('double-clicking a result card also expands it', async ({ page }) => {
  await waitForStation(page);
  await generate(page);

  await bringIntoView(page, 'tiktok');
  await dblclickCard(page, 'tiktok');
  const cards = await cardGeometry(page);
  expect(cards.find(c => c.platform === 'tiktok')!.expanded).toBe(true);
  expect(cards.filter(c => c.expanded)).toHaveLength(1);
});

test('expanded mode reveals the details the compact card hides', async ({ page }) => {
  await waitForStation(page);
  await generate(page);

  await bringIntoView(page, 'amazon');
  const amazon = card(page, 'amazon');
  await expect(amazon.getByTestId('check-summary')).toBeVisible();
  const compactFields = await amazon.locator('dl > div').count();

  await amazon.getByTestId('toggle-details').click();
  await page.waitForTimeout(300);

  // full check list replaces the one-line summary
  await expect(amazon.getByTestId('check-summary')).toHaveCount(0);
  expect(await amazon.locator('ul li').count()).toBeGreaterThan(0);
  // and all fields are shown, not just three
  expect(await amazon.locator('dl > div').count()).toBeGreaterThan(compactFields);
});

test('collapsing restores the original card size', async ({ page }) => {
  await waitForStation(page);
  await generate(page);
  const before = await cardGeometry(page);

  await bringIntoView(page, 'amazon');
  await card(page, 'amazon').getByTestId('toggle-details').click();
  await page.waitForTimeout(300);
  // the expanded card is taller than the viewport — re-centre before collapsing
  await bringIntoView(page, 'amazon');
  await card(page, 'amazon').getByTestId('toggle-details').click();
  await page.waitForTimeout(300);

  const after = await cardGeometry(page);
  expect(after.map(c => ({ p: c.platform, w: Math.round(c.w), h: Math.round(c.h) }))).toEqual(
    before.map(c => ({ p: c.platform, w: Math.round(c.w), h: Math.round(c.h) })),
  );
});

// --------------------------------------------------------------------------- //
// 5. stability: camera and ports                                              //
// --------------------------------------------------------------------------- //

test('expanding and collapsing never moves the canvas camera', async ({ page }) => {
  await waitForStation(page);
  await generate(page);
  await bringIntoView(page, 'amazon');
  // snapshot after the pan: from here on, nothing may move the camera
  const before = await camera(page);

  await card(page, 'amazon').getByTestId('toggle-details').click();
  await page.waitForTimeout(400);
  expect(await camera(page)).toEqual(before);

  await dblclickCard(page, 'amazon');
  expect(await camera(page)).toEqual(before);

  await dblclickCard(page, 'amazon');
  expect(await camera(page)).toEqual(before);
});

test('input port stays on its connection point after expanding', async ({ page }) => {
  await waitForStation(page);
  await generate(page);

  /** Page-space y of the amazon card's input port, and of the connection end. */
  const portY = () =>
    page.evaluate(() => {
      const editor = (window as unknown as { editor: any }).editor;
      const shape = editor
        .getCurrentPageShapes()
        .find((s: any) => s.props?.node?.platform === 'amazon');
      const b = editor.getShapePageBounds(shape.id);
      // the listing_result input port is fixed at NODE_HEADER_HEIGHT_PX / 2
      return { top: b.y, portOffset: 20 };
    });

  const before = await portY();
  await bringIntoView(page, 'amazon');
  await card(page, 'amazon').getByTestId('toggle-details').click();
  await page.waitForTimeout(400);
  const after = await portY();

  // the card grows downward: its top edge (and therefore its input port) is fixed
  expect(Math.round(after.top)).toBe(Math.round(before.top));
  expect(after.portOffset).toBe(before.portOffset);

  // the connection is still bound to the card at both ends
  const bound = await page.evaluate(() => {
    const editor = (window as unknown as { editor: any }).editor;
    const shape = editor
      .getCurrentPageShapes()
      .find((s: any) => s.props?.node?.platform === 'amazon');
    return editor
      .getBindingsToShape(shape.id, 'connection')
      .some((b: any) => b.props?.portId === 'input');
  });
  expect(bound).toBe(true);
});

// --------------------------------------------------------------------------- //
// 4. blocking visibility survives compaction                                  //
// --------------------------------------------------------------------------- //

test('a blocking violation stays visible while details are collapsed', async ({
  page,
}, testInfo) => {
  await waitForStation(page);
  await page.route('**/api/listing/generate', async route => {
    const body = await (await route.fetch()).json();
    const drafts = (body?.data?.drafts ?? []).map((d: Record<string, unknown>) =>
      d.id === 'tiktok'
        ? {
            ...d,
            title:
              'Stop carrying bulky mugs! 🧘‍♀️✨ AeroFold Silicone Travel Cup. ' +
              '#travelhacks #campinggear',
          }
        : d,
    );
    const regraded = await route.request().frame().page().request.post(
      '/api/listing/validate',
      {
        data: {
          drafts,
          product_name: 'AeroFold Silicone Travel Cup',
          points: 'Folds to 4.5cm\n350ml',
          asset_mode: 'compliant',
        },
      },
    );
    const checked = (await regraded.json())?.data?.drafts ?? drafts;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...body, data: { ...body.data, drafts: checked } }),
    });
  });
  await generate(page);

  const tiktok = card(page, 'tiktok');
  // compact: one concise red banner, no detail list, no full gate
  await expect(tiktok).toHaveAttribute('data-expanded', '0');
  const badge = tiktok.getByTestId('blocking-badge');
  await expect(badge).toBeVisible();
  await expect(badge).toContainText('阻断违规');
  await expect(badge).toContainText('需人工复核');
  await expect(tiktok.getByTestId('blocking-gate')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-layout-03-blocking-compact.png` });

  // expanding reveals the full gate, the suggested title and every explanation
  await bringIntoView(page, 'tiktok');
  await tiktok.getByTestId('toggle-details').click();
  await page.waitForTimeout(300);
  await expect(tiktok.getByTestId('blocking-gate')).toBeVisible();
  await expect(tiktok.getByTestId('suggested-title')).toBeVisible();
  expect(await tiktok.locator('li[data-blocking="1"]').count()).toBeGreaterThanOrEqual(1);
});

// --------------------------------------------------------------------------- //
// 6. responsive / no overflow                                                 //
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
