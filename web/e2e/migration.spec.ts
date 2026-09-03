import { expect, test, type Page } from '@playwright/test';

// Self-healing Listing CI/CD — 规则变更 / 迁移 workflow.
// Runs against the production-like build served by FastAPI (no model key, so
// /api/listing/generate returns deterministic fallback drafts that already
// carry factRefs / policyVersion, and every /api/migration/* call is
// deterministic backend logic — no provider is ever contacted).

const SHOTS = 'e2e/screenshots';

async function waitForStation(page: Page) {
  await page.goto('/');
  await page.waitForSelector('#station-generate', { timeout: 20_000 });
  await page.waitForTimeout(900);
}

function tag(testInfo: { project: { name: string } }) {
  return testInfo.project.name;
}

type CardInfo = {
  platform: string;
  title: string;
  status: string;
  x: number;
  y: number;
  fields: { label: string; value: string }[];
};

async function readCards(page: Page): Promise<CardInfo[]> {
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
      .map((s: any) => ({
        platform: s.props.node.platform,
        title: s.props.node.title,
        status: s.props.node.migrationStatus,
        x: s.x,
        y: s.y,
        fields: s.props.node.fields,
      }));
  });
}

async function skuPoints(page: Page): Promise<string> {
  return page.evaluate(() => {
    const editor = (window as unknown as { editor: any }).editor;
    const sku = editor
      .getCurrentPageShapes()
      .find((s: any) => s.props?.node?.type === 'sku_listing');
    return sku?.props.node.points ?? '';
  });
}

async function camera(page: Page) {
  return page.evaluate(() => (window as unknown as { editor: any }).editor.getCamera());
}

/** `已过期` / `已应用` etc. appear both on canvas banners and in the panel;
 * canvas-only assertions scope to the tldraw container. */
function canvasText(page: Page, text: string) {
  return page.locator('.station-tldraw').getByText(text);
}

async function openMigration(page: Page) {
  await page.click('#station-migration');
  await page.waitForSelector('#migration-panel', { timeout: 10_000 });
}

async function startPolicyDemo(page: Page) {
  await openMigration(page);
  await page.click('#migration-demo-policy');
  await page.waitForSelector('#migration-policy-card', { timeout: 25_000 });
}

async function runPolicyImpact(page: Page) {
  await startPolicyDemo(page);
  await page.click('#migration-run-impact');
  await page.waitForSelector('#migration-impact', { timeout: 25_000 });
}

// --------------------------------------------------------------------------- //

test('P0.A Amazon policy impact marks only the Amazon card 已过期', async ({ page }, testInfo) => {
  await waitForStation(page);
  await runPolicyImpact(page);

  const cards = await readCards(page);
  const stale = cards.filter(c => c.status === 'stale').map(c => c.platform);
  expect(stale).toEqual(['amazon']);
  expect(cards.filter(c => c.platform !== 'amazon').every(c => c.status === 'current')).toBe(true);

  await expect(canvasText(page, '已过期')).toHaveCount(1);

  const affected = page.locator('[data-testid="mig-affected-row"]');
  await expect(affected).toHaveCount(1);
  await expect(affected.first()).toHaveAttribute('data-artifact', 'amazon');
  await expect(page.locator('[data-testid="mig-unaffected-row"]')).toHaveCount(2);

  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-mig-01-policy-impact.png` });
});

test('P0.B rule source, versions and effective dates are visible', async ({ page }) => {
  await waitForStation(page);
  await startPolicyDemo(page);

  const card = page.locator('#migration-policy-card');
  await expect(card).toContainText('amazon-us-pre-2025.01.21');
  await expect(card).toContainText('amazon-us-2025.01.21');
  await expect(card).toContainText('2025-01-20');
  await expect(card).toContainText('2025-01-21');

  const link = card.locator('a').first();
  await expect(link).toHaveAttribute('href', /^https:\/\/sellercentral\.amazon\.com\/.+/);

  // the diff shows the real enforcement change and the two added rules
  await expect(card).toContainText('amazon.title.max_length');
  await expect(card).toContainText('amazon.title.prohibited_chars');
  await expect(card).toContainText('amazon.title.repeated_word_limit');
});

test('P0.F candidate diff appears without changing the current title', async ({ page }) => {
  await waitForStation(page);
  await runPolicyImpact(page);

  const amazonBefore = (await readCards(page)).find(c => c.platform === 'amazon')!.title;

  await page.click('#migration-build-candidate');
  await page.waitForSelector('#migration-candidates', { timeout: 25_000 });

  const patch = page.locator('[data-testid="mig-patch"]').first();
  await expect(patch).toContainText('原：');
  await expect(patch).toContainText('新：');
  await expect(patch).toContainText(amazonBefore.slice(0, 20));

  // the live Amazon card title is still the pre-candidate value
  const amazonMid = (await readCards(page)).find(c => c.platform === 'amazon')!.title;
  expect(amazonMid).toBe(amazonBefore);
});

test('P0.G applying a candidate changes only the approved field', async ({ page }, testInfo) => {
  await waitForStation(page);
  await runPolicyImpact(page);

  const before = await readCards(page);
  await page.click('#migration-build-candidate');
  await page.waitForSelector('#migration-candidates', { timeout: 25_000 });
  await page.click('#migration-apply');
  await page.waitForSelector('#migration-applied', { timeout: 25_000 });

  const after = await readCards(page);
  const amzB = before.find(c => c.platform === 'amazon')!;
  const amzA = after.find(c => c.platform === 'amazon')!;

  expect(amzA.title).not.toBe(amzB.title);
  expect(amzA.title).not.toContain('!');
  expect((amzA.title.toLowerCase().match(/cup/g) ?? []).length).toBeLessThanOrEqual(2);
  expect(amzA.fields).toEqual(amzB.fields); // bullets untouched
  expect(amzA.status).toBe('applied');

  for (const p of ['tiktok', 'shopify']) {
    expect(after.find(c => c.platform === p)).toEqual(before.find(c => c.platform === p));
  }
  await expect(canvasText(page, '已应用')).toHaveCount(1);
  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-mig-02-applied.png` });
});

