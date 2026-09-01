import { expect, test, type Page } from '@playwright/test';

const SHOTS = 'e2e/screenshots';

async function waitForStation(page: Page) {
  await page.goto('/');
  await page.waitForSelector('#station-generate', { timeout: 20_000 });
  await page.waitForTimeout(900); // let tldraw settle / auto-frame
}

function tag(testInfo: { project: { name: string } }) {
  return testInfo.project.name; // desktop-1440 / desktop-1280
}

async function ensureAgentOpen(page: Page) {
  const expand = page.getByRole('button', { name: '展开 Agent 面板' });
  if (await expand.isVisible().catch(() => false)) await expand.click();
  await expect(page.locator('aside[aria-label="Agent 对话"]')).toBeVisible();
}

/** Screen-space right edge of the Agent (its left edge when collapsed → viewport width). */
async function agentLeftEdge(page: Page, viewportWidth: number) {
  const aside = page.locator('aside[aria-label="Agent 对话"]');
  if (await aside.isVisible().catch(() => false)) {
    const box = await aside.boundingBox();
    if (box) return box.x;
  }
  return viewportWidth;
}

const THREE_DRAFTS = {
  code: 0,
  data: {
    source: 'llm',
    drafts: [
      { id: 'amazon', title: 'Amazon title from model', fields: [], checks: [] },
      { id: 'tiktok', title: 'Tiktok title from model', fields: [], checks: [] },
      { id: 'shopify', title: 'Shopify title from model', fields: [], checks: [] },
    ],
  },
};

// --------------------------------------------------------------------------- //
// P0.6 / P0.7 — form behaviour                                                //
// --------------------------------------------------------------------------- //

test('P0.6 empty Generate does NOT insert demo data and shows validation', async ({ page }, testInfo) => {
  await waitForStation(page);
  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-01-initial.png` });

  const name = page.locator('input[placeholder="折叠硅胶水杯 350ml"]');
  await expect(name).toHaveValue('');
  await page.click('#station-generate');
  await page.waitForTimeout(200);

  await expect(name).toHaveValue(''); // not mutated
  await expect(page.getByText('请填写品名')).toBeVisible();
  await expect(name).toBeFocused();
  await expect(page.locator('.NodeShape_station', { has: page.getByRole('button', { name: '复制标题' }) })).toHaveCount(0);
});

test('P0.6 only 填入演示 inserts demo content', async ({ page }) => {
  await waitForStation(page);
  const name = page.locator('input[placeholder="折叠硅胶水杯 350ml"]');
  await expect(name).toHaveValue('');
  await page.click('#station-fill');
  await page.waitForTimeout(200);
  await expect(name).not.toHaveValue('');
});

test('P0.7 zero platforms selected shows an inline message', async ({ page }) => {
  await waitForStation(page);
  await page.click('#station-fill');
  await page.waitForTimeout(150);
  for (const label of ['Amazon', 'TikTok Shop', 'Shopify']) {
    const cb = page.locator('label', { hasText: label }).locator('input[type="checkbox"]');
    if (await cb.isChecked()) await cb.uncheck();
  }
  await page.click('#station-generate');
  await expect(page.getByText('请至少选择一个平台')).toBeVisible();
});

// --------------------------------------------------------------------------- //
// P0.2 / P0.4 — source labelling + reaching the backend                       //
// --------------------------------------------------------------------------- //

test('P0.4 a valid same-origin POST reaches FastAPI; backend fallback shows an amber badge', async ({
  page,
}, testInfo) => {
  await waitForStation(page);
  await page.click('#station-fill');
  await page.waitForTimeout(150);
  const [resp] = await Promise.all([
    page.waitForResponse(r => r.url().includes('/api/listing/generate'), { timeout: 20_000 }),
    page.click('#station-generate'),
  ]);
  expect(resp.status()).toBe(200);
  await expect(page.getByText('后端规则兜底')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(700);
  // default Agent state for this viewport (collapsed when width ≤ 1280, else open)
  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-02-after-generate-default.png` });
});

