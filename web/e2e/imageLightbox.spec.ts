import { expect, test, type Page } from '@playwright/test';

// Node-panel terminology + the shared original-image lightbox.
// Runs against the production-like build at both desktop widths.

const SHOTS = 'e2e/screenshots';

async function waitForStation(page: Page) {
  await page.goto('/');
  await page.waitForSelector('#station-generate', { timeout: 20_000 });
  await page.waitForTimeout(900);
}

async function generate(page: Page) {
  await page.click('#station-fill');
  await page.waitForTimeout(150);
  await page.click('#station-generate');
  await page.waitForSelector('[data-testid="listing-result"]', { timeout: 25_000 });
  await page.waitForTimeout(1000);
}

/** Open the listing-details inspector on one platform's Content tab. */
async function openContentTab(page: Page, platform = 'amazon') {
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
}

const lightbox = (page: Page) => page.locator('[data-testid="image-lightbox"]');
const inspector = (page: Page) => page.locator('[data-testid="listing-inspector"]');

async function camera(page: Page) {
  return page.evaluate(() => (window as unknown as { editor: any }).editor.getCamera());
}

// --------------------------------------------------------------------------- //
// 1 + 2. terminology and the new icon                                         //
// --------------------------------------------------------------------------- //

test('the node panel uses the new hierarchy and no longer says 工位', async ({ page }, testInfo) => {
  await waitForStation(page);
  await page.getByTitle('添加节点').click();

  const menu = page.locator('section[aria-label="添加节点"]');
  await expect(menu).toBeVisible();
  await expect(menu).toContainText('内容生成');
  await expect(menu).toContainText('业务节点');
  await expect(menu).not.toContainText('创作节点');

  // 工位 must not appear anywhere the user can read it, in any panel
  for (const title of ['添加节点', '功能说明', '联系方式']) {
    await page.getByTitle(title).click();
    await page.waitForTimeout(120);
  }
  const bodyText = await page.locator('body').innerText();
  expect(bodyText).not.toContain('工位');
  await page.screenshot({ path: `${SHOTS}/${testInfo.project.name}-panel-01-terminology.png` });
});

test('the 上架编译器 entry has an icon matching the image and video entries', async ({ page }) => {
  await waitForStation(page);
  await page.getByTitle('添加节点').click();

  const entry = page.locator('section[aria-label="添加节点"] button', {
    hasText: '上架编译器',
  });
  const svg = entry.locator('svg');
  await expect(svg).toHaveCount(1);

  // same 18×18 box and stroke weight as the other two entries
  const box = await svg.boundingBox();
  expect(Math.round(box!.width)).toBe(18);
  expect(Math.round(box!.height)).toBe(18);

  const imageSvg = page
    .locator('section[aria-label="添加节点"] button', { hasText: '图片' })
    .locator('svg');
  const imageBox = await imageSvg.boundingBox();
  expect(Math.round(box!.width)).toBe(Math.round(imageBox!.width));

  // the icon sits to the LEFT of the label and shares its colour
  const label = entry.locator('span');
  const labelBox = await label.boundingBox();
  expect(box!.x).toBeLessThan(labelBox!.x);
  expect(await svg.evaluate(el => getComputedStyle(el).color)).toBe(
    await imageSvg.evaluate(el => getComputedStyle(el).color),
  );
});

// --------------------------------------------------------------------------- //
// 3 + 4. opening the lightbox from the main image                             //
// --------------------------------------------------------------------------- //

test('查看原图 opens the lightbox with the image original src', async ({ page }, testInfo) => {
  await waitForStation(page);
  await generate(page);
  await openContentTab(page);

  const img = inspector(page).locator('img').first();
  const src = await img.getAttribute('src');
  expect(src).toBeTruthy();

  await img.hover();
  const button = page.getByTestId('view-original');
  await expect(button).toBeVisible();
  await expect(button).toContainText('查看原图');
  await button.click();

  await expect(lightbox(page)).toBeVisible();
  // the ORIGINAL source, not a thumbnail or a re-encoded copy
  await expect(page.getByTestId('lightbox-image')).toHaveAttribute('src', src!);
  await expect(lightbox(page)).toHaveAttribute('aria-modal', 'true');
  await page.screenshot({ path: `${SHOTS}/${testInfo.project.name}-lightbox-01-open.png` });
});

