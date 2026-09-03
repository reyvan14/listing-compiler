import { expect, test, type Page } from '@playwright/test';

// Viewport-level listing detail inspector.
//
// The canvas node stays permanently compact; the inspector floats above the
// canvas. Every spec here also guards the canvas: opening, switching tabs and
// closing must leave node geometry, connections and the camera untouched.

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
  // tldraw virtualises shapes outside the viewport. Waiting for the first DOM
  // result to be visible is therefore order-dependent: the first matched card
  // may be culled while another result is already visible. Wait on the editor
  // model, which is the actual generation-complete state.
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
  await page.waitForTimeout(1200);
}

type Geom = { platform: string; x: number; y: number; w: number; h: number; bound: boolean };

/** Node geometry + whether the input connection is still bound, per card. */
async function canvasState(page: Page): Promise<Geom[]> {
  return page.evaluate(() => {
    const editor = (window as unknown as { editor: any }).editor;
    return editor
      .getCurrentPageShapes()
      .filter(
        (s: any) => s.props?.node?.type === 'listing_result' && s.props.node.platform !== 'ad',
      )
      .map((s: any) => {
        const b = editor.getShapePageBounds(s.id);
        return {
          platform: s.props.node.platform,
          x: Math.round(b.x),
          y: Math.round(b.y),
          w: Math.round(b.w),
          h: Math.round(b.h),
          bound: editor
            .getBindingsToShape(s.id, 'connection')
            .some((x: any) => x.props?.portId === 'input'),
        };
      })
      .sort((a: Geom, b: Geom) => a.y - b.y);
  });
}

async function camera(page: Page) {
  return page.evaluate(() => (window as unknown as { editor: any }).editor.getCamera());
}

function card(page: Page, platform: string) {
  return page.locator(`[data-testid="listing-result"][data-platform="${platform}"]`);
}

const inspector = (page: Page) => page.locator('[data-testid="listing-inspector"]');

/** Pan so a card is on screen (the stack is taller than the viewport). */
async function bringIntoView(page: Page, platform: string) {
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
  await page.waitForTimeout(250);
}

async function openVia(page: Page, platform: string) {
  await bringIntoView(page, platform);
  await card(page, platform).getByTestId('open-details').click();
  await expect(inspector(page)).toBeVisible();
}

function sectionTab(page: Page, id: string) {
  return page.locator(`[data-testid="inspector-tab"][data-tab="${id}"]`);
}

function platformTab(page: Page, platform: string) {
  return page.locator(`[data-testid="inspector-platform-tab"][data-platform="${platform}"]`);
}

// --------------------------------------------------------------------------- //
// 1 + 2. opens without touching the canvas                                    //
// --------------------------------------------------------------------------- //