test('P0.2 backend source="llm" is shown as Token Plan (green)', async ({ page }) => {
  await page.route('**/api/listing/generate', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(THREE_DRAFTS) }),
  );
  await waitForStation(page);
  await page.click('#station-fill');
  await page.click('#station-generate');
  await expect(page.getByText('模型生成 · Token Plan')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#station-local-sample-banner')).toHaveCount(0);
});

test('P0.2/P0.3 network failure is never shown as a successful generation', async ({ page }) => {
  await page.route('**/api/listing/generate', route => route.abort('failed'));
  await waitForStation(page);
  await page.click('#station-fill');
  await page.click('#station-generate');

  await expect(page.getByText('无法连接后端服务，请检查网络后重试。')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#station-use-local-sample')).toBeVisible();
  await expect(page.getByText('模型生成 · Token Plan')).toHaveCount(0);
  await expect(page.getByText('后端规则兜底')).toHaveCount(0);

  await page.click('#station-use-local-sample');
  await expect(page.locator('#station-local-sample-banner')).toBeVisible();
  await expect(page.locator('#station-local-sample-banner')).toContainText('本地示例数据');
});

// --------------------------------------------------------------------------- //
// P0.1 — real cancellation                                                    //
// --------------------------------------------------------------------------- //

test('P0.1 Cancel during a delayed listing request produces no results and no badge', async ({ page }) => {
  let listingAborted = false;
  page.on('requestfailed', req => {
    if (req.url().includes('/api/listing/generate')) listingAborted = true;
  });

  await page.route('**/api/listing/generate', async route => {
    await new Promise(r => setTimeout(r, 4000));
    try {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(THREE_DRAFTS),
      });
    } catch {
      /* client already aborted */
    }
  });

  await waitForStation(page);
  await page.click('#station-fill');
  await page.click('#station-generate');

  // run is in progress → button toggles to 取消
  await expect(page.locator('#station-generate')).toHaveText('取消', { timeout: 5_000 });
  await page.waitForTimeout(700);

  // cancel
  await page.click('#station-generate');

  // wait well past the 4s response delay
  await page.waitForTimeout(5_000);

  expect(listingAborted).toBe(true); // the HTTP request was actually aborted
  await expect(page.locator('#station-generate')).toHaveText('生成'); // back to idle
  await expect(page.locator('.NodeShape_station', { has: page.getByRole('button', { name: '复制标题' }) })).toHaveCount(0);
  await expect(page.getByText('模型生成 · Token Plan')).toHaveCount(0);
  await expect(page.getByText('后端规则兜底')).toHaveCount(0);
  await expect(page.locator('#station-local-sample-banner')).toHaveCount(0);
  await expect(page.locator('#station-retry')).toHaveCount(0);
  await expect(page.getByText('无法连接后端服务')).toHaveCount(0);

  // a fresh Generate still works
  await page.unroute('**/api/listing/generate');
  await page.route('**/api/listing/generate', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(THREE_DRAFTS) }),
  );
  await page.click('#station-generate');
  await expect(page.getByText('模型生成 · Token Plan')).toBeVisible({ timeout: 15_000 });
});

// --------------------------------------------------------------------------- //
// P1.11 — default post-generation layout, no Agent overlap                    //
// --------------------------------------------------------------------------- //

