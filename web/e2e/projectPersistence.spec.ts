import { expect, test, type Page } from '@playwright/test';

// Browser-local project persistence, end to end.
//
// The load-bearing property is that a refresh restores the *exact* graph rather
// than re-running the code that built it: re-running would mint new nodes, new
// revisions and new audit events for work the operator already did.

const SHOTS = 'e2e/screenshots';

function tag(testInfo: { project: { name: string } }) {
  return testInfo.project.name;
}

async function waitForStation(page: Page) {
  await page.goto('/');
  await page.waitForSelector('#station-generate', { timeout: 20_000 });
  await page.waitForTimeout(900);
}

async function generate(page: Page) {
  await page.click('#station-fill');
  await page.waitForTimeout(150);
  await page.click('#station-generate');
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const editor = (window as unknown as { editor: any }).editor;
          return editor
            .getCurrentPageShapes()
            .filter((s: any) => s.props?.node?.type === 'listing_result').length;
        }),
      { timeout: 25_000 },
    )
    .toBe(3);
  await page.waitForTimeout(1500); // let the debounced auto-save land
}

/** Node ids, types and positions — the thing a restore must reproduce exactly. */
async function graph(page: Page) {
  return page.evaluate(() => {
    const editor = (window as unknown as { editor: any }).editor;
    return editor
      .getCurrentPageShapes()
      .filter((s: any) => s.props?.node)
      .map((s: any) => ({
        id: String(s.id),
        type: s.props.node.type,
        x: Math.round(s.x),
        y: Math.round(s.y),
      }))
      .sort((a: any, b: any) => a.id.localeCompare(b.id));
  });
}

async function connections(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as { editor: any }).editor
        .getCurrentPageShapes()
        .filter((s: any) => s.type === 'connection').length,
  );
}

/** The menu panel is portalled to <body>, so it is not inside the chip's wrapper. */
const menu = (page: Page) => page.getByTestId('project-panel');

async function openMenu(page: Page) {
  await page.getByTestId('project-save-state').click();
  await expect(menu(page)).toBeVisible();
  await expect(page.getByTestId('project-export')).toBeVisible();
}

// --------------------------------------------------------------------------- //

