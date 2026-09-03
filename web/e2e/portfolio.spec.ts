import { expect, test, type Page } from '@playwright/test';

// Batch migration centre, end to end against the real backend.
// Deterministic throughout: no model provider, no marketplace publishing.

const SHOTS = 'e2e/screenshots';

const PORTFOLIO_CSV = [
  'sku,product_name,selling_points,platforms',
  'AERO-350,AeroFold Travel Cup,Folds to 4cm|Leak-proof lid 350ml,amazon;tiktok;shopify',
  'AERO-500,AeroFold Travel Bottle,Folds to 5cm|Leak-proof lid 500ml,amazon;shopify',
  'AERO-LEGACY,Cup Cup Cup Ultra! Mega$ Cup,Folds flat|350ml,amazon',
  'BAD-ROW,,,amazon',
  ',Nameless Cup,points,amazon',
].join('\n');

async function openPortfolio(page: Page) {
  await page.goto('/');
  await page.waitForSelector('#station-generate', { timeout: 20_000 });
  await page.click('#station-portfolio');
  await page.waitForSelector('#portfolio-panel');
}

/** Upload the portfolio through the real file input. */
async function importCsv(page: Page, csv = PORTFOLIO_CSV) {
  await page.setInputFiles('#portfolio-import', {
    name: 'portfolio.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv, 'utf-8'),
  });
  await page.waitForSelector('[data-testid="import-report"]', { timeout: 15_000 });
}

async function analyze(page: Page) {
  await page.click('#portfolio-analyze');
  await page.waitForSelector('#portfolio-matrix', { timeout: 30_000 });
}

async function stat(page: Page, label: string): Promise<number> {
  const text = await page
    .locator(`[data-testid="portfolio-stat"][data-label="${label}"] b`)
    .textContent();
  return Number(text ?? '0');
}

test('import reports invalid rows without losing the valid ones', async ({ page }, testInfo) => {
  await openPortfolio(page);
  await importCsv(page);

  const report = page.getByTestId('import-report');
  await expect(report).toContainText('导入');
  // 3 good rows survive; the 2 malformed ones are reported individually
  await expect(report).toContainText('共 5 行');
  const errors = page.getByTestId('import-error');
  await expect(errors).toHaveCount(2);
  await expect(errors.first()).toContainText('第 ');
  await page.screenshot({ path: `${SHOTS}/${testInfo.project.name}-portfolio-01-import.png` });
});

test('a policy change produces the correct portfolio blast radius', async ({ page }, testInfo) => {
  await openPortfolio(page);
  await importCsv(page);
  await analyze(page);

  expect(await stat(page, '扫描 SKU')).toBe(3);
  expect(await stat(page, '受影响')).toBe(1);
  expect(await stat(page, '未受影响')).toBe(2);
  expect(await stat(page, '可安全修补')).toBe(1);

  // the matrix names the offending SKU / platform / field
  const affected = page.locator('[data-testid="matrix-row"][data-status="safe_patch"]');
  await expect(affected).toHaveCount(1);
  await expect(affected).toContainText('AERO-LEGACY');
  await expect(affected).toContainText('amazon');
  await expect(affected).toContainText('title');
  await page.screenshot({ path: `${SHOTS}/${testInfo.project.name}-portfolio-02-matrix.png` });
});

test('the matrix can be filtered by status and by SKU', async ({ page }) => {
  await openPortfolio(page);
  await importCsv(page);
  await analyze(page);

  const rows = page.locator('[data-testid="matrix-row"]');
  const total = await rows.count();
  expect(total).toBeGreaterThan(3);

  await page.selectOption('#portfolio-filter-status', 'safe_patch');
  await expect(rows).toHaveCount(1);

  await page.selectOption('#portfolio-filter-status', 'all');
  await page.fill('#portfolio-filter-sku', 'AERO-500');
  const filtered = await rows.count();
  expect(filtered).toBeGreaterThan(0);
  expect(filtered).toBeLessThan(total);
  for (const r of await rows.all()) await expect(r).toContainText('AERO-500');
});

test('safe patches apply in bulk and only touch the affected SKU', async ({ page }, testInfo) => {
  await openPortfolio(page);
  await importCsv(page);
  await analyze(page);

  await page.click('#portfolio-apply-safe');
  await page.waitForSelector('[data-testid="apply-result"]', { timeout: 30_000 });

  const result = page.getByTestId('apply-result');
  await expect(result).toContainText('AERO-LEGACY');
  await expect(page.locator('#portfolio-status')).toContainText('已应用');
  await expect(page.locator('[data-testid="matrix-row"][data-status="applied"]')).toHaveCount(1);
  await page.screenshot({ path: `${SHOTS}/${testInfo.project.name}-portfolio-03-applied.png` });
});

test('review-required patches are held back from bulk approval', async ({ page }) => {
  await openPortfolio(page);
  await importCsv(page);
  // the SKU-fact drift produces review-required rows the safe path must not take
  await page.check('#portfolio-drift');
  await analyze(page);

  expect(await stat(page, '需人工')).toBeGreaterThan(0);
  const notice = page.getByTestId('review-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('不会被批量批准应用');

  // the bulk button offers only the safe count, never the review rows
  const label = await page.locator('#portfolio-apply-safe').textContent();
  const offered = Number(/(\d+)/.exec(label ?? '')?.[1] ?? '0');
  expect(offered).toBe(await stat(page, '可安全修补'));
});

test('an individual SKU and the whole batch can both be rolled back', async ({ page }) => {
  await openPortfolio(page);
  await importCsv(page);
  await analyze(page);
  await page.click('#portfolio-apply-safe');
  await page.waitForSelector('[data-testid="apply-result"]');

  await page.locator('[data-testid="rollback-one"][data-sku="AERO-LEGACY"]').click();
  await expect(page.locator('#portfolio-status')).toContainText('已回滚');
  await expect(
    page.locator('[data-testid="matrix-row"][data-status="rolled_back"]').filter({ hasText: 'AERO-LEGACY' }),
  ).toHaveCount(1);

  // Re-run and apply a fresh migration before testing the batch rollback. A
  // rollback button must not be enabled for a candidate that was never applied.
  await page.click('#portfolio-analyze');
  await page.waitForSelector('#portfolio-matrix');
  await page.click('#portfolio-apply-safe');
  await page.waitForSelector('[data-testid="apply-result"]');
  await page.click('#portfolio-rollback-batch');
  await expect(page.locator('#portfolio-status')).toContainText('已回滚');
  await expect(page.locator('[data-testid="matrix-row"][data-status="applied"]')).toHaveCount(0);
});

test('the audit report downloads as JSON', async ({ page }) => {
  await openPortfolio(page);
  await importCsv(page);
  await analyze(page);

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 20_000 }),
    page.click('#portfolio-report'),
  ]);
  expect(download.suggestedFilename()).toMatch(/^portfolio-migration-.*\.json$/);
});

test('the panel never overflows horizontally at either width', async ({ page }) => {
  await openPortfolio(page);
  await importCsv(page);
  await analyze(page);

  const overflow = await page.evaluate(() => {
    const panel = document.querySelector('#portfolio-panel aside') as HTMLElement;
    return {
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      panel: panel.scrollWidth - panel.clientWidth,
    };
  });
  expect(overflow.page).toBeLessThanOrEqual(1);
  expect(overflow.panel).toBeLessThanOrEqual(1);
});