test('P0.H rollback restores the exact previous title', async ({ page }) => {
  await waitForStation(page);
  await runPolicyImpact(page);

  const amazonBefore = (await readCards(page)).find(c => c.platform === 'amazon')!.title;

  await page.click('#migration-build-candidate');
  await page.waitForSelector('#migration-candidates', { timeout: 25_000 });
  await page.click('#migration-apply');
  await page.waitForSelector('#migration-applied', { timeout: 25_000 });
  expect((await readCards(page)).find(c => c.platform === 'amazon')!.title).not.toBe(amazonBefore);

  await page.click('#migration-rollback');
  await page.waitForSelector('#migration-rolledback', { timeout: 25_000 });

  const amazonRolled = (await readCards(page)).find(c => c.platform === 'amazon')!.title;
  expect(amazonRolled).toBe(amazonBefore);
});

test('P1.6 changing 350ml → 300ml marks the capacity-dependent cards 已过期', async ({
  page,
}, testInfo) => {
  await waitForStation(page);
  await openMigration(page);
  await page.click('#migration-demo-sku');
  await page.waitForSelector('#migration-fact-card', { timeout: 25_000 });

  await expect(page.locator('#migration-fact-card')).toContainText('350ml');
  await expect(page.locator('#migration-fact-card')).toContainText('300ml');

  await page.click('#migration-run-impact');
  await page.waitForSelector('#migration-impact', { timeout: 25_000 });

  const stale = (await readCards(page))
    .filter(c => c.status === 'stale')
    .map(c => c.platform)
    .sort();
  expect(stale).toEqual(['amazon', 'shopify', 'tiktok']);
  await expect(canvasText(page, '已过期')).toHaveCount(3);

  const points = await skuPoints(page);
  expect(points).toContain('300ml');
  expect(points).not.toContain('350ml');

  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-mig-03-sku-drift.png` });
});

test('P1.7 unaffected cards keep their values and positions', async ({ page }) => {
  await waitForStation(page);
  await startPolicyDemo(page);
  const before = await readCards(page);

  await page.click('#migration-run-impact');
  await page.waitForSelector('#migration-impact', { timeout: 25_000 });
  await page.waitForTimeout(300);
  const after = await readCards(page);

  for (const p of ['tiktok', 'shopify']) {
    const b = before.find(c => c.platform === p)!;
    const a = after.find(c => c.platform === p)!;
    expect({ title: a.title, x: a.x, y: a.y, status: a.status, fields: a.fields }).toEqual({
      title: b.title,
      x: b.x,
      y: b.y,
      status: b.status,
      fields: b.fields,
    });
  }
});

test('P1.8 the migration workflow never moves the camera; the Agent toggle never moves it either', async ({
  page,
}) => {
  await waitForStation(page);
  await startPolicyDemo(page); // spawns the cards + frames them once
  await page.waitForTimeout(600); // let the one-time auto-frame animation settle

  const settled = await camera(page);
  // impact -> candidate -> apply must not re-frame the canvas on their own
  await page.click('#migration-run-impact');
  await page.waitForSelector('#migration-impact', { timeout: 25_000 });
  expect(await camera(page)).toEqual(settled);

  await page.click('#migration-build-candidate');
  await page.waitForSelector('#migration-candidates', { timeout: 25_000 });
  expect(await camera(page)).toEqual(settled);

  await page.click('#migration-apply');
  await page.waitForSelector('#migration-applied', { timeout: 25_000 });
  expect(await camera(page)).toEqual(settled);

  // and once the modal panel is closed, collapsing the Agent still leaves it put
  await page.locator('#migration-panel').getByRole('button', { name: '关闭' }).click();
  await expect(page.locator('#migration-panel')).toHaveCount(0);
  const beforeToggle = await camera(page);
  const collapse = page.getByRole('button', { name: '收起 Agent 面板' });
  const expand = page.getByRole('button', { name: '展开 Agent 面板' });
  if (await collapse.isVisible().catch(() => false)) await collapse.click();
  else await expand.click();
  await page.waitForTimeout(350);
  expect(await camera(page)).toEqual(beforeToggle);
});

test('P1.9 closing the panel clears the stale stamps and leaves the workflow usable', async ({
  page,
}) => {
  await waitForStation(page);
  await runPolicyImpact(page);
  await expect(canvasText(page, '已过期')).toHaveCount(1);

  await page.locator('#migration-panel').getByRole('button', { name: '关闭' }).click();
  await expect(page.locator('#migration-panel')).toHaveCount(0);
  await expect(canvasText(page, '已过期')).toHaveCount(0);

  // workflow still intact: cards remain, SKU generate button is usable again
  expect((await readCards(page)).map(c => c.platform).sort()).toEqual([
    'amazon',
    'shopify',
    'tiktok',
  ]);
  await page.click('#station-focus-input');
  await expect(page.locator('#station-generate')).toBeEnabled();
});