test('P1.11 immediately after generation every result card is outside the Agent panel', async ({
  page,
}, testInfo) => {
  await page.route('**/api/listing/generate', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(THREE_DRAFTS) }),
  );
  await waitForStation(page);
  await ensureAgentOpen(page);

  await page.click('#station-fill');
  await page.click('#station-generate');
  await expect(page.getByText('模型生成 · Token Plan')).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(700); // auto-frame settles — NO manual "查看全部结果" click

  const vw = testInfo.project.use.viewport!.width;
  const agentLeft = await agentLeftEdge(page, vw);

  const cards = page.locator('.NodeShape_station', {
    has: page.getByRole('button', { name: '复制标题' }),
  });
  const count = await cards.count();
  expect(count).toBe(3);

  for (let i = 0; i < count; i++) {
    const box = await cards.nth(i).boundingBox();
    expect(box, `card ${i} must be rendered`).not.toBeNull();
    // complete bounding box, right edge must clear the Agent panel
    expect(box!.x + box!.width, `card ${i} right edge (${Math.round(box!.x + box!.width)}) <= agent left (${Math.round(agentLeft)})`).toBeLessThanOrEqual(agentLeft + 1);
    expect(box!.x, `card ${i} left edge on screen`).toBeGreaterThanOrEqual(-1);
    expect(box!.width).toBeGreaterThan(180);
  }
  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-03-after-generate-agent-open.png` });

  // optional nav controls still work
  await page.click('#station-focus-input');
  await page.waitForTimeout(400);
  await expect(page.locator('input[placeholder="折叠硅胶水杯 350ml"]')).toBeVisible();
});

// --------------------------------------------------------------------------- //
// P0.4 — Agent unreachable: safe message + Retry                              //
// --------------------------------------------------------------------------- //

test('P0.4 Agent backend unreachable shows a safe Chinese message and Retry recovers', async ({ page }) => {
  await waitForStation(page);
  await ensureAgentOpen(page);

  await page.route('**/api/agent/chat', route => route.abort('failed'));
  const input = page.locator('aside[aria-label="Agent 对话"] textarea');
  await input.fill('主图能加字吗');
  await input.press('Enter');

  await expect(page.getByText('无法连接后端服务，请检查网络后重试。')).toBeVisible({ timeout: 10_000 });
  const retry = page.getByRole('button', { name: '重试' });
  await expect(retry).toBeVisible();
  await expect(page.locator('aside[aria-label="Agent 对话"]')).not.toContainText('Failed to fetch');

  await page.unroute('**/api/agent/chat');
  await retry.click();
  // real backend, no TOKEN_PLAN key -> deterministic Chinese keyword fallback
  await expect(page.locator('aside[aria-label="Agent 对话"]')).toContainText('白底', { timeout: 10_000 });
});

// --------------------------------------------------------------------------- //
// P1.12 / P1.14 — rules from /api/rules                                       //
// --------------------------------------------------------------------------- //

test('P1.12/P1.14 rules come from /api/rules with a clickable official source', async ({ page }) => {
  await waitForStation(page);
  const [resp] = await Promise.all([
    page.waitForResponse(r => r.url().includes('/api/rules'), { timeout: 15_000 }),
    page.click('#station-rules'),
  ]);
  expect(resp.status()).toBe(200);
  const dialog = page.locator('[role="dialog"][aria-modal="true"]');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('来自后端 /api/rules')).toBeVisible();
  // Amazon row cites a specific official page, not a bare homepage
  const amazonRow = dialog.locator('tr', { hasText: 'amazon.main-image' });
  const amazonLink = amazonRow.locator('a[href*="amazon.com/"]').first();
  await expect(amazonLink).toBeVisible();
  const href = await amazonLink.getAttribute('href');
  expect(href).toMatch(/^https:\/\/[a-z.]*amazon\.com\/.+/);
  expect(href).not.toBe('https://sellercentral.amazon.com/');
  expect(new URL(href!).pathname.replace(/\/$/, '').length).toBeGreaterThan(1);

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('#station-rules')).toBeFocused();
});

// --------------------------------------------------------------------------- //
// P2.17 — copy feedback                                                       //
// --------------------------------------------------------------------------- //

test('P2.17 copy button shows success feedback', async ({ page }) => {
  await page.route('**/api/listing/generate', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(THREE_DRAFTS) }),
  );
  await waitForStation(page);
  await page.click('#station-fill');
  await page.click('#station-generate');
  await expect(page.getByText('模型生成 · Token Plan')).toBeVisible({ timeout: 15_000 });
  const copyBtn = page.getByRole('button', { name: '复制标题' }).first();
  await copyBtn.click();
  await expect(page.getByRole('button', { name: '已复制标题' }).first()).toBeVisible();
});

// --------------------------------------------------------------------------- //
// Media interaction regressions                                               //
// --------------------------------------------------------------------------- //

async function addImageNode(page: Page) {
  await page.getByTitle('添加节点').click();
  await page.getByRole('button', { name: '图片', exact: true }).click();
  const node = page.locator('.NodeShape_image_generation').last();
  await expect(node).toBeVisible();
  await page.waitForTimeout(300);
  return node;
}

test('media port DOM center matches the tldraw connection coordinate', async ({ page }) => {
  await waitForStation(page);
  const node = await addImageNode(page);
  const delta = await node.evaluate(element => {
    const port = element.querySelector<HTMLElement>('.NodeShape-sidePorts .Port_end');
    const editor = (window as unknown as { editor: { getCamera: () => { z: number } } }).editor;
    if (!port) throw new Error('image input port missing');
    const nodeBox = element.getBoundingClientRect();
    const portBox = port.getBoundingClientRect();
    const modelY = Number.parseFloat(getComputedStyle(port).getPropertyValue('--port-y'));
    const expectedScreenY = nodeBox.top + modelY * editor.getCamera().z;
    const visibleScreenY = portBox.top + portBox.height / 2;
    return Math.abs(expectedScreenY - visibleScreenY);
  });
  expect(delta).toBeLessThanOrEqual(1.5);
});

const RATIO_BUTTONS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2'];

function svgDataUrl(width: number, height: number) {
  return (
    'data:image/svg+xml;charset=utf-8,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="%23d8a63f"/></svg>`,
    )
  );
}

