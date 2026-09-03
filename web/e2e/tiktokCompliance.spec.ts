import { expect, test, type Page } from '@playwright/test';

// TikTok Shop title compliance, end to end against the production-like build.
// The mocked generate response carries the exact title a production API test
// produced and the old validator waved through. No model provider is contacted.

const SHOTS = 'e2e/screenshots';

const FAILED_TITLE =
  'Stop carrying bulky mugs! 🧘‍♀️✨ Meet the AeroFold Silicone Travel Cup. ' +
  'Folds to just 4.5cm! Fits anywhere. ☕🎒 ' +
  '#travelhacks #campinggear #ecofriendly #coffeehack';

async function waitForStation(page: Page) {
  await page.goto('/');
  await page.waitForSelector('#station-generate', { timeout: 20_000 });
  await page.waitForTimeout(900);
}

function tag(testInfo: { project: { name: string } }) {
  return testInfo.project.name;
}

/**
 * Swap in `title` for the TikTok draft and have the REAL backend checker grade
 * the result, so these assertions exercise the shipped validator rather than a
 * hand-written fixture: the intercepted generate response is re-posted to
 * /api/listing/validate, which runs the same apply_checks() code path.
 */
async function generateWithTitle(page: Page, title: string) {
  await page.route('**/api/listing/generate', async route => {
    const body = await (await route.fetch()).json();
    const drafts = (body?.data?.drafts ?? []).map((d: Record<string, unknown>) =>
      d.id === 'tiktok' ? { ...d, title } : d,
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
  await page.click('#station-fill');
  await page.waitForTimeout(150);
  await page.click('#station-generate');
}

async function generateWithFailedTitle(page: Page) {
  await generateWithTitle(page, FAILED_TITLE);
  // Cards start compact: blocking shows as a one-line badge, not the full gate.
  await page.waitForSelector('[data-testid="blocking-badge"]', { timeout: 25_000 });
}

/** Open the TikTok card's detail view — now the viewport-level inspector's
 * Compliance tab, where the per-rule explanations live. */
async function expandTiktok(page: Page) {
  await page.evaluate(() => {
    const editor = (window as unknown as { editor: any }).editor;
    const shape = editor
      .getCurrentPageShapes()
      .find((s: any) => s.props?.node?.platform === 'tiktok' && s.props?.node?.type === 'listing_result');
    const b = editor.getShapePageBounds(shape.id);
    const vsb = editor.getViewportScreenBounds();
    const z = editor.getCamera().z;
    editor.setCamera(
      { x: (vsb.w - 372) / 2 / z - (b.x + b.w / 2), y: 90 / z - b.y, z },
      { immediate: true },
    );
  });
  await page.waitForTimeout(250);
  await tiktokCard(page).getByTestId('open-details').click();
  await page.waitForSelector('[data-testid="listing-inspector"]', { timeout: 10_000 });
  await page.locator('[data-testid="inspector-tab"][data-tab="compliance"]').click();
  await page.waitForTimeout(300);
}

/** The TikTok *result* card, by platform.
 *
 * Text matching is ambiguous here — the SKU input node lists "TikTok Shop" as a
 * platform checkbox and the Shopify card's 媒体 copy mentions it too, and which
 * one matched first differed between the 1440 and 1280 runs. The card carries
 * an explicit data-platform attribute for exactly this reason. */
function tiktokCard(page: Page) {
  return page.locator('[data-testid="listing-result"][data-platform="tiktok"]');
}

test('TikTok emoji + hashtag + clickbait title is blocked, not silently accepted', async ({
  page,
}, testInfo) => {
  await waitForStation(page);
  await generateWithFailedTitle(page);

  // compact mode keeps blocking visible as a concise red banner
  const badge = page.locator('[data-testid="blocking-badge"]');
  await expect(badge).toBeVisible();
  await expect(badge).toContainText('阻断违规');
  await expect(badge).toContainText('需人工复核');
  await expect(badge).not.toContainText('已发布');

  // and the full gate is one expand away
  await expandTiktok(page);
  const gate = page.locator('[data-testid="inspector-blocking-gate"]');
  await expect(gate).toBeVisible();
  await expect(gate).toContainText('已保留待人工复核');
  await expect(gate).not.toContainText('已发布');

  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-tiktok-01-blocked.png` });
});

test('each violation is shown with its own explanation and suggested correction', async ({
  page,
}) => {
  await waitForStation(page);
  await generateWithFailedTitle(page);

  await expandTiktok(page);
  const card = page.locator('[data-testid="listing-inspector"]');
  await expect(card).toBeVisible();

  // one row per violated rule, each flagged 阻断
  const blockingRows = card.locator('li[data-blocking="1"]');
  await expect(blockingRows).toHaveCount(4);
  for (const label of [
    '标题禁表情符号',
    '标题禁话题标签',
    '标题禁营销用语',
    '标题禁特殊字符',
  ]) {
    await expect(blockingRows.filter({ hasText: label })).toHaveCount(1);
  }

  // explanations name the offending content
  await expect(card).toContainText('标题包含 4 个表情符号');
  await expect(card).toContainText('#travelhacks');
  await expect(card).toContainText('stop carrying');
  await expect(card).toContainText('包含禁用字符');

  // and every violation row carries evidence plus a suggested correction
  for (const row of await blockingRows.all()) {
    await expect(row).toContainText('问题片段：');
    await expect(row).toContainText('改法：');
  }
});

test('the suggested replacement title is clean and leads with the product', async ({ page }) => {
  await waitForStation(page);
  await generateWithFailedTitle(page);

  await expandTiktok(page);
  const suggested = page.locator('[data-testid="inspector-suggested-title"]');
  await expect(suggested).toBeVisible();
  const text = (await suggested.textContent()) ?? '';
  expect(text).toContain('AeroFold Silicone Travel Cup');
  expect(text).toContain('4.5cm'); // the factual attribute survives
  expect(text).not.toContain('#');
  expect(text).not.toContain('🧘');
  expect(text).not.toMatch(/stop carrying/i);
});

test('hashtags are moved into the separate social-caption field', async ({ page }) => {
  await waitForStation(page);
  await generateWithFailedTitle(page);

  const caption = await page.evaluate(() => {
    const editor = (window as unknown as { editor: any }).editor;
    const card = editor
      .getCurrentPageShapes()
      .find((s: any) => s.props?.node?.platform === 'tiktok');
    const fields = card?.props.node.fields ?? [];
    return fields.find((f: any) => f.label === '社交文案')?.value ?? '';
  });
  expect(caption).toBe('#travelhacks #campinggear #ecofriendly #coffeehack');
});

test('a compliant TikTok title produces no blocking gate', async ({ page }, testInfo) => {
  await waitForStation(page);
  await generateWithTitle(
    page,
    'AeroFold Collapsible Silicone Travel Cup, Leak-Proof Lid, 350ml',
  );
  await page.waitForSelector('.NodeShape_station:has-text("TikTok Shop")', { timeout: 25_000 });
  await page.waitForTimeout(500);

  await expect(page.locator('[data-testid="blocking-badge"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="inspector-blocking-gate"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="inspector-suggested-title"]')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-tiktok-02-clean.png` });
});