test('a refresh restores the exact graph without regenerating it', async ({ page }, testInfo) => {
  await waitForStation(page);
  await generate(page);

  const before = await graph(page);
  const linksBefore = await connections(page);
  expect(before.length).toBeGreaterThan(3);
  await expect(page.getByTestId('project-save-state')).toHaveAttribute('data-state', 'saved');

  await page.reload();
  await page.waitForSelector('#station-generate', { timeout: 20_000 });
  await page.waitForTimeout(1200);

  // same ids, same types, same positions — not a fresh generation
  expect(await graph(page)).toEqual(before);
  expect(await connections(page)).toBe(linksBefore);
  await expect(page.getByTestId('project-save-state')).toBeVisible();

  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-project-01-restored.png` });
});

test('a refresh does not create a second SKU node', async ({ page }) => {
  await waitForStation(page);
  await page.waitForTimeout(1500);
  const before = (await graph(page)).filter(n => n.type === 'sku_listing');
  expect(before).toHaveLength(1);

  await page.reload();
  await page.waitForSelector('#station-generate', { timeout: 20_000 });
  await page.waitForTimeout(1200);

  const after = (await graph(page)).filter(n => n.type === 'sku_listing');
  expect(after).toHaveLength(1);
  expect(after[0].id).toBe(before[0].id);
});

test('a refresh does not create duplicate listing revisions', async ({ page }) => {
  await waitForStation(page);
  await generate(page);

  // register revision 1 by opening the review tab
  await page.evaluate(() => {
    const editor = (window as unknown as { editor: any }).editor;
    const shape = editor
      .getCurrentPageShapes()
      .find((s: any) => s.props?.node?.platform === 'amazon' && s.props?.node?.type === 'listing_result');
    const b = editor.getShapePageBounds(shape.id);
    const vsb = editor.getViewportScreenBounds();
    const z = editor.getCamera().z;
    editor.setCamera(
      { x: (vsb.w - 372) / 2 / z - (b.x + b.w / 2), y: 90 / z - b.y, z },
      { immediate: true },
    );
  });
  await page.waitForTimeout(250);
  await page
    .locator('[data-testid="listing-result"][data-platform="amazon"]')
    .getByTestId('open-details')
    .click();
  await page.locator('[data-testid="inspector-tab"][data-tab="review"]').click();
  await expect(page.getByTestId('review-tab')).toBeVisible({ timeout: 15_000 });
  const revisionId = await page.getByTestId('review-revision-id').textContent();
  await expect(page.getByTestId('review-history').locator('li')).toHaveCount(1);
  await page.getByTestId('inspector-close').click();
  await page.waitForTimeout(1200);

  await page.reload();
  await page.waitForSelector('#station-generate', { timeout: 20_000 });
  await page.waitForTimeout(1200);

  await page.evaluate(() => {
    const editor = (window as unknown as { editor: any }).editor;
    const shape = editor
      .getCurrentPageShapes()
      .find((s: any) => s.props?.node?.platform === 'amazon' && s.props?.node?.type === 'listing_result');
    const b = editor.getShapePageBounds(shape.id);
    const vsb = editor.getViewportScreenBounds();
    const z = editor.getCamera().z;
    editor.setCamera(
      { x: (vsb.w - 372) / 2 / z - (b.x + b.w / 2), y: 90 / z - b.y, z },
      { immediate: true },
    );
  });
  await page.waitForTimeout(250);
  await page
    .locator('[data-testid="listing-result"][data-platform="amazon"]')
    .getByTestId('open-details')
    .click();
  await page.locator('[data-testid="inspector-tab"][data-tab="review"]').click();
  await expect(page.getByTestId('review-tab')).toBeVisible({ timeout: 15_000 });

  // the same revision, and still only one of it
  await expect(page.getByTestId('review-revision-id')).toHaveText(revisionId!);
  await expect(page.getByTestId('review-history').locator('li')).toHaveCount(1);
});

test('opening and closing panels never moves a node', async ({ page }) => {
  await waitForStation(page);
  await generate(page);
  const before = await graph(page);

  // Agent panel: toggle it both ways. It starts collapsed at 1280 and open at
  // 1440, so the spec must not assume which control is on screen first.
  const collapse = page.getByRole('button', { name: '收起 Agent 面板' });
  const expand = page.getByRole('button', { name: '展开 Agent 面板' });
  const startedOpen = await collapse.isVisible();
  await (startedOpen ? collapse : expand).click();
  await page.waitForTimeout(400);
  await (startedOpen ? expand : collapse).click();
  await page.waitForTimeout(400);
  // detail inspector
  await page.evaluate(() => {
    const editor = (window as unknown as { editor: any }).editor;
    const shape = editor
      .getCurrentPageShapes()
      .find((s: any) => s.props?.node?.platform === 'amazon' && s.props?.node?.type === 'listing_result');
    const b = editor.getShapePageBounds(shape.id);
    const vsb = editor.getViewportScreenBounds();
    const z = editor.getCamera().z;
    editor.setCamera(
      { x: (vsb.w - 372) / 2 / z - (b.x + b.w / 2), y: 90 / z - b.y, z },
      { immediate: true },
    );
  });
  await page.waitForTimeout(250);
  await page
    .locator('[data-testid="listing-result"][data-platform="amazon"]')
    .getByTestId('open-details')
    .click();
  await expect(page.getByTestId('listing-inspector')).toBeVisible();
  await page.getByTestId('inspector-close').click();
  await page.waitForTimeout(1400);

  expect(await graph(page)).toEqual(before);

  // and the positions that got saved are the same ones
  await page.reload();
  await page.waitForSelector('#station-generate', { timeout: 20_000 });
  await page.waitForTimeout(1200);
  expect(await graph(page)).toEqual(before);
});

test('the save state is visible and labelled as browser-local', async ({ page }, testInfo) => {
  await waitForStation(page);
  await page.waitForTimeout(1500);
  await expect(page.getByTestId('project-save-state')).toContainText('已保存');
  await expect(page.getByTestId('project-save-state')).toContainText('本地');

  await openMenu(page);
  await expect(menu(page)).toContainText('这台浏览器的本地存储');
  await expect(menu(page)).toContainText('不含任何密钥');
  await expect(page.getByTestId('project-saved-at')).toBeVisible();

  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-project-02-menu.png` });
});