/** Put a generated result on the (single) image node, as the provider would. */
async function setGeneratedImage(page: Page, src: string) {
  await page.evaluate(url => {
    const editor = (window as unknown as {
      editor: { getCurrentPageShapes: () => Array<any>; updateShape: (update: any) => void };
    }).editor;
    const shape = editor
      .getCurrentPageShapes()
      .find(item => item.type === 'node' && item.props.node.type === 'image_generation');
    editor.updateShape({
      id: shape.id,
      type: shape.type,
      props: {
        node: { ...shape.props.node, imageUrls: [url], resultAspectRatio: null, lastResult: '已生成 1 张图片' },
      },
    });
  }, src);
}

test('request-ratio buttons never resize the empty preview', async ({ page }) => {
  await waitForStation(page);
  const node = await addImageNode(page);
  const box = node.locator('.ImageGenNode-imageBox');

  const neutral = await box.boundingBox();
  expect(neutral).not.toBeNull();
  // Before a result exists the preview keeps a stable neutral 16:9 shape.
  expect(Math.abs(neutral!.width / neutral!.height - 16 / 9)).toBeLessThan(0.03);

  for (const ratio of RATIO_BUTTONS) {
    await node.getByRole('button', { name: ratio, exact: true }).click();
    await page.waitForTimeout(120);
    const after = await box.boundingBox();
    expect(after!.width).toBeCloseTo(neutral!.width, 0);
    expect(after!.height).toBeCloseTo(neutral!.height, 0);
  }
});

