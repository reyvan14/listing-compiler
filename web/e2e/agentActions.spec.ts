import { expect, test, type Page } from '@playwright/test';

// Typed domain actions, driven from the Agent conversation.
//
// The Agent, the plan validator, the action allow-list and the execution ledger
// are all the real ones — no model is configured, so the deterministic planner
// answers, which is exactly the path a reviewer can reproduce. The only
// interception is at the network boundary, and only where a test needs to force
// a specific failure.

const SHOTS = 'e2e/screenshots';

function tag(testInfo: { project: { name: string } }) {
  return testInfo.project.name;
}

async function waitForStation(page: Page) {
  await page.goto('/');
  await page.waitForSelector('#station-generate', { timeout: 20_000 });
  await page.waitForTimeout(900);
}

const agent = (page: Page) => page.locator('aside[aria-label="Agent 对话"]');

async function ensureAgentOpen(page: Page) {
  const expand = page.getByRole('button', { name: '展开 Agent 面板' });
  if (await expand.isVisible().catch(() => false)) await expand.click();
  await expect(agent(page)).toBeVisible();
}

async function ask(page: Page, text: string) {
  const input = agent(page).locator('textarea');
  await input.fill(text);
  await input.press('Enter');
}

async function generateListings(page: Page) {
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
  await page.waitForTimeout(800);
}

// --------------------------------------------------------------------------- //

test('a domain action is proposed as a typed card, not executed on sight', async ({
  page,
}, testInfo) => {
  await waitForStation(page);
  await generateListings(page);
  await ensureAgentOpen(page);

  await ask(page, '帮我生成发布护照');

  const action = page.getByTestId('agent-action').first();
  await expect(action).toBeVisible({ timeout: 20_000 });
  await expect(action).toHaveAttribute('data-action', 'build_release_passport');
  await expect(action).toContainText('生成发布护照');
  await expect(action.getByTestId('agent-action-target')).toContainText('平台 amazon');
  await expect(action).toContainText('会读取');
  await expect(action).toContainText('预期结果');
  // Approving the plan is a separate decision; nothing runs yet.
  await expect(page.getByTestId('agent-action-run')).toHaveCount(0);
  await expect(page.getByTestId('agent-action-list')).toContainText('批准计划后可执行');

  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-agent-action-01-proposed.png` });
});

test('a read-only action runs after plan approval without a second confirmation', async ({
  page,
}, testInfo) => {
  await waitForStation(page);
  await generateListings(page);
  await ensureAgentOpen(page);
  await ask(page, '分析政策影响');

  const action = page.getByTestId('agent-action').first();
  await expect(action).toBeVisible({ timeout: 20_000 });
  await expect(action).toContainText('只读');

  // approve the plan itself
  await page.getByTestId('plan-approve').click();
  await expect(page.getByTestId('agent-action-run')).toBeVisible();

  await page.getByTestId('agent-action-run').click();
  await expect(action.getByTestId('agent-action-result')).toContainText('已执行', {
    timeout: 20_000,
  });
  await expect(action).toHaveAttribute('data-state', 'ok');
  await expect(agent(page)).toContainText('已执行「分析政策影响面」');

  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-agent-action-02-executed.png` });
});

test('a state-changing action is labelled and reports its real result', async ({ page }) => {
  await waitForStation(page);
  await generateListings(page);
  await ensureAgentOpen(page);
  await ask(page, '帮我生成发布护照');

  const action = page.getByTestId('agent-action').first();
  await expect(action).toBeVisible({ timeout: 20_000 });
  await expect(action).toContainText('会改动状态');

  await page.getByTestId('plan-approve').click();
  await page.getByTestId('agent-action-run').click();

  // The passport really is blocked here: nothing has been approved yet, so the
  // honest result is a blocked readiness rather than a success message.
  await expect(action.getByTestId('agent-action-result')).toContainText('就绪状态', {
    timeout: 20_000,
  });
  await expect(action.getByTestId('agent-action-result')).toContainText('blocked');
});