test('View details opens the inspector without changing node geometry or camera', async ({
  page,
}, testInfo) => {
  await waitForStation(page);
  await generate(page);
  await bringIntoView(page, 'amazon');

  const before = await canvasState(page);
  const camBefore = await camera(page);

  await card(page, 'amazon').getByTestId('open-details').click();
  await expect(inspector(page)).toBeVisible();
  await page.waitForTimeout(300);

  // the canvas is completely untouched: positions, sizes and bindings
  expect(await canvasState(page)).toEqual(before);
  expect(await camera(page)).toEqual(camBefore);
  // and every card is still bound to its connection
  expect((await canvasState(page)).every(c => c.bound)).toBe(true);

  await expect(page.locator('#inspector-title')).toContainText('Amazon');
  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-inspector-01-open.png` });
});

test('double-clicking a card opens the same inspector on that platform', async ({ page }) => {
  await waitForStation(page);
  await generate(page);
  await bringIntoView(page, 'tiktok');

  const before = await canvasState(page);
  const camBefore = await camera(page);

  const box = await card(page, 'tiktok').boundingBox();
  await page.mouse.dblclick(box!.x + 40, box!.y + 24);
  await expect(inspector(page)).toBeVisible();
  await page.waitForTimeout(300);

  await expect(page.locator('#inspector-title')).toContainText('TikTok Shop');
  await expect(platformTab(page, 'tiktok')).toHaveAttribute('aria-selected', 'true');
  expect(await canvasState(page)).toEqual(before);
  expect(await camera(page)).toEqual(camBefore);
});

test('the result stack never resizes or reflows while the inspector is used', async ({ page }) => {
  await waitForStation(page);
  await generate(page);
  await bringIntoView(page, 'amazon');
  const before = await canvasState(page);
  const camBefore = await camera(page);

  await card(page, 'amazon').getByTestId('open-details').click();
  await expect(inspector(page)).toBeVisible();

  for (const p of ['tiktok', 'shopify', 'amazon']) {
    await platformTab(page, p).click();
    await page.waitForTimeout(150);
    expect(await canvasState(page), `after switching to ${p}`).toEqual(before);
  }
  for (const t of ['compliance', 'policy', 'content']) {
    await sectionTab(page, t).click();
    await page.waitForTimeout(150);
    expect(await canvasState(page), `after opening the ${t} tab`).toEqual(before);
  }

  await page.keyboard.press('Escape');
  await expect(inspector(page)).toHaveCount(0);
  expect(await canvasState(page)).toEqual(before);
  expect(await camera(page)).toEqual(camBefore);
});

// --------------------------------------------------------------------------- //
// 3. platform navigation                                                      //
// --------------------------------------------------------------------------- //

test('platform tabs switch content without closing the inspector', async ({ page }) => {
  await waitForStation(page);
  await generate(page);
  await openVia(page, 'shopify');

  await expect(platformTab(page, 'shopify')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#inspector-title')).toContainText('Shopify');

  await platformTab(page, 'amazon').click();
  await expect(inspector(page)).toBeVisible(); // still open
  await expect(page.locator('#inspector-title')).toContainText('Amazon');
  await expect(platformTab(page, 'amazon')).toHaveAttribute('aria-selected', 'true');
  await expect(platformTab(page, 'shopify')).toHaveAttribute('aria-selected', 'false');

  // the three platforms are all reachable
  await expect(page.locator('[data-testid="inspector-platform-tab"]')).toHaveCount(3);
});

// --------------------------------------------------------------------------- //
// 4. the three content tabs                                                   //
// --------------------------------------------------------------------------- //

test('Content tab shows image, title, bullets, search terms and copy actions', async ({
  page,
}, testInfo) => {
  await waitForStation(page);
  await generate(page);
  await openVia(page, 'amazon');

  const content = page.locator('[data-testid="inspector-content"]');
  await expect(content).toHaveAttribute('data-tab', 'content');

  // the full title, not the 2-line clamp from the card
  const title = await page.getByTestId('inspector-title-text').textContent();
  expect((title ?? '').length).toBeGreaterThan(60);

  await expect(content.locator('img')).toBeVisible();
  await expect(content.getByRole('heading', { name: '卖点' })).toBeVisible();
  await expect(content.getByRole('heading', { name: '搜索词' })).toBeVisible();
  // all five bullets, where the compact card showed at most three fields
  expect(await content.locator('ol li').count()).toBeGreaterThanOrEqual(5);

  // copy actions preserved
  const copy = content.getByRole('button', { name: '复制标题' });
  await expect(copy).toBeVisible();
  await copy.click();
  await expect(content.getByRole('button', { name: '已复制标题' })).toBeVisible();

  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-inspector-02-content.png` });
});

test('Compliance tab shows the summary, violations, evidence and suggestions', async ({
  page,
}, testInfo) => {
  await waitForStation(page);
  await generate(page);
  await openVia(page, 'amazon');
  await sectionTab(page, 'compliance').click();

  const content = page.locator('[data-testid="inspector-content"]');
  await expect(content).toHaveAttribute('data-tab', 'compliance');
  await expect(page.getByTestId('inspector-summary')).toContainText('通过');
  // the fallback Amazon draft has non-blocking checks with explanations
  expect(await page.getByTestId('inspector-check').count()).toBeGreaterThan(0);
  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-inspector-03-compliance.png` });
});

test('Policy tab shows the policy version and migration status', async ({ page }) => {
  await waitForStation(page);
  await generate(page);
  await openVia(page, 'amazon');
  await sectionTab(page, 'policy').click();

  const content = page.locator('[data-testid="inspector-content"]');
  await expect(content).toHaveAttribute('data-tab', 'policy');
  await expect(page.getByTestId('inspector-policy-version')).toContainText('amazon-us-');
  await expect(page.getByTestId('inspector-migration')).toContainText('当前版本');
  // truthful status language
  await expect(content).not.toContainText('已发布');
});

// --------------------------------------------------------------------------- //
// blocking stays visible on the compact card; detail lives in the inspector   //
// --------------------------------------------------------------------------- //

test('blocking stays visible on the compact card and is explained in the inspector', async ({
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
              'Stop carrying bulky mugs! 🧘‍♀️✨ AeroFold Silicone Travel Cup. #travelhacks',
          }
        : d,
    );
    const regraded = await route.request().frame().page().request.post('/api/listing/validate', {
      data: {
        drafts,
        product_name: 'AeroFold Silicone Travel Cup',
        points: 'Folds to 4.5cm\n350ml',
        asset_mode: 'compliant',
      },
    });
    const checked = (await regraded.json())?.data?.drafts ?? drafts;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...body, data: { ...body.data, drafts: checked } }),
    });
  });
  await generate(page);

  // compact card: the concise red banner is still there, details are not
  const tiktok = card(page, 'tiktok');
  const badge = tiktok.getByTestId('blocking-badge');
  await expect(badge).toBeVisible();
  await expect(badge).toContainText('阻断违规');
  await expect(badge).toContainText('需人工复核');
  await expect(tiktok.getByTestId('blocking-gate')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-inspector-04-blocking-card.png` });

  // inspector Compliance tab: the full gate, evidence and suggested title
  await openVia(page, 'tiktok');
  await sectionTab(page, 'compliance').click();
  await expect(page.getByTestId('inspector-blocking-gate')).toBeVisible();
  await expect(page.getByTestId('inspector-suggested-title')).toBeVisible();
  const violations = page.locator('[data-testid="inspector-violation"]');
  expect(await violations.count()).toBeGreaterThanOrEqual(1);
  for (const row of await violations.all()) {
    await expect(row).toContainText('问题片段：');
    await expect(row).toContainText('改法：');
  }
});

