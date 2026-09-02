import { expect, test, type Page } from '@playwright/test';

// Evidence ledger + release gate, end to end against the real backend.
//
// Every upload here goes to the running FastAPI instance and is graded by the
// shipped deterministic gate — no fixtures, no model provider. The store is
// content-addressed, so each spec clears the documents it created.

const SHOTS = 'e2e/screenshots';

const SPEC_CSV = 'attribute,value\ncapacity,350 ml\nfolded height,4 cm\n';
const MANUAL_TXT =
  'AeroFold manual (fictional).\nCapacity: 350 ml\nFood-grade silicone body.\n';
const CONFLICT_CSV = 'attribute,value\ncapacity,300 ml\n';

async function waitForStation(page: Page) {
  await page.goto('/');
  await page.waitForSelector('#station-generate', { timeout: 20_000 });
  await page.waitForTimeout(900);
}

/** Remove every stored document so specs cannot see each other's uploads. */
async function clearLedger(page: Page) {
  await page.evaluate(async () => {
    const res = await fetch('/api/evidence/sources');
    const { data } = await res.json();
    for (const s of data.sources ?? []) {
      await fetch(`/api/evidence/sources/${s.source_id}`, { method: 'DELETE' });
    }
  });
}

async function generate(page: Page) {
  await page.click('#station-fill');
  await page.waitForTimeout(150);
  await page.click('#station-generate');
  await page.waitForSelector('[data-testid="listing-result"]', { timeout: 25_000 });
  await page.waitForTimeout(1000);
}

async function openEvidenceTab(page: Page, platform = 'amazon') {
  await page.evaluate(p => {
    const editor = (window as unknown as { editor: any }).editor;
    const shape = editor
      .getCurrentPageShapes()
      .find((s: any) => s.props?.node?.platform === p && s.props?.node?.type === 'listing_result');
    const b = editor.getShapePageBounds(shape.id);
    const vsb = editor.getViewportScreenBounds();
    const z = editor.getCamera().z;
    editor.setCamera(
      { x: (vsb.w - 372) / 2 / z - (b.x + b.w / 2), y: 90 / z - b.y, z },
      { immediate: true },
    );
  }, platform);
  await page.waitForTimeout(200);
  await page
    .locator(`[data-testid="listing-result"][data-platform="${platform}"]`)
    .getByTestId('open-details')
    .click();
  await page.waitForSelector('[data-testid="listing-inspector"]');
  await page.locator('[data-testid="inspector-tab"][data-tab="evidence"]').click();
  await page.waitForSelector('[data-testid="evidence-tab"]');
  await page.waitForTimeout(400);
}

/** Upload through the real multipart endpoint via the page's own fetch. */
async function upload(page: Page, name: string, body: string, expiresOn = '') {
  await page.evaluate(
    async ({ name, body, expiresOn }) => {
      const form = new FormData();
      form.append('file', new File([body], name, { type: 'text/plain' }));
      form.append('expires_on', expiresOn);
      form.append('label', '');
      await fetch('/api/evidence/upload', { method: 'POST', body: form });
    },
    { name, body, expiresOn },
  );
}

test.beforeEach(async ({ page }) => {
  await waitForStation(page);
  await clearLedger(page);
});

test('an unsupported BPA-Free claim is blocked by the evidence gate', async ({
  page,
}, testInfo) => {
  await generate(page);
  await openEvidenceTab(page);

  // the demo SKU asserts BPA-Free and nothing backs it
  const claim = page.locator('[data-testid="evidence-claim"][data-fact="ev-bpa-free"]');
  await expect(claim).toBeVisible();
  await expect(claim).toHaveAttribute('data-verdict', 'blocked');
  await expect(claim).toContainText('缺少任何证据来源');

  // and the Compliance tab shows the evidence axis as a separate verdict
  await page.locator('[data-testid="inspector-tab"][data-tab="compliance"]').click();
  const verdict = page.getByTestId('evidence-verdict');
  await expect(verdict).toHaveAttribute('data-verdict', 'blocked');
  await expect(verdict).toContainText('证据校验');
  await page.screenshot({ path: `${SHOTS}/${testInfo.project.name}-evidence-01-blocked.png` });
});

test('uploading a spec sheet creates needs_review facts, never verified ones', async ({
  page,
}) => {
  await generate(page);
  await upload(page, 'spec.csv', SPEC_CSV);
  await openEvidenceTab(page);

  const facts = page.locator('[data-testid="evidence-fact"]');
  expect(await facts.count()).toBeGreaterThanOrEqual(2);

  // extraction establishes what a document says, not that the claim is true
  const capacity = page.locator('[data-testid="evidence-fact"][data-fact="ev-capacity"]');
  await expect(capacity).toContainText('350 ml');
  await expect(capacity.locator('[data-state]').first()).toHaveAttribute(
    'data-state',
    'needs_review',
  );
  await expect(page.getByTestId('evidence-source')).toHaveCount(1);
  await expect(page.getByTestId('evidence-source')).toContainText('SHA-256');
});

