import { expect, test, type Page } from '@playwright/test';

// The Agent's canvas-operation flow, end to end against the real backend.
//
// The backend's deterministic planner runs when no model provider is
// configured, so these specs exercise the true request → plan → approve →
// apply → undo path without ever calling a model.

const SHOTS = 'e2e/screenshots';

const NODES = '[data-shape-type="node"]';
const PLAN_CARD = '[aria-label="Agent 变更计划"]';

async function openStation(page: Page) {
  await page.goto('/');
  await page.waitForSelector('#station-generate', { timeout: 20_000 });
  await page.waitForTimeout(700);
}

/** The panel is collapsed by default on narrow desktops. */
async function openAgent(page: Page) {
  const expand = page.locator('button[aria-label="展开 Agent 面板"]');
  if (await expand.isVisible()) await expand.click();
  await expect(page.locator('aside[aria-label="Agent 对话"]')).toBeVisible();
}

async function ask(page: Page, text: string) {
  const box = page.locator('aside[aria-label="Agent 对话"] textarea');
  await box.fill(text);
  await page.locator('aside[aria-label="Agent 对话"] button[type="submit"]').click();
}

test.describe('Agent canvas operations', () => {
  test.beforeEach(async ({ page }) => {
    await openStation(page);
    await openAgent(page);
  });

  test('proposes a plan and changes nothing until it is approved', async ({ page }) => {
    const before = await page.locator(NODES).count();

    await ask(page, '为这个 SKU 创建三台完整上新工作流');
    const card = page.locator(PLAN_CARD);
    await expect(card).toBeVisible({ timeout: 20_000 });

    // The card must spell out what it would do before anything happens.
    await expect(card).toContainText('新建');
    await expect(card.locator('[data-testid="plan-state"]')).toHaveText('待你确认');
    await expect(card.getByRole('button', { name: '应用到画布' })).toBeVisible();

    // ...and the canvas is untouched while the card sits there.
    expect(await page.locator(NODES).count()).toBe(before);

    await page.screenshot({ path: `${SHOTS}/agent-plan-proposed.png` });
  });

  test('previews on the canvas without creating shapes, then clears the preview', async ({
    page,
  }) => {
    const before = await page.locator(NODES).count();
    await ask(page, '为这个 SKU 创建三台完整上新工作流');
    const card = page.locator(PLAN_CARD);
    await expect(card).toBeVisible({ timeout: 20_000 });

    await card.getByRole('button', { name: '在画布预览' }).click();
    const preview = page.locator('[data-testid="agent-preview-layer"]');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('尚未应用');
    // A preview is not an application.
    expect(await page.locator(NODES).count()).toBe(before);

    await page.screenshot({ path: `${SHOTS}/agent-plan-preview.png` });

    await card.getByRole('button', { name: '结束预览' }).click();
    await expect(preview).toHaveCount(0);
  });

  test('applies the plan, reports only what happened, and undoes it fully', async ({ page }) => {
    const before = await page.locator(NODES).count();
    await ask(page, '为这个 SKU 创建三台完整上新工作流');
    const card = page.locator(PLAN_CARD);
    await expect(card).toBeVisible({ timeout: 20_000 });

    await card.getByRole('button', { name: '应用到画布' }).click();

    await expect(card.locator('[data-testid="plan-state"]')).toHaveText('已应用到画布');
    await expect(page.locator(NODES)).not.toHaveCount(before);

    // The activity message reports application, never generation.
    const log = page.locator('aside[aria-label="Agent 对话"]');
    await expect(log).toContainText('已应用到画布');
    await expect(log).toContainText('尚未生成任何内容');
    await expect(log).not.toContainText('已发布');

    await page.screenshot({ path: `${SHOTS}/agent-plan-applied.png` });

    await log.getByRole('button', { name: '撤销本次操作' }).click();
    await expect(log).toContainText('已撤销这次改动');
    // Every created shape is gone again.
    await expect(page.locator(NODES)).toHaveCount(before);
  });

  test('requires a second confirmation before anything can generate', async ({ page }) => {
    await ask(page, '为这个 SKU 创建三台完整上新工作流，并生成主图');
    const card = page.locator(PLAN_CARD);
    await expect(card).toBeVisible({ timeout: 20_000 });

    const runButton = card.getByRole('button', { name: '应用并运行' });
    if (await runButton.count()) {
      await runButton.click();
      const confirm = card.locator('[role="alertdialog"]');
      await expect(confirm).toBeVisible();
      await expect(confirm).toContainText('产生费用');
      await expect(confirm).toContainText('不会发布到任何平台');

      // Backing out must leave the canvas alone.
      await confirm.getByRole('button', { name: '返回' }).click();
      await expect(confirm).toHaveCount(0);
      await expect(card.locator('[data-testid="plan-state"]')).toHaveText('待你确认');
    }
  });

  test('runs the approved full workflow once from the SKU root', async ({ page }) => {
    let listingCalls = 0;
    let imageCalls = 0;
    let videoCalls = 0;

    await page.route('**/api/listing/generate', async route => {
      listingCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          data: {
            source: 'fallback',
            drafts: [
              { id: 'amazon', title: 'Amazon draft', fields: [], checks: [] },
              { id: 'tiktok', title: 'TikTok draft', fields: [], checks: [] },
              { id: 'shopify', title: 'Shopify draft', fields: [], checks: [] },
            ],
          },
        }),
      });
    });
    await page.route('**/api/media/image', async route => {
      imageCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 0, data: { url: '/station/cup-white.svg' } }),
      });
    });
    await page.route('**/api/media/video', async route => {
      videoCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 0, data: { url: '/station/demo-video.mp4' } }),
      });
    });

    await ask(
      page,
      '为这个 SKU 创建 Amazon、TikTok Shop 和 Shopify 完整上新工作流并生成视频',
    );
    const card = page.locator(PLAN_CARD);
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.getByRole('button', { name: '应用并运行' }).click();
    await card.getByRole('button', { name: '确认应用并运行' }).click();

    await expect(card.locator('[data-testid="plan-state"]')).toHaveText('已运行完成', {
      timeout: 20_000,
    });
    expect(listingCalls).toBe(1);
    expect(imageCalls).toBe(3);
    expect(videoCalls).toBe(1);
  });

  test('will not start generation from the activity row on a single click', async ({ page }) => {
    await ask(page, '为这个 SKU 创建三台完整上新工作流');
    const card = page.locator(PLAN_CARD);
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.getByRole('button', { name: '应用到画布' }).click();

    const log = page.locator('aside[aria-label="Agent 对话"]');
    await log.getByRole('button', { name: '运行这些节点' }).click();
    // The click only arms the action; it must not have called anything yet.
    await expect(log.getByRole('button', { name: '确认运行（会调用模型）' })).toBeVisible();
    await expect(log).not.toContainText('已触发这些节点的生成');

    await log.getByRole('button', { name: '取消' }).click();
    await expect(log.getByRole('button', { name: '运行这些节点' })).toBeVisible();
    await expect(log).not.toContainText('已触发这些节点的生成');
  });

  test('answers a question with text and no plan card', async ({ page }) => {
    await ask(page, '主图能加字吗');
    const log = page.locator('aside[aria-label="Agent 对话"]');
    await expect(log.locator('div').filter({ hasText: /加字|主图/ }).first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator(PLAN_CARD)).toHaveCount(0);
  });

  test('cancelling a plan retires the card and leaves the canvas untouched', async ({ page }) => {
    const before = await page.locator(NODES).count();
    await ask(page, '为这个 SKU 创建三台完整上新工作流');
    const card = page.locator(PLAN_CARD);
    await expect(card).toBeVisible({ timeout: 20_000 });

    await card.getByRole('button', { name: '取消' }).click();
    await expect(card.locator('[data-testid="plan-state"]')).toHaveText('已取消');
    await expect(card.getByRole('button', { name: '应用到画布' })).toHaveCount(0);
    expect(await page.locator(NODES).count()).toBe(before);
  });

  test('does not send image bytes to the Agent', async ({ page }) => {
    const bodies: string[] = [];
    page.on('request', request => {
      if (request.url().includes('/api/agent/chat')) bodies.push(request.postData() ?? '');
    });

    await ask(page, '为这个 SKU 创建三台完整上新工作流');
    await expect(page.locator(PLAN_CARD)).toBeVisible({ timeout: 20_000 });

    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body).not.toContain('base64');
      expect(body).not.toContain('data:image');
    }
  });
});
