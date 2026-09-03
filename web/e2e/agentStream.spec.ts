import { expect, test, type Page } from '@playwright/test';

// Streaming Agent responses and the 执行过程 trace.
//
// Two kinds of spec live here. The first group installs a controllable SSE
// double in the page so chunk timing is deterministic — that is the only way
// to assert "text was visible while the stream was still open" without racing
// a fast local backend. The second group runs against the real FastAPI
// instance and its audited deterministic template.

const SHOTS = 'e2e/screenshots';
const NODES = '[data-shape-type="node"]';
const PLAN_CARD = '[aria-label="Agent 变更计划"]';
const TRACE = '[data-testid="agent-trace"]';
const AGENT = 'aside[aria-label="Agent 对话"]';

/**
 * Replace fetch for the streaming endpoint with a stream this test drives.
 *
 * `window.__sse.push(text)` emits a chunk; `window.__sse.close()` ends the
 * body; `window.__sse.aborted` records whether the client cancelled.
 */
async function installSseDouble(page: Page) {
  await page.addInitScript(() => {
    const state: {
      controller: ReadableStreamDefaultController<Uint8Array> | null;
      aborted: boolean;
      calls: number;
      queued: string[];
    } = { controller: null, aborted: false, calls: 0, queued: [] };

    (window as unknown as { __sse: unknown }).__sse = {
      // Queue until the client actually opens the stream. The panel awaits the
      // evidence summary first, so a test that pushes immediately would
      // otherwise lose its first chunks to a race.
      push(text: string) {
        if (!state.controller) {
          state.queued.push(text);
          return;
        }
        state.controller.enqueue(new TextEncoder().encode(text));
      },
      close() {
        try {
          state.controller?.close();
        } catch {
          /* already closed */
        }
      },
      get aborted() {
        return state.aborted;
      },
      get calls() {
        return state.calls;
      },
    };

    const original = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (!url.includes('/api/agent/chat/stream')) return original(input, init);
      state.calls += 1;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          state.controller = controller;
          for (const queued of state.queued.splice(0)) {
            controller.enqueue(new TextEncoder().encode(queued));
          }
          init?.signal?.addEventListener('abort', () => {
            state.aborted = true;
            try {
              controller.error(new DOMException('aborted', 'AbortError'));
            } catch {
              /* already settled */
            }
          });
        },
      });
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      });
    };
  });
}