test('a 1:1 request returning a 1600x900 image renders as 16:9', async ({ page }) => {
  await waitForStation(page);
  const node = await addImageNode(page);
  const box = node.locator('.ImageGenNode-imageBox');

  await node.getByRole('button', { name: '1:1', exact: true }).click();
  await page.waitForTimeout(120);
  const requested = await box.boundingBox();
  expect(Math.abs(requested!.width / requested!.height - 16 / 9)).toBeLessThan(0.03);

  await setGeneratedImage(page, svgDataUrl(1600, 900));
  const image = node.locator('img[alt="generated"]');
  await expect(image).toBeVisible();
  await page.waitForTimeout(300); // onLoad -> intrinsic ratio -> geometry

  const rendered = await box.boundingBox();
  expect(Math.abs(rendered!.width / rendered!.height - 16 / 9)).toBeLessThan(0.03);
  // contain keeps the whole asset visible, so nothing is cropped.
  expect(await image.evaluate(element => getComputedStyle(element).objectFit)).toBe('contain');
  const drawn = await image.boundingBox();
  expect(Math.abs(drawn!.width / drawn!.height - 16 / 9)).toBeLessThan(0.05);
});

test('a portrait result resizes the preview and keeps the ports on the connection point', async ({
  page,
}) => {
  await waitForStation(page);
  const node = await addImageNode(page);
  const box = node.locator('.ImageGenNode-imageBox');

  await setGeneratedImage(page, svgDataUrl(1024, 1536));
  await expect(node.locator('img[alt="generated"]')).toBeVisible();
  await page.waitForTimeout(300);

  const portrait = await box.boundingBox();
  expect(Math.abs(portrait!.width / portrait!.height - 1024 / 1536)).toBeLessThan(0.03);

  // The tldraw port coordinate must still land on the visible port after the
  // node geometry followed the asset.
  const delta = await node.evaluate(element => {
    const port = element.querySelector<HTMLElement>('.NodeShape-sidePorts .Port_end');
    const editor = (window as unknown as { editor: { getCamera: () => { z: number } } }).editor;
    if (!port) throw new Error('image input port missing');
    const nodeBox = element.getBoundingClientRect();
    const portBox = port.getBoundingClientRect();
    const modelY = Number.parseFloat(getComputedStyle(port).getPropertyValue('--port-y'));
    const expectedScreenY = nodeBox.top + modelY * editor.getCamera().z;
    return Math.abs(expectedScreenY - (portBox.top + portBox.height / 2));
  });
  expect(delta).toBeLessThanOrEqual(1.5);
});

test('a connected SKU node feeds the video request with its brief and first frame', async ({
  page,
}) => {
  await waitForStation(page);

  // Add a video node next to the seeded SKU node.
  await page.getByTitle('添加节点').click();
  await page.getByRole('button', { name: '视频', exact: true }).click();
  const videoNode = page.locator('.NodeShape_video_generation').last();
  await expect(videoNode).toBeVisible();

  // Put a real artifact package on the SKU node (what a successful run persists)
  // and wire SKU output -> video input, exactly as a user drag would.
  await page.evaluate(() => {
    const editor = (window as unknown as {
      editor: {
        getCurrentPageShapes: () => Array<any>;
        updateShape: (update: any) => void;
        createShape: (shape: any) => void;
        createBinding: (binding: any) => void;
      };
    }).editor;
    const shapes = editor.getCurrentPageShapes();
    const sku = shapes.find(s => s.type === 'node' && s.props.node.type === 'sku_listing');
    const video = shapes.find(s => s.type === 'node' && s.props.node.type === 'video_generation');
    editor.updateShape({
      id: sku.id,
      type: sku.type,
      props: {
        node: {
          ...sku.props.node,
          productName: '折叠硅胶水杯 350ml',
          videoBrief: '产品：折叠硅胶水杯 350ml\n\n【Amazon 草稿】\n标题：Collapsible Silicone Travel Cup',
          imageAssets: ['https://cdn.test/white.png', '/station/cup-lifestyle.svg'],
        },
      },
    });
    const connectionId = `shape:${crypto.randomUUID()}`;
    editor.createShape({ type: 'connection', id: connectionId, x: 0, y: 0 });
    editor.createBinding({
      type: 'connection',
      fromId: connectionId,
      toId: sku.id,
      props: { portId: 'output', terminal: 'start' },
    });
    editor.createBinding({
      type: 'connection',
      fromId: connectionId,
      toId: video.id,
      props: { portId: 'input', terminal: 'end' },
    });
  });

  // Truthful summary of what is really connected.
  await expect(videoNode.getByTestId('video-upstream-summary')).toHaveText(
    '已接入上游文本素材 · 2 张图片 · 第 1 张作为首帧',
  );

  // The node's own prompt is combined with the upstream brief, not discarded.
  await videoNode.locator('textarea').fill('镜头从桌面缓慢推近');

  let body: Record<string, string> | null = null;
  await page.route('**/api/media/video', async route => {
    body = JSON.parse(route.request().postData() ?? '{}');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: { url: 'data:video/mp4;base64,QQ==' } }),
    });
  });
  await videoNode.getByRole('button', { name: '生成', exact: true }).click();
  await expect.poll(() => body).not.toBeNull();

  expect(body!.prompt).toContain('产品：折叠硅胶水杯 350ml');
  expect(body!.prompt).toContain('Collapsible Silicone Travel Cup');
  expect(body!.prompt).toContain('【创意指令】镜头从桌面缓慢推近');
  expect(body!.first_frame_url).toBe('https://cdn.test/white.png');
});

