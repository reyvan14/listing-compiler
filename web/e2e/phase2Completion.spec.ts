import { expect, test, type Page } from '@playwright/test';

// Phase 2 completion: the four capabilities, reached the way a user reaches
// them, from the station screen with nothing but clicks.
//
// The per-feature specs (storyboard, agentActions, feedbackCandidate,
// migrationCandidate) cover each workflow's internals. This file exists for the
// question the completion pass was actually about: can somebody *get to* these
// from the product, does the button call the real thing, and does the result
// claim only what happened? Each test therefore walks one whole path and
// asserts the honesty property at the end of it.
//
// Real: the planner, the action allow-list and ledger, the policy packs, the
// migration engine, the revision ledger, the feedback importer and detectors,
// the storyboard ledger. Mocked: the paid video provider, at the network
// boundary, because generating four clips costs money and reaches a third
// party. Nothing else is intercepted, and no application logic is bypassed.

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
  await page.waitForTimeout(1000);
}

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

async function openReview(page: Page, platform: string) {
  await bringIntoView(page, platform);
  await page
    .locator(`[data-testid="listing-result"][data-platform="${platform}"]`)
    .getByTestId('open-details')
    .click();
  await expect(page.locator('[data-testid="listing-inspector"]')).toBeVisible();
  await page.locator('[data-testid="inspector-tab"][data-tab="review"]').click();
  await expect(page.locator('[data-testid="review-tab"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('review-revision-id')).not.toBeEmpty();
}

async function approve(page: Page, title?: string): Promise<string> {
  await openReview(page, 'amazon');
  if (title) {
    await page.getByTestId('review-title-input').fill(title);
    await page.getByTestId('review-save').click();
    await expect(page.getByTestId('review-dirty')).toHaveCount(0);
  }
  await page.getByTestId('review-validate').click();
  await expect(page.getByTestId('review-state')).toHaveText('校验通过');
  await page.getByTestId('review-operator').fill('lottie');
  await page.getByTestId('review-reason').fill('已核对');
  await page.getByTestId('review-approve').click();
  await expect(page.getByTestId('review-state')).toHaveText('已批准');
  const id = (await page.getByTestId('review-revision-id').textContent())!.trim();
  await page.getByTestId('inspector-close').click();
  return id;
}

const agent = (page: Page) => page.locator('aside[aria-label="Agent 对话"]');

async function ask(page: Page, text: string) {
  const expand = page.getByRole('button', { name: '展开 Agent 面板' });
  if (await expand.isVisible().catch(() => false)) await expand.click();
  await expect(agent(page)).toBeVisible();
  const input = agent(page).locator('textarea');
  await input.fill(text);
  await input.press('Enter');
}

// --------------------------------------------------------------------------- //
// Flow A — storyboard                                                          //
// --------------------------------------------------------------------------- //

test('A. a storyboard is reachable from a video node and reports only shots it made', async ({
  page,
}, testInfo) => {
  await waitForStation(page);
  await page.click('#station-fill');
  await page.waitForTimeout(200);
  await page.locator('[class*="railAdd"]').first().click();
  await page.getByRole('button', { name: '视频' }).first().click();
  await page.waitForTimeout(600);

  // The whole workflow hangs off one button on the node.
  await page.getByTestId('open-storyboard').first().click();
  await expect(page.getByTestId('storyboard-panel')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('storyboard-shot')).toHaveCount(4);

  const calls: string[] = [];
  await page.route('**/api/media/video', async route => {
    const body = route.request().postDataJSON() as { prompt?: string };
    calls.push(body?.prompt ?? '');
    // one clip per shot, and the last one fails
    const fail = calls.length === 4;
    await route.fulfill({
      status: fail ? 502 : 200,
      contentType: 'application/json',
      body: fail
        ? JSON.stringify({ code: 1, error: 'provider_failure', message: '模型服务暂时不可用' })
        : JSON.stringify({ code: 0, data: { url: `https://mock.invalid/${calls.length}.mp4` } }),
    });
  });

  await page.getByTestId('storyboard-preview-plan').click();
  await expect(page.getByTestId('storyboard-confirm')).toContainText('付费生成调用');
  await page.getByTestId('storyboard-confirm-yes').click();

  // 3 of 4 — not "done", not a percentage, not a timer
  await expect(page.getByTestId('storyboard-progress')).toContainText('3/4', { timeout: 30_000 });
  await expect(page.getByTestId('storyboard-progress')).not.toContainText('%');
  expect(calls).toHaveLength(4);

  await page.getByTestId('storyboard-load-package').click();
  // No composition step ran, so there is no finished film. The note may say
  // composition is unavailable or that the locally detected FFmpeg can be used;
  // neither state may present four clips as one finished video.
  await expect(page.getByTestId('storyboard-final-video')).toHaveCount(0);
  await expect(page.getByTestId('storyboard-not-composed')).toContainText(
    /不会声称已合成成片|可尝试合成最终成片/,
  );

  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-p2-A-storyboard.png` });
});

// --------------------------------------------------------------------------- //
// Flow B — agent domain action                                                 //
// --------------------------------------------------------------------------- //

test('B. an Agent plan runs a confirmed domain action and reports its real result', async ({
  page,
}, testInfo) => {
  await waitForStation(page);
  await generate(page);
  const approved = await approve(page);

  await ask(page, '校验文案');
  // The planner declines rather than invent a revision id it cannot know.
  await expect(agent(page)).toContainText('校验', { timeout: 20_000 });
  // The user message itself also contains 校验; wait for the streamed turn to
  // finish before submitting the next request.
  await expect(agent(page).getByRole('button', { name: '发送' })).toBeVisible({ timeout: 20_000 });

  await ask(page, '生成发布护照');
  const action = page.getByTestId('agent-action').first();
  await expect(action).toBeVisible({ timeout: 20_000 });
  // Proposed only — approving the plan is a separate decision.
  await expect(page.getByTestId('agent-action-run')).toHaveCount(0);

  await page.getByTestId('plan-approve').click();
  await page.getByTestId('agent-action-run').click();
  const result = action.getByTestId('agent-action-result');
  await expect(result).toContainText('已执行', { timeout: 20_000 });
  // A readiness verdict computed from the real records, not a claim of success.
  await expect(result).toContainText('就绪状态');
  expect(approved).toMatch(/^rev-/);

  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-p2-B-agent.png` });
});