test('exporting produces a project file that imports back', async ({ page }) => {
  await waitForStation(page);
  await generate(page);
  const before = await graph(page);

  await openMenu(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('project-export').click(),
  ]);
  const path = await download.path();
  expect(path).toBeTruthy();

  const fs = await import('node:fs/promises');
  const text = await fs.readFile(path!, 'utf-8');
  const parsed = JSON.parse(text);
  expect(parsed.schema).toBe('listing-project');
  expect(parsed.storage).toBe('browser-local');
  // no credential-shaped field anywhere in an exported project
  expect(text.toLowerCase()).not.toContain('api_key');
  expect(text.toLowerCase()).not.toContain('authorization');

  // clear the canvas, then import the file back
  await page.getByTestId('project-new').click();
  await page.getByTestId('project-new-confirm-yes').click();
  await page.waitForTimeout(600);
  expect((await graph(page)).length).toBeLessThan(before.length);

  await openMenu(page);
  await page.getByTestId('project-file').setInputFiles(path!);
  await expect(page.getByTestId('project-import-preview')).toBeVisible();
  await page.getByTestId('project-import-confirm').click();
  await page.waitForTimeout(800);

  expect(await graph(page)).toEqual(before);
});

test('an import previews its effect and can be cancelled', async ({ page }, testInfo) => {
  await waitForStation(page);
  await generate(page);
  const before = await graph(page);

  await openMenu(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('project-export').click(),
  ]);
  const path = await download.path();

  await page.getByTestId('project-file').setInputFiles(path!);
  const preview = page.getByTestId('project-import-preview');
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('节点');
  await expect(preview).toContainText('整个替换');
  await expect(preview).toContainText('不支持合并两个项目');
  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-project-03-import.png` });

  await page.getByTestId('project-import-cancel').click();
  await expect(preview).toHaveCount(0);
  expect(await graph(page)).toEqual(before);
});

test('a project file from a newer build is refused with a clear reason', async ({ page }) => {
  await waitForStation(page);
  await openMenu(page);

  await page.getByTestId('project-file').setInputFiles({
    name: 'future.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        schema: 'listing-project',
        schema_version: 99,
        canvas: { store: {} },
      }),
    ),
  });

  const problems = page.getByTestId('project-import-problems');
  await expect(problems).toBeVisible();
  await expect(problems).toContainText('更新的版本');
  await expect(page.getByTestId('project-import-preview')).toHaveCount(0);
});

test('a project file containing a credential is refused outright', async ({ page }) => {
  await waitForStation(page);
  await openMenu(page);

  await page.getByTestId('project-file').setInputFiles({
    name: 'leaky.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        schema: 'listing-project',
        schema_version: 1,
        canvas: { store: { store: {}, schema: {} } },
        provider: { api_key: 'sk-should-never-import' },
      }),
    ),
  });

  const problems = page.getByTestId('project-import-problems');
  await expect(problems).toBeVisible();
  await expect(problems).toContainText('凭证');
  await expect(page.getByTestId('project-import-preview')).toHaveCount(0);
});

test('clearing local storage needs a confirmation and says what it destroys', async ({ page }) => {
  await waitForStation(page);
  await page.waitForTimeout(1500);
  await openMenu(page);

  await page.getByTestId('project-clear').click();
  const confirm = page.getByTestId('project-clear-confirm');
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('备份');
  await expect(confirm).toContainText('无法撤销');

  await page.getByTestId('project-clear-confirm-yes').click();
  await expect(page.getByTestId('project-message')).toContainText('已清除');
});

test('a corrupt current slot is recovered from the backup', async ({ page }) => {
  await waitForStation(page);
  await generate(page);
  const before = await graph(page);

  // a second save promotes the good snapshot into the backup slot
  await openMenu(page);
  await page.getByTestId('project-save-now').click();
  await page.waitForTimeout(300);

  await page.evaluate(() => localStorage.setItem('listing.project.v1.current', '{ corrupt'));
  await page.reload();
  await page.waitForSelector('#station-generate', { timeout: 20_000 });
  await page.waitForTimeout(1200);

  await expect(page.getByTestId('project-save-state')).toHaveAttribute('data-state', 'recovered');
  expect(await graph(page)).toEqual(before);
});