/**
 * Add an image node + a video node, put a generated image (and the given
 * prompt) on the image node, and wire image output -> video input exactly as a
 * user drag would.
 */
async function wireImageNodeToVideoNode(page: Page, imagePrompt: string, imageUrl: string) {
  // Keep this focused interaction test independent of the fixed Agent overlay.
  // At 1440px the second media node can otherwise land underneath that panel.
  const collapseAgent = page.getByRole('button', { name: '收起 Agent 面板' });
  if (await collapseAgent.isVisible().catch(() => false)) await collapseAgent.click();

  await page.getByTitle('添加节点').click();
  await page.getByRole('button', { name: '图片', exact: true }).click();
  await expect(page.locator('.NodeShape_image_generation').last()).toBeVisible();
  await page.getByTitle('添加节点').click();
  await page.getByRole('button', { name: '视频', exact: true }).click();
  const videoNode = page.locator('.NodeShape_video_generation').last();
  await expect(videoNode).toBeVisible();

  await page.evaluate(
    ({ prompt, url }) => {
      const editor = (window as unknown as {
        editor: {
          getCurrentPageShapes: () => Array<any>;
          updateShape: (update: any) => void;
          createShape: (shape: any) => void;
          createBinding: (binding: any) => void;
        };
      }).editor;
      const shapes = editor.getCurrentPageShapes();
      const image = shapes.filter(s => s.type === 'node' && s.props.node.type === 'image_generation').pop();
      const video = shapes.filter(s => s.type === 'node' && s.props.node.type === 'video_generation').pop();
      editor.updateShape({
        id: image.id,
        type: image.type,
        props: {
          node: {
            ...image.props.node,
            prompt,
            imageUrls: [url],
            resultAspectRatio: null,
            lastResult: '已生成 1 张图片',
          },
        },
      });
      const connectionId = `shape:${crypto.randomUUID()}`;
      editor.createShape({ type: 'connection', id: connectionId, x: 0, y: 0 });
      editor.createBinding({
        type: 'connection',
        fromId: connectionId,
        toId: image.id,
        props: { portId: 'output', terminal: 'start' },
      });
      editor.createBinding({
        type: 'connection',
        fromId: connectionId,
        toId: video.id,
        props: { portId: 'input', terminal: 'end' },
      });
      // Two media nodes sit wider than the framed station, so bring the video
      // node fully on screen before the test clicks its controls.
      editor.select(video.id);
      editor.zoomToSelection();
    },
    { prompt: imagePrompt, url: imageUrl },
  );
  await page.waitForTimeout(600); // connection summary reflows the node
  // Re-frame after React has applied that final height. The image-only summary
  // wraps to an extra line, so framing the pre-render bounds leaves the action
  // row just below the viewport on a 1440×900 test screen.
  await page.evaluate(() => {
    const editor = (window as unknown as { editor: { zoomToSelection: () => void } }).editor;
    editor.zoomToSelection();
  });
  await page.waitForTimeout(600); // camera animation
  return videoNode;
}

