import { expect, test, type Page } from '@playwright/test';

// Agent action → stored migration candidate → reviewed apply → rollback.
//
// Every part is real: the deterministic planner, the action allow-list, the
// policy snapshots shipped in the repo, the migration engine, the revision
// ledger. No model is configured and no provider is intercepted — there is
// nothing external on this path to mock.
//
// The property under test is that building and applying stay two decisions,
// and that neither of them can touch an approved listing.

const SHOTS = 'e2e/screenshots';

// 212 characters: clean by the review checker, over the 200-character cap in
// the amazon-us-2025.01.21 snapshot. That gap is what a migration is for — copy
// that was legitimately approved and that a later rule now trims.
const OVERLONG_TITLE =
  'Collapsible Silicone Travel Cup 350ml Leakproof Lid Carry Loop Dishwasher Safe ' +
  'BPA Free Food Grade Foldable Camping Office Water Bottle Reusable Outdoor Hiking ' +
  'Gym Portable Drinkware Set Compact Design Easy Clean';

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

/** An approved Amazon revision whose title the current policy pack would trim. */
async function approveOverlongTitle(page: Page): Promise<string> {
  await openReview(page, 'amazon');
  await page.getByTestId('review-title-input').fill(OVERLONG_TITLE);
  await page.getByTestId('review-save').click();
  await expect(page.getByTestId('review-dirty')).toHaveCount(0);
  await page.getByTestId('review-validate').click();
  await expect(page.getByTestId('review-state')).toHaveText('校验通过');
  await page.getByTestId('review-operator').fill('lottie');
  await page.getByTestId('review-reason').fill('标题已按当时规则核对');
  await page.getByTestId('review-approve').click();
  await expect(page.getByTestId('review-state')).toHaveText('已批准');
  const id = (await page.getByTestId('review-revision-id').textContent())!.trim();
  await page.getByTestId('inspector-close').click();
  return id;
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

/** Plan → approve → confirm → run, the whole real gate sequence. */
async function buildCandidateViaAgent(page: Page) {
  await ensureAgentOpen(page);
  await ask(page, '生成迁移候选');
  const action = page.getByTestId('agent-action').first();
  await expect(action).toBeVisible({ timeout: 20_000 });
  await expect(action).toHaveAttribute('data-action', 'build_migration_candidate');
  await page.getByTestId('plan-approve').click();
  await page.getByTestId('agent-action-request').click();
  await page.getByTestId('agent-action-confirm-yes').click();
  await expect(page.getByTestId('agent-action-result')).toBeVisible({ timeout: 20_000 });
}

/**
 * Assert, through the UI, that `approved` is still the one approved revision
 * and still holds `title`.
 *
 * Deliberately not "reopen the tab and read the title box": reopening the
 * review tab bootstraps a fresh draft from whatever the canvas holds, so the
 * box shows that draft, not the approved copy. The history list and a diff
 * against it are what actually speak for the stored revision.
 */
async function expectStillApproved(page: Page, approved: string, title: string) {
  await openReview(page, 'amazon');
  const history = page.getByTestId('review-history');
  await expect(history.locator('li', { hasText: approved })).toContainText('已批准');
  await expect(history.locator('li', { hasText: '已批准' })).toHaveCount(1);
  await page.locator(`[data-testid="review-diff"][data-revision="${approved}"]`).click();
  const diff = page.getByTestId('review-diff-panel');
  await expect(diff).toBeVisible();
  await expect(diff).toContainText(title.slice(0, 60));
  await page.getByTestId('inspector-close').click();
}

const stored = (page: Page) => page.locator('[data-testid="stored-candidate"]');

// --------------------------------------------------------------------------- //

test('the action builds a real candidate and hands it to the migration panel', async ({
  page,
}, testInfo) => {
  await waitForStation(page);
  await generate(page);
  const approved = await approveOverlongTitle(page);
  await buildCandidateViaAgent(page);

  // the reply names the real artefact, not a promise to build one
  const result = page.getByTestId('agent-action-result');
  await expect(result).toContainText('候选 mig-');
  await expect(result).toContainText('1 项补丁');
  await expect(result).toContainText('title');
  await expect(result).toContainText('尚未应用');

  await page.getByTestId('agent-action-open').click();
  await expect(stored(page)).toBeVisible({ timeout: 15_000 });
  await expect(stored(page)).toHaveAttribute('data-state', 'built');

  // the rule change it answers, and the records it was computed from
  await expect(page.getByTestId('stored-candidate-policy')).toContainText(
    'amazon-us-pre-2025.01.21',
  );
  await expect(page.getByTestId('stored-candidate-policy')).toContainText('amazon-us-2025.01.21');
  await expect(page.getByTestId('stored-candidate-provenance')).toContainText(
    'build_migration_candidate',
  );
  await expect(page.getByTestId('stored-candidate-evidence')).toContainText(approved);

  // a real patch from the real engine
  const patch = page.getByTestId('stored-candidate-patch');
  await expect(patch).toHaveCount(1);
  await expect(patch).toHaveAttribute('data-patch', `${approved}:title`);
  await expect(page.getByTestId('stored-candidate-before')).toContainText(
    OVERLONG_TITLE.slice(0, 40),
  );
  const after = (await page.getByTestId('stored-candidate-after').textContent())!;
  expect(after.length).toBeLessThan(OVERLONG_TITLE.length);

  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-migcand-01-built.png` });
});

test('building changes nothing; applying needs a tick, a name, a reason and a confirmation', async ({
  page,
}) => {
  await waitForStation(page);
  await generate(page);
  const approved = await approveOverlongTitle(page);
  await buildCandidateViaAgent(page);
  await page.getByTestId('agent-action-open').click();
  await expect(stored(page)).toBeVisible({ timeout: 15_000 });

  // nothing is pre-ticked and nothing can be applied yet
  await expect(page.getByTestId('stored-candidate-tick')).not.toBeChecked();
  await expect(page.getByTestId('stored-candidate-apply')).toBeDisabled();

  await page.getByTestId('stored-candidate-tick').check();
  await expect(page.getByTestId('stored-candidate-apply')).toBeDisabled();
  await page.getByTestId('stored-candidate-operator').fill('lottie');
  await expect(page.getByTestId('stored-candidate-apply')).toBeDisabled();
  await page.getByTestId('stored-candidate-reason').fill('规则收紧后迁移标题');
  await expect(page.getByTestId('stored-candidate-apply')).toBeEnabled();

  // and it still asks once more before writing anything
  await page.getByTestId('stored-candidate-apply').click();
  await expect(page.getByTestId('stored-candidate-confirm-prompt')).toContainText('草稿');
  await page.getByTestId('stored-candidate-cancel').click();
  await expect(page.getByTestId('stored-candidate-confirm')).toHaveCount(0);

  // the approved revision is untouched by everything above
  await page.getByTestId('stored-candidate-dismiss').click();
  await page.locator('#migration-panel').getByRole('button', { name: '关闭' }).click();
  await expectStillApproved(page, approved, OVERLONG_TITLE);
});

test('applying forks a draft, keeps the approved copy live, and can be rolled back', async ({
  page,
}, testInfo) => {
  await waitForStation(page);
  await generate(page);
  const approved = await approveOverlongTitle(page);
  await buildCandidateViaAgent(page);
  await page.getByTestId('agent-action-open').click();
  await expect(stored(page)).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('stored-candidate-tick').check();
  await page.getByTestId('stored-candidate-operator').fill('lottie');
  await page.getByTestId('stored-candidate-reason').fill('规则收紧后迁移标题');
  await page.getByTestId('stored-candidate-apply').click();
  await page.getByTestId('stored-candidate-confirm').click();

  await expect(stored(page)).toHaveAttribute('data-state', 'applied', { timeout: 15_000 });
  const applied = page.getByTestId('stored-candidate-applied');
  await expect(applied).toContainText(approved);
  await expect(applied).toContainText('原修订未被改动');
  await expect(page.getByTestId('stored-candidate-notice')).toContainText('原已批准修订保持不变');
  const draftId = (await applied.locator('code').nth(1).textContent())!.trim();
  expect(draftId).not.toBe(approved);
  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-migcand-02-applied.png` });

  // the approved revision still holds the original copy, and the migrated
  // draft sits beside it awaiting the normal gate
  await page.locator('#migration-panel').getByRole('button', { name: '关闭' }).click();
  await openReview(page, 'amazon');
  await expect(
    page.getByTestId('review-history').locator('li', { hasText: draftId }),
  ).toContainText('草稿');
  await expect(
    page.getByTestId('review-history').locator('li', { hasText: approved }),
  ).toContainText('已批准');
  await page.getByTestId('inspector-close').click();

  // rollback retires the draft the migration created, and nothing else
  await page.click('#station-migration');
  await expect(stored(page)).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('stored-candidate-operator').fill('lottie');
  await page.getByTestId('stored-candidate-reason').fill('改为人工重写标题');
  await page.getByTestId('stored-candidate-rollback').click();
  await expect(stored(page)).toHaveAttribute('data-state', 'rolled_back', { timeout: 15_000 });
  await expect(page.getByTestId('stored-candidate-rolledback')).toContainText('1 条草稿修订');

  await page.locator('#migration-panel').getByRole('button', { name: '关闭' }).click();
  await expectStillApproved(page, approved, OVERLONG_TITLE);
});

test('with nothing approved to migrate, the action reports the blocker and offers no candidate', async ({
  page,
}) => {
  await waitForStation(page);
  await generate(page);
  await buildCandidateViaAgent(page);

  const result = page.getByTestId('agent-action-result');
  await expect(result).toContainText('未生成候选');
  await expect(result).toContainText('没有已批准的修订');
  // no dead hand-off button for a candidate that does not exist
  await expect(page.getByTestId('agent-action-open')).toHaveCount(0);
});