// --------------------------------------------------------------------------- //
// 6. interaction: close paths, focus, no overflow                             //
// --------------------------------------------------------------------------- //

test('Escape, the close button and a backdrop click all close it', async ({ page }) => {
  await waitForStation(page);
  await generate(page);

  await openVia(page, 'amazon');
  await page.keyboard.press('Escape');
  await expect(inspector(page)).toHaveCount(0);

  await openVia(page, 'amazon');
  await page.getByTestId('inspector-close').click();
  await expect(inspector(page)).toHaveCount(0);

  await openVia(page, 'amazon');
  await page.getByTestId('inspector-backdrop').click({ position: { x: 8, y: 8 } });
  await expect(inspector(page)).toHaveCount(0);
});

test('focus moves into the dialog and returns to the originating card on close', async ({
  page,
}) => {
  await waitForStation(page);
  await generate(page);
  await bringIntoView(page, 'amazon');

  const trigger = card(page, 'amazon').getByTestId('open-details');
  await trigger.click();
  await expect(inspector(page)).toBeVisible();
  await expect(page.getByTestId('inspector-close')).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(inspector(page)).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('the panel fits the viewport and never overflows horizontally', async ({ page }, testInfo) => {
  await waitForStation(page);
  await generate(page);
  await openVia(page, 'amazon');

  const vw = testInfo.project.use.viewport!.width;
  const vh = testInfo.project.use.viewport!.height;

  for (const t of ['content', 'compliance', 'policy']) {
    await sectionTab(page, t).click();
    await page.waitForTimeout(200);

    const box = await page.locator('[role="dialog"][aria-modal="true"]').boundingBox();
    expect(box!.width, `${t}: panel width`).toBeLessThanOrEqual(vw);
    expect(box!.width, `${t}: recommended 720-820px`).toBeGreaterThanOrEqual(700);
    expect(box!.y + box!.height, `${t}: panel bottom`).toBeLessThanOrEqual(vh + 1);

    // no horizontal scrolling anywhere: not the page, not the content area
    const overflow = await page.evaluate(() => {
      const content = document.querySelector('[data-testid="inspector-content"]') as HTMLElement;
      return {
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        content: content.scrollWidth - content.clientWidth,
      };
    });
    expect(overflow.page, `${t}: page x-overflow`).toBeLessThanOrEqual(1);
    expect(overflow.content, `${t}: content x-overflow`).toBeLessThanOrEqual(1);
  }
});

test('the inspector sits above the Agent panel', async ({ page }) => {
  await waitForStation(page);
  await generate(page);
  const expand = page.getByRole('button', { name: '展开 Agent 面板' });
  if (await expand.isVisible().catch(() => false)) await expand.click();
  await openVia(page, 'amazon');

  // the dialog is on top wherever the two would overlap
  const box = await page.locator('[role="dialog"][aria-modal="true"]').boundingBox();
  const topmost = await page.evaluate(
    pt => {
      const el = document.elementFromPoint(pt.x, pt.y);
      return !!el?.closest('[data-testid="listing-inspector"]');
    },
    { x: box!.x + box!.width - 8, y: box!.y + 40 },
  );
  expect(topmost).toBe(true);
});

test('the inspector sits above the floating tldraw toolbar and blocks canvas input', async ({
  page,
}) => {
  await waitForStation(page);
  await generate(page);
  await openVia(page, 'amazon');

  const dialog = page.locator('[role="dialog"][aria-modal="true"]');
  const box = await dialog.boundingBox();
  if (!box) throw new Error('inspector dialog has no bounds');

  // At 1280×720 this point intersects the floating tldraw toolbar in the
  // underlying canvas. Before the body portal fix, elementFromPoint returned a
  // toolbar control and the modal content could not receive the click.
  const point = {
    x: box.x + box.width / 2,
    y: Math.min(box.y + box.height - 12, page.viewportSize()!.height - 12),
  };
  const topmost = await page.evaluate(pt => {
    const el = document.elementFromPoint(pt.x, pt.y);
    return {
      inInspector: !!el?.closest('[data-testid="listing-inspector"]'),
      inTldraw: !!el?.closest('.tl-container, .tlui-layout'),
    };
  }, point);
  expect(topmost.inInspector).toBe(true);
  expect(topmost.inTldraw).toBe(false);

  // The inspector/backdrop is the only interactive layer while the dialog is
  // open; a click at the overlap must not close it or reach the canvas toolbar.
  await page.mouse.click(point.x, point.y);
  await expect(inspector(page)).toBeVisible();
});