test('confirming a fact unblocks only that claim', async ({ page }, testInfo) => {
  await generate(page);
  await upload(page, 'spec.csv', SPEC_CSV);
  await openEvidenceTab(page);

  await page
    .locator('[data-testid="evidence-fact"][data-fact="ev-capacity"]')
    .getByTestId('verify-fact')
    .click();
  await page.waitForTimeout(700);

  await expect(
    page
      .locator('[data-testid="evidence-fact"][data-fact="ev-capacity"]')
      .locator('[data-state]')
      .first(),
  ).toHaveAttribute('data-state', 'verified');

  // the capacity claim now passes; the unrelated BPA-Free claim still does not
  const capacityClaim = page.locator('[data-testid="evidence-claim"][data-fact="ev-capacity"]');
  if (await capacityClaim.count()) {
    await expect(capacityClaim.first()).toHaveAttribute('data-verdict', 'ok');
  }
  await expect(
    page.locator('[data-testid="evidence-claim"][data-fact="ev-bpa-free"]'),
  ).toHaveAttribute('data-verdict', 'blocked');
  await page.screenshot({ path: `${SHOTS}/${testInfo.project.name}-evidence-02-verified.png` });
});

test('a claim can be expanded to its source document, location and excerpt', async ({ page }) => {
  await generate(page);
  await upload(page, 'spec.csv', SPEC_CSV);
  await openEvidenceTab(page);

  const claim = page.locator('[data-testid="evidence-claim"][data-fact="ev-capacity"]').first();
  await claim.locator('button').first().click();

  const body = claim.getByTestId('claim-evidence');
  await expect(body).toBeVisible();
  await expect(body).toContainText('row ');       // the location inside the CSV
  await expect(body).toContainText('350');        // the excerpt
  await expect(body).toContainText('确定性解析');   // the extraction method
});

test('conflicting sources block the dependent claim', async ({ page }) => {
  await generate(page);
  await upload(page, 'spec.csv', SPEC_CSV);
  await upload(page, 'conflict.csv', CONFLICT_CSV);
  await openEvidenceTab(page);

  await expect(
    page
      .locator('[data-testid="evidence-fact"][data-fact="ev-capacity"]')
      .locator('[data-state]')
      .first(),
  ).toHaveAttribute('data-state', 'conflicting');

  const claim = page.locator('[data-testid="evidence-claim"][data-fact="ev-capacity"]').first();
  if (await claim.count()) {
    await expect(claim).toHaveAttribute('data-verdict', 'blocked');
  }
});

test('expired evidence is rejected for the claims that depend on it', async ({ page }) => {
  await generate(page);
  await upload(page, 'cert.txt', MANUAL_TXT, '2023-01-14');
  await openEvidenceTab(page);

  const material = page.locator(
    '[data-testid="evidence-fact"][data-fact="ev-food-grade-silicone"]',
  );
  await expect(material.locator('[data-state]').first()).toHaveAttribute('data-state', 'expired');
});

test('opening and closing the Evidence tab does not shift the canvas', async ({ page }) => {
  await generate(page);
  await upload(page, 'spec.csv', SPEC_CSV);

  const camera = () =>
    page.evaluate(() => (window as unknown as { editor: any }).editor.getCamera());
  const geometry = () =>
    page.evaluate(() => {
      const editor = (window as unknown as { editor: any }).editor;
      return editor
        .getCurrentPageShapes()
        .filter((s: any) => s.props?.node?.type === 'listing_result')
        .map((s: any) => {
          const b = editor.getShapePageBounds(s.id);
          return { p: s.props.node.platform, x: Math.round(b.x), y: Math.round(b.y), h: Math.round(b.h) };
        })
        .sort((a: any, b: any) => a.y - b.y);
    });

  await openEvidenceTab(page);
  const camBefore = await camera();
  const geoBefore = await geometry();

  // switch across every tab, then close
  for (const t of ['content', 'compliance', 'evidence', 'policy']) {
    await page.locator(`[data-testid="inspector-tab"][data-tab="${t}"]`).click();
    await page.waitForTimeout(150);
  }
  expect(await camera()).toEqual(camBefore);
  expect(await geometry()).toEqual(geoBefore);

  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="listing-inspector"]')).toHaveCount(0);
  expect(await camera()).toEqual(camBefore);
  expect(await geometry()).toEqual(geoBefore);
});