/** Capture the /api/media/video request body and answer with a playable stub. */
async function stubVideoProvider(page: Page) {
  const captured: { body: Record<string, string> | null } = { body: null };
  await page.route('**/api/media/video', async route => {
    captured.body = JSON.parse(route.request().postData() ?? '{}');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: { url: 'data:video/mp4;base64,QQ==' } }),
    });
  });
  return captured;
}

test('an image node with a blank prompt drives the video node as image-to-video', async ({
  page,
}) => {
  await waitForStation(page);
  const frame = svgDataUrl(1024, 1024);
  const videoNode = await wireImageNodeToVideoNode(page, '', frame);

  // Truthful, non-blocking summary: a first frame alone is a complete request.
  await expect(videoNode.getByTestId('video-upstream-summary')).toHaveText(
    '已连接首帧图片 · 1 张图片 · 第 1 张作为首帧 · 可直接生成，运镜描述可留空',
  );

  const captured = await stubVideoProvider(page);
  await expect(videoNode.locator('textarea')).toHaveValue('');
  await videoNode.getByRole('button', { name: '生成', exact: true }).click();
  await expect.poll(() => captured.body).not.toBeNull();

  // The provider really was called, with the connected image as the first frame.
  expect(captured.body!.first_frame_url).toBe(frame);
  expect(captured.body!.prompt).toBe('');
  await expect(videoNode.getByText('请先填写提示词')).toHaveCount(0);
  await expect(videoNode.locator('video')).toBeVisible();
});

test('the image node prompt travels to the video node as upstream context', async ({ page }) => {
  await waitForStation(page);
  const frame = svgDataUrl(1024, 1024);
  const videoNode = await wireImageNodeToVideoNode(page, '白色背景上的折叠硅胶水杯', frame);

  await expect(videoNode.getByTestId('video-upstream-summary')).toHaveText(
    '已接入上游文本素材 · 1 张图片 · 第 1 张作为首帧',
  );

  const captured = await stubVideoProvider(page);
  await videoNode.locator('textarea').fill('镜头缓慢推近');
  await videoNode.getByRole('button', { name: '生成', exact: true }).click();
  await expect.poll(() => captured.body).not.toBeNull();

  expect(captured.body!.prompt).toContain('白色背景上的折叠硅胶水杯');
  expect(captured.body!.prompt).toContain('【创意指令】镜头缓慢推近');
  expect(captured.body!.first_frame_url).toBe(frame);
});

test('double-clicking a generated image opens and closes the lightbox', async ({ page }) => {
  await waitForStation(page);
  const node = await addImageNode(page);
  await setGeneratedImage(page, svgDataUrl(800, 800));

  await node.locator('img[alt="generated"]').dblclick();
  const lightbox = page.getByTestId('image-lightbox');
  await expect(lightbox).toBeVisible();
  await expect(lightbox.locator('img[alt="生成图片大图预览"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(lightbox).toHaveCount(0);
});

test('collapsing and expanding Agent preserves the canvas camera', async ({ page }) => {
  await waitForStation(page);
  await ensureAgentOpen(page);
  const camera = () =>
    page.evaluate(() =>
      (window as unknown as { editor: { getCamera: () => { x: number; y: number; z: number } } }).editor.getCamera(),
    );

  const before = await camera();
  await page.getByRole('button', { name: '收起 Agent 面板' }).click();
  await page.waitForTimeout(350);
  expect(await camera()).toEqual(before);

  await page.getByRole('button', { name: '展开 Agent 面板' }).click();
  await page.waitForTimeout(350);
  expect(await camera()).toEqual(before);
});