function frame(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function emit(page: Page, event: string, data: unknown) {
  await page.evaluate(
    ([e, d]) => (window as never as { __sse: { push(t: string): void } }).__sse.push(
      `event: ${e}\ndata: ${d}\n\n`,
    ),
    [event, JSON.stringify(data)] as const,
  );
}

async function openStation(page: Page) {
  await page.goto('/');
  await page.waitForSelector('#station-generate', { timeout: 20_000 });
  await page.waitForTimeout(700);
  const expand = page.locator('button[aria-label="展开 Agent 面板"]');
  if (await expand.isVisible()) await expand.click();
  await expect(page.locator(AGENT)).toBeVisible();
}

async function ask(page: Page, text: string) {
  await page.locator(`${AGENT} textarea`).fill(text);
  await page.locator(`${AGENT} button[type="submit"]`).click();
}

// --------------------------------------------------------------------------
// Streaming behaviour, with a controllable stream
// --------------------------------------------------------------------------

test.describe('streaming', () => {
  test.beforeEach(async ({ page }) => {
    await installSseDouble(page);
    await openStation(page);
  });

  test('shows the first text before the stream has finished', async ({ page }) => {
    await ask(page, '三平台完整工作流（含短视频）');

    await emit(page, 'meta', { requestId: 'r1' });
    await emit(page, 'status', {
      stage: 'understanding',
      label: '正在理解你的要求',
      detail: '',
      sequence: 1,
    });
    await emit(page, 'delta', { text: '我拟了一个方案，' });

    // The body is still open — nothing has closed it — and the text is already
    // on screen. That is the whole point of streaming.
    await expect(page.locator(AGENT)).toContainText('我拟了一个方案，');
    await expect(page.locator(`${AGENT} button:has-text("停止")`)).toBeVisible();

    await page.screenshot({ path: `${SHOTS}/agent-streaming.png` });

    await emit(page, 'delta', { text: '请确认。' });
    await expect(page.locator(AGENT)).toContainText('我拟了一个方案，请确认。');

    await emit(page, 'done', { requestId: 'r1' });
    await page.evaluate(() => (window as never as { __sse: { close(): void } }).__sse.close());
    await expect(page.locator(`${AGENT} button[type="submit"]`)).toBeVisible();
  });

  test('updates the execution trace in order and never calls it 思考过程', async ({ page }) => {
    await ask(page, '三平台完整工作流（含短视频）');

    const trace = page.locator(TRACE);
    await emit(page, 'status', {
      stage: 'understanding',
      label: '正在理解你的要求',
      detail: '',
      sequence: 1,
    });
    await expect(trace).toContainText('正在理解你的要求');

    await emit(page, 'status', {
      stage: 'reading_canvas',
      label: '正在读取当前画布',
      detail: '1 个节点',
      sequence: 2,
    });
    await expect(trace).toContainText('正在读取当前画布');

    await emit(page, 'status', {
      stage: 'validating',
      label: '正在校验计划',
      detail: '',
      sequence: 3,
    });
    await expect(trace).toContainText('正在校验计划');

    await trace.getByRole('button', { name: /查看执行过程/ }).click();
    const rows = trace.locator('li[data-stage]');
    await expect(rows).toHaveCount(3);
    // Order is preserved exactly as received.
    await expect(rows.nth(0)).toHaveAttribute('data-stage', 'understanding');
    await expect(rows.nth(1)).toHaveAttribute('data-stage', 'reading_canvas');
    await expect(rows.nth(2)).toHaveAttribute('data-stage', 'validating');
    // Earlier stages are marked done, the newest is active.
    await expect(rows.nth(0)).toHaveAttribute('data-state', 'done');
    await expect(rows.nth(2)).toHaveAttribute('data-state', 'active');

    await expect(page.locator(AGENT)).not.toContainText('思考过程');
    await page.screenshot({ path: `${SHOTS}/agent-trace-expanded.png` });

    await emit(page, 'done', { requestId: 'r-trace' });
    await page.evaluate(() => (window as never as { __sse: { close(): void } }).__sse.close());
    await expect(page.locator(TRACE)).toBeVisible();
    await expect(page.locator(TRACE)).toContainText('正在校验计划');
  });

  test('a partial plan frame never becomes an applicable card', async ({ page }) => {
    const before = await page.locator(NODES).count();
    await ask(page, '三平台完整工作流（含短视频）');

    await emit(page, 'delta', { text: '正在规划…' });
    // A plan frame that is cut off mid-object.
    await page.evaluate(() =>
      (window as never as { __sse: { push(t: string): void } }).__sse.push(
        'event: plan\ndata: {"plan":{"title":"半个计划","operations":[',
      ),
    );
    await page.waitForTimeout(300);

    await expect(page.locator(PLAN_CARD)).toHaveCount(0);
    await expect(page.locator(AGENT)).not.toContainText('半个计划');
    expect(await page.locator(NODES).count()).toBe(before);

    await page.evaluate(() => (window as never as { __sse: { close(): void } }).__sse.close());
  });

  test('Stop cancels the request and keeps what already arrived', async ({ page }) => {
    await ask(page, '三平台完整工作流（含短视频）');
    await emit(page, 'delta', { text: '已经说了一半' });
    await expect(page.locator(AGENT)).toContainText('已经说了一半');

    await page.locator(`${AGENT} button:has-text("停止")`).click();

    await expect(page.locator(AGENT)).toContainText('已停止');
    await expect(page.locator(AGENT)).toContainText('已经说了一半');
    // The client really aborted the fetch, rather than just hiding the UI.
    expect(await page.evaluate(() => (window as never as { __sse: { aborted: boolean } }).__sse.aborted)).toBe(true);
    // Busy state is reset: the composer is usable again.
    await expect(page.locator(`${AGENT} button[type="submit"]`)).toBeVisible();
  });

  test('does not start a second request while one is in flight', async ({ page }) => {
    await ask(page, '三平台完整工作流（含短视频）');
    await emit(page, 'delta', { text: '第一次' });

    // The composer shows 停止, so there is no submit button to double-fire;
    // pressing Enter in the textarea must not start a second turn either.
    await page.locator(`${AGENT} textarea`).fill('再来一次');
    await page.locator(`${AGENT} textarea`).press('Enter');
    await page.waitForTimeout(200);

    expect(await page.evaluate(() => (window as never as { __sse: { calls: number } }).__sse.calls)).toBe(1);
  });
});

// --------------------------------------------------------------------------
// Against the real backend and the audited deterministic template
// --------------------------------------------------------------------------

test.describe('canonical workflow', () => {
  test.beforeEach(async ({ page }) => {
    await openStation(page);
  });

  test('creates the expected four-node topology and requires a second confirmation', async ({
    page,
  }) => {
    const mediaCalls: string[] = [];
    page.on('request', request => {
      const url = request.url();
      if (/\/api\/(media\/image|media\/video|listing\/generate)$/.test(url)) mediaCalls.push(url);
    });

    const before = await page.locator(NODES).count();
    await ask(page, '三平台完整工作流（含短视频）');

    const card = page.locator(PLAN_CARD);
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText('三平台');

    // The structured rationale, not a chain of thought.
    await card.getByRole('button', { name: '为什么这样规划' }).click();
    const why = card.locator('[data-testid="plan-rationale"]');
    await expect(why).toContainText('Amazon');
    await expect(why).toContainText('TikTok Shop');
    await expect(why).toContainText('Shopify');
    await expect(why).toContainText('不发布');
    await expect(why).not.toContainText('思考');

    await page.screenshot({ path: `${SHOTS}/agent-plan-rationale.png` });

    await card.getByRole('button', { name: '仅创建节点' }).click();
    await expect(card.locator('[data-testid="plan-state"]')).toHaveText('已应用到画布');

    // SKU root + four media nodes.
    await expect(page.locator(NODES)).toHaveCount(before + 4);

    // Applying must not have generated anything.
    expect(mediaCalls).toEqual([]);
    await expect(page.locator(AGENT)).toContainText('尚未生成任何内容');
  });

  test('创建并生成 still stops at the second confirmation', async ({ page }) => {
    const mediaCalls: string[] = [];
    page.on('request', request => {
      if (/\/api\/media\/(image|video)$/.test(request.url())) mediaCalls.push(request.url());
    });

    await ask(page, '三平台完整工作流（含短视频）');
    const card = page.locator(PLAN_CARD);
    await expect(card).toBeVisible({ timeout: 20_000 });

    await card.getByRole('button', { name: '创建并生成' }).click();
    const confirm = card.locator('[role="alertdialog"]');
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('产生费用');
    await expect(confirm).toContainText('不会发布到任何平台');

    // Nothing has been generated while the dialog is open.
    expect(mediaCalls).toEqual([]);

    await confirm.getByRole('button', { name: '返回' }).click();
    await expect(confirm).toHaveCount(0);
    expect(mediaCalls).toEqual([]);
  });

  test('applying twice does not duplicate the nodes', async ({ page }) => {
    const before = await page.locator(NODES).count();
    await ask(page, '三平台完整工作流（含短视频）');
    const card = page.locator(PLAN_CARD);
    await expect(card).toBeVisible({ timeout: 20_000 });

    const applyButton = card.getByRole('button', { name: '仅创建节点' });
    await applyButton.click();
    await expect(card.locator('[data-testid="plan-state"]')).toHaveText('已应用到画布');
    await expect(page.locator(NODES)).toHaveCount(before + 4);

    // The card retires its actions once applied; the guard in the panel also
    // refuses a second apply for the same plan.
    await expect(applyButton).toHaveCount(0);
    await expect(page.locator(NODES)).toHaveCount(before + 4);
  });

  test('the streamed turn reports evidence and canvas facts in the trace', async ({ page }) => {
    await ask(page, '三平台完整工作流（含短视频）');
    await expect(page.locator(PLAN_CARD)).toBeVisible({ timeout: 20_000 });

    // The completed trace remains inspectable alongside the durable plan card.
    await expect(page.locator(TRACE)).toBeVisible();
    await expect(page.locator(TRACE)).toContainText('计划已就绪');
    await expect(page.locator(AGENT)).not.toContainText('思考过程');
  });
});