test('a state-writing action demands its own confirmation and can be declined', async ({
  page,
}, testInfo) => {
  await waitForStation(page);
  await generateListings(page);
  await ensureAgentOpen(page);
  await ask(page, '生成迁移候选补丁');

  const action = page.getByTestId('agent-action').first();
  await expect(action).toBeVisible({ timeout: 20_000 });
  // It calls no model, so it must not be dressed up as costing money — but it
  // writes a record, so it still asks a second time.
  await expect(action.getByTestId('agent-action-paid')).toHaveCount(0);
  await expect(action).toContainText('会改动状态');
  await expect(action).toContainText('需二次确认');

  await page.getByTestId('plan-approve').click();
  await expect(page.getByTestId('agent-action-run')).toHaveCount(0);

  await page.getByTestId('agent-action-request').click();
  const confirm = page.getByTestId('agent-action-confirm');
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('不调用模型');
  await expect(confirm).toContainText('已批准内容不会被改写');
  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-agent-action-03-confirm.png` });

  // declining runs nothing
  await page.getByTestId('agent-action-confirm-no').click();
  await expect(confirm).toHaveCount(0);
  await expect(action.getByTestId('agent-action-result')).toHaveCount(0);

  await page.getByTestId('agent-action-request').click();
  await page.getByTestId('agent-action-confirm-yes').click();
  await expect(action.getByTestId('agent-action-result')).toContainText('已执行', {
    timeout: 20_000,
  });
});

test('retrying the same action does not run it twice', async ({ page }) => {
  await waitForStation(page);
  await generateListings(page);
  await ensureAgentOpen(page);
  await ask(page, '分析政策影响');

  await expect(page.getByTestId('agent-action').first()).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('plan-approve').click();

  let runCalls = 0;
  await page.route('**/api/agent/actions/run', async route => {
    runCalls += 1;
    await route.continue();
  });

  const button = page.getByTestId('agent-action-run');
  await button.click();
  await expect(page.getByTestId('agent-action-result')).toContainText('已执行', {
    timeout: 20_000,
  });

  // The ledger is scoped per workspace + product, so the probe has to carry the
  // same headers the app sends — an unscoped read would look empty and prove
  // nothing.
  const history = await page.evaluate(async () => {
    const workspace = localStorage.getItem('listing.evidence.workspace.v1') ?? '';
    const sku = (window as unknown as { editor: any }).editor
      .getCurrentPageShapes()
      .find((s: any) => s.props?.node?.type === 'sku_listing');
    const product = sku
      ? `${sku.id}|${String(sku.props.node.productName ?? '').trim().toLowerCase()}`
      : 'default-product';
    const res = await fetch('/api/agent/actions/history', {
      headers: {
        'X-Workspace-ID': workspace,
        'X-Product-ID': encodeURIComponent(product).slice(0, 512),
      },
    });
    const body = await res.json();
    return body.data.runs.filter((r: any) => r.action === 'analyze_policy_impact').length;
  });
  expect(history).toBe(1);
  expect(runCalls).toBeGreaterThan(0);
});

test('a backend failure is shown as an actionable message, not a silent nothing', async ({
  page,
}) => {
  await waitForStation(page);
  await generateListings(page);
  await ensureAgentOpen(page);
  await ask(page, '分析政策影响');

  await expect(page.getByTestId('agent-action').first()).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('plan-approve').click();

  await page.route('**/api/agent/actions/run', route => route.abort('failed'));
  await page.getByTestId('agent-action-run').click();

  await expect(page.getByTestId('agent-action-result')).toContainText('无法连接后端服务', {
    timeout: 20_000,
  });
  await expect(agent(page)).not.toContainText('Failed to fetch');
});

test('the Agent still creates and fills a canvas workflow, with the run confirmation', async ({
  page,
}) => {
  await waitForStation(page);
  await ensureAgentOpen(page);
  await ask(page, '三平台完整工作流（含短视频）');

  await expect(page.getByTestId('plan-state')).toBeVisible({ timeout: 20_000 });
  // canvas operations, not domain actions
  await expect(page.getByTestId('agent-action')).toHaveCount(0);

  await page.getByRole('button', { name: '创建并生成' }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('生成');
});