test('double-clicking the main image opens the same lightbox', async ({ page }) => {
  await waitForStation(page);
  await generate(page);
  await openContentTab(page);

  const img = inspector(page).locator('img').first();
  const src = await img.getAttribute('src');
  await img.dblclick();

  await expect(lightbox(page)).toBeVisible();
  await expect(page.getByTestId('lightbox-image')).toHaveAttribute('src', src!);
});

// --------------------------------------------------------------------------- //
// closing behaviour                                                            //
// --------------------------------------------------------------------------- //

test('close button, Escape and backdrop all close it; the image itself does not', async ({
  page,
}) => {
  await waitForStation(page);
  await generate(page);
  await openContentTab(page);
  const img = inspector(page).locator('img').first();

  // clicking the image itself must NOT close the lightbox
  await img.dblclick();
  await expect(lightbox(page)).toBeVisible();
  await page.getByTestId('lightbox-image').click({ position: { x: 10, y: 10 } });
  await expect(lightbox(page)).toBeVisible();

  // backdrop
  await lightbox(page).click({ position: { x: 6, y: 6 } });
  await expect(lightbox(page)).toHaveCount(0);

  // close button
  await img.dblclick();
  await page.getByTestId('lightbox-close').click();
  await expect(lightbox(page)).toHaveCount(0);

  // Escape closes the LIGHTBOX first, leaving the details modal open
  await img.dblclick();
  await expect(lightbox(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(lightbox(page)).toHaveCount(0);
  await expect(inspector(page)).toBeVisible();
});

test('background scrolling is locked while open and restored on close', async ({ page }) => {
  await waitForStation(page);
  await generate(page);
  await openContentTab(page);
  const img = inspector(page).locator('img').first();

  const overflow = () => page.evaluate(() => getComputedStyle(document.body).overflow);
  const before = await overflow();

  await img.dblclick();
  await expect(lightbox(page)).toBeVisible();
  expect(await overflow()).toBe('hidden');

  await page.keyboard.press('Escape');
  await expect(lightbox(page)).toHaveCount(0);
  expect(await overflow()).toBe(before);
});

test('focus moves into the lightbox and returns to the trigger on close', async ({ page }) => {
  await waitForStation(page);
  await generate(page);
  await openContentTab(page);

  await inspector(page).locator('img').first().hover();
  const trigger = page.getByTestId('view-original');
  await trigger.click();

  await expect(page.getByTestId('lightbox-close')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(lightbox(page)).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

// --------------------------------------------------------------------------- //
// aspect ratios, canvas isolation, layout                                     //
// --------------------------------------------------------------------------- //

test('square, portrait and landscape images are shown whole via contain', async ({
  page,
}, testInfo) => {
  const vw = testInfo.project.use.viewport!.width;
  const vh = testInfo.project.use.viewport!.height;
  await waitForStation(page);
  await generate(page);
  await openContentTab(page);

  for (const [w, h] of [
    [600, 600],
    [400, 1200],
    [1600, 500],
  ]) {
    // swap the card's image for one of a known aspect ratio
    await page.evaluate(
      ({ w, h }) => {
        const editor = (window as unknown as { editor: any }).editor;
        const shape = editor
          .getCurrentPageShapes()
          .find((s: any) => s.props?.node?.platform === 'amazon');
        const url =
          'data:image/svg+xml;charset=utf-8,' +
          encodeURIComponent(
            `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="%23d8a63f"/></svg>`,
          );
        editor.updateShape({
          id: shape.id,
          type: shape.type,
          props: { node: { ...shape.props.node, imageUrl: url } },
        });
      },
      { w, h },
    );
    await page.waitForTimeout(250);

    await inspector(page).locator('img').first().dblclick();
    const media = page.getByTestId('lightbox-image');
    await expect(media).toBeVisible();

    const info = await media.evaluate((el: HTMLImageElement) => ({
      fit: getComputedStyle(el).objectFit,
      w: el.getBoundingClientRect().width,
      h: el.getBoundingClientRect().height,
      naturalW: el.naturalWidth,
      naturalH: el.naturalHeight,
    }));
    expect(info.fit).toBe('contain');
    // shown whole and never stretched: rendered ratio matches the natural one
    const rendered = info.w / info.h;
    const natural = info.naturalW / info.naturalH;
    expect(Math.abs(rendered - natural)).toBeLessThan(0.05);
    // and it fits inside the 90vw × 90vh envelope
    expect(info.w).toBeLessThanOrEqual(vw * 0.9 + 1);
    expect(info.h).toBeLessThanOrEqual(vh * 0.9 + 1);

    await page.keyboard.press('Escape');
    await expect(lightbox(page)).toHaveCount(0);
  }
});

test('the lightbox fits the viewport and adds no page overflow', async ({ page }, testInfo) => {
  await waitForStation(page);
  await generate(page);
  await openContentTab(page);
  await inspector(page).locator('img').first().dblclick();

  const vw = testInfo.project.use.viewport!.width;
  const vh = testInfo.project.use.viewport!.height;

  const box = await page.getByTestId('lightbox-image').boundingBox();
  expect(box!.width).toBeLessThanOrEqual(vw * 0.9 + 1);
  expect(box!.height).toBeLessThanOrEqual(vh * 0.9 + 1);

  // the close control is on screen and reachable at both widths
  const close = await page.getByTestId('lightbox-close').boundingBox();
  expect(close!.x).toBeGreaterThanOrEqual(0);
  expect(close!.x + close!.width).toBeLessThanOrEqual(vw);
  expect(close!.y).toBeGreaterThanOrEqual(0);

  // The page carries a little vertical slack of its own, so the meaningful
  // assertion is that the lightbox adds none — measured against the same page
  // with the lightbox closed.
  const measure = () =>
    page.evaluate(() => ({
      x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    }));
  const withLightbox = await measure();
  await page.keyboard.press('Escape');
  await expect(lightbox(page)).toHaveCount(0);
  const without = await measure();

  expect(withLightbox.x).toBeLessThanOrEqual(1);
  expect(withLightbox.x).toBeLessThanOrEqual(without.x);
  expect(withLightbox.y).toBeLessThanOrEqual(without.y);
});

test('opening and closing the lightbox never moves the canvas', async ({ page }) => {
  await waitForStation(page);
  await generate(page);
  await openContentTab(page);

  const geometry = () =>
    page.evaluate(() => {
      const editor = (window as unknown as { editor: any }).editor;
      return editor
        .getCurrentPageShapes()
        .filter((s: any) => s.props?.node?.type === 'listing_result')
        .map((s: any) => {
          const b = editor.getShapePageBounds(s.id);
          return { p: s.props.node.platform, x: Math.round(b.x), y: Math.round(b.y) };
        })
        .sort((a: any, b: any) => a.y - b.y);
    });

  const camBefore = await camera(page);
  const geoBefore = await geometry();
  const selectedBefore = await page.evaluate(
    () => (window as unknown as { editor: any }).editor.getSelectedShapeIds().length,
  );

  const img = inspector(page).locator('img').first();
  await img.hover();
  await page.getByTestId('view-original').click();
  await expect(lightbox(page)).toBeVisible();
  expect(await camera(page)).toEqual(camBefore);

  // a click on the image inside the lightbox must not reach the canvas
  await page.getByTestId('lightbox-image').click({ position: { x: 12, y: 12 } });
  expect(await camera(page)).toEqual(camBefore);

  await page.keyboard.press('Escape');
  await expect(lightbox(page)).toHaveCount(0);
  expect(await camera(page)).toEqual(camBefore);
  expect(await geometry()).toEqual(geoBefore);
  // no node got selected or dragged by the interaction
  expect(
    await page.evaluate(
      () => (window as unknown as { editor: any }).editor.getSelectedShapeIds().length,
    ),
  ).toBe(selectedBefore);
});

test('the details modal keeps its scroll position across a lightbox cycle', async ({ page }) => {
  await waitForStation(page);
  await generate(page);
  await openContentTab(page);

  const content = page.locator('[data-testid="inspector-content"]');
  const scrollTop = () => content.evaluate((el: HTMLElement) => el.scrollTop);

  await content.evaluate((el: HTMLElement) => {
    el.scrollTop = 80;
  });
  // The browser clamps this to whatever the tab can actually scroll — the
  // Content tab overflows at 1280 but often fits at 1440, so the meaningful
  // assertion is that the value SURVIVES, not that it is non-zero.
  const before = await scrollTop();

  // Open the lightbox WITHOUT a click: Playwright scrolls a target into view
  // before clicking it, which would move the modal's scroll by itself and make
  // this assertion about the test harness rather than about the lightbox.
  await content.evaluate((el: HTMLElement) => {
    const img = el.querySelector('img');
    img?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
  await expect(lightbox(page)).toBeVisible();

  // opening did not reset the position …
  expect(await scrollTop()).toBe(before);

  await page.keyboard.press('Escape');
  await expect(lightbox(page)).toHaveCount(0);

  // … and closing (which restores focus to the trigger) did not move it either
  expect(await scrollTop()).toBe(before);
  await expect(inspector(page)).toBeVisible();
});

// --------------------------------------------------------------------------- //
// reuse: the same component serves the image node                             //
// --------------------------------------------------------------------------- //

test('the image node reuses the same lightbox component', async ({ page }) => {
  await waitForStation(page);
  await page.getByTitle('添加节点').click();
  await page.getByRole('button', { name: '图片', exact: true }).click();
  const node = page.locator('.NodeShape_image_generation').last();
  await expect(node).toBeVisible();

  const url =
    'data:image/svg+xml;charset=utf-8,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="%23d8a63f"/></svg>',
    );
  await page.evaluate(u => {
    const editor = (window as unknown as { editor: any }).editor;
    const shape = editor
      .getCurrentPageShapes()
      .find((s: any) => s.props?.node?.type === 'image_generation');
    editor.updateShape({
      id: shape.id,
      type: shape.type,
      props: { node: { ...shape.props.node, imageUrls: [u], lastResult: '已生成 1 张图片' } },
    });
  }, url);
  await page.waitForTimeout(400);

  await node.locator('img[alt="generated"]').dblclick();
  // the SHARED component, not the old bespoke one
  await expect(lightbox(page)).toBeVisible();
  await expect(page.getByTestId('lightbox-image')).toHaveAttribute('src', url);
  await expect(page.getByTestId('lightbox-close')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(lightbox(page)).toHaveCount(0);
});

test('a broken original shows a friendly failure instead of a black screen', async ({ page }) => {
  await waitForStation(page);
  await generate(page);

  await page.evaluate(() => {
    const editor = (window as unknown as { editor: any }).editor;
    const shape = editor
      .getCurrentPageShapes()
      .find((s: any) => s.props?.node?.platform === 'amazon');
    editor.updateShape({
      id: shape.id,
      type: shape.type,
      props: { node: { ...shape.props.node, imageUrl: '/station/does-not-exist.png' } },
    });
  });
  await page.waitForTimeout(300);
  await openContentTab(page);
  await inspector(page).locator('img').first().dblclick();

  await expect(page.getByTestId('lightbox-error')).toBeVisible();
  await expect(page.getByTestId('lightbox-error')).toContainText('原图加载失败');
  await expect(page.getByTestId('lightbox-close')).toBeVisible();
});