// --------------------------------------------------------------------------- //
// Flow C — feedback signal to listing candidate                                //
// --------------------------------------------------------------------------- //

test('C. a feedback signal becomes a candidate revision and opens in review', async ({
  page,
}, testInfo) => {
  await waitForStation(page);
  await generate(page);
  const approved = await approve(page);

  await page.click('#station-feedback');
  await expect(page.getByTestId('feedback-panel')).toBeVisible();
  await page.getByTestId('feedback-file').setInputFiles({
    name: 'aug.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      'sku,platform,revision_id,period_start,period_end,impressions,clicks,add_to_cart,purchases,revenue,returns,return_reason,review_text,rating\n' +
        `AERO-350,amazon,${approved},2026-08-01,2026-08-14,12000,60,10,4,119.60,0,,,4\n`,
      'utf-8',
    ),
  });
  await expect(page.getByTestId('feedback-signal')).toHaveCount(1);

  await page.getByTestId('feedback-prepare-candidate').click();
  await page.getByTestId('feedback-draft-title').fill('折叠硅胶水杯 350ml 食品级硅胶 可放洗碗机');
  await page.getByTestId('feedback-operator').fill('lottie');
  await page.getByTestId('feedback-create-candidate').click();

  const created = page.getByTestId('feedback-created');
  await expect(created).toBeVisible({ timeout: 15_000 });
  const candidate = (await created.locator('code').first().textContent())!.trim();
  expect(candidate).not.toBe(approved);

  await page.getByTestId('feedback-open-review').click();
  await expect(page.getByTestId('review-revision-id')).toHaveText(candidate, { timeout: 15_000 });
  await expect(page.getByTestId('review-state')).toHaveText('草稿');
  await expect(page.getByTestId('review-diff-panel')).toContainText(approved);
  // the approved revision is still the approved one
  await expect(
    page.getByTestId('review-history').locator('li', { hasText: approved }),
  ).toContainText('已批准');

  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-p2-C-feedback.png` });
});

// --------------------------------------------------------------------------- //
// Flow D — Agent-built migration candidate                                     //
// --------------------------------------------------------------------------- //

const OVERLONG_TITLE =
  'Collapsible Silicone Travel Cup 350ml Leakproof Lid Carry Loop Dishwasher Safe ' +
  'BPA Free Food Grade Foldable Camping Office Water Bottle Reusable Outdoor Hiking ' +
  'Gym Portable Drinkware Set Compact Design Easy Clean';

test('D. an Agent-built migration candidate is reviewed and applied without touching the approved copy', async ({
  page,
}, testInfo) => {
  await waitForStation(page);
  await generate(page);
  const approved = await approve(page, OVERLONG_TITLE);

  await ask(page, '生成迁移候选');
  await expect(page.getByTestId('agent-action').first()).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('plan-approve').click();
  await page.getByTestId('agent-action-request').click();
  await page.getByTestId('agent-action-confirm-yes').click();
  await expect(page.getByTestId('agent-action-result')).toContainText('候选 mig-', {
    timeout: 20_000,
  });

  await page.getByTestId('agent-action-open').click();
  const stored = page.locator('[data-testid="stored-candidate"]');
  await expect(stored).toBeVisible({ timeout: 15_000 });
  await expect(stored).toHaveAttribute('data-state', 'built');
  await expect(page.getByTestId('stored-candidate-evidence')).toContainText(approved);

  await page.getByTestId('stored-candidate-tick').check();
  await page.getByTestId('stored-candidate-operator').fill('lottie');
  await page.getByTestId('stored-candidate-reason').fill('规则收紧后迁移标题');
  await page.getByTestId('stored-candidate-apply').click();
  await page.getByTestId('stored-candidate-confirm').click();
  await expect(stored).toHaveAttribute('data-state', 'applied', { timeout: 15_000 });
  await expect(page.getByTestId('stored-candidate-applied')).toContainText('原修订未被改动');

  await page.locator('#migration-panel').getByRole('button', { name: '关闭' }).click();
  await openReview(page, 'amazon');
  const history = page.getByTestId('review-history');
  await expect(history.locator('li', { hasText: approved })).toContainText('已批准');
  // exactly one approved revision: a migration produced a draft, not a release
  await expect(history.locator('li', { hasText: '已批准' })).toHaveCount(1);

  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-p2-D-migration.png` });
});
