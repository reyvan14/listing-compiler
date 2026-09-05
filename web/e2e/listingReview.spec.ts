import { expect, test, type Page } from '@playwright/test';

// Editable listing review and approval, end to end against the real backend.
//
// Nothing here is mocked: the deterministic checker, the revision ledger and
// the approval records are the real ones. The specs assert the invariants that
// make the workflow trustworthy — approval cannot outrun validation, an edit
// cannot inherit an old verdict, and the canvas never moves.

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
  await page.waitForTimeout(1200);
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

const inspector = (page: Page) => page.locator('[data-testid="listing-inspector"]');
const reviewTab = (page: Page) => page.locator('[data-testid="review-tab"]');

async function openReview(page: Page, platform: string) {
  await bringIntoView(page, platform);
  await page
    .locator(`[data-testid="listing-result"][data-platform="${platform}"]`)
    .getByTestId('open-details')
    .click();
  await expect(inspector(page)).toBeVisible();
  await page.locator('[data-testid="inspector-tab"][data-tab="review"]').click();
  await expect(reviewTab(page)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('review-revision-id')).not.toBeEmpty();
}

/** Node geometry + camera, for the "canvas never moves" guard. */
async function canvasState(page: Page) {
  return page.evaluate(() => {
    const editor = (window as unknown as { editor: any }).editor;
    return {
      shapes: editor
        .getCurrentPageShapes()
        .filter((s: any) => s.props?.node?.type === 'listing_result')
        .map((s: any) => {
          const b = editor.getShapePageBounds(s.id);
          return { id: s.id, x: Math.round(b.x), y: Math.round(b.y), h: Math.round(b.h) };
        })
        .sort((a: any, b: any) => a.y - b.y),
      camera: editor.getCamera(),
    };
  });
}

// --------------------------------------------------------------------------- //

test('a generated listing becomes a draft revision without inventing review activity', async ({
  page,
}, testInfo) => {
  await waitForStation(page);
  await generate(page);
  await openReview(page, 'amazon');

  await expect(page.getByTestId('review-state')).toHaveText('草稿');
  await expect(page.getByTestId('review-state')).toHaveAttribute('data-state', 'draft');
  // no approval has happened, so no approval record is shown
  await expect(page.getByTestId('review-approvals')).toHaveCount(0);
  await expect(page.getByTestId('review-unvalidated')).toBeVisible();
  // history holds exactly the one revision that generation actually produced
  await expect(page.getByTestId('review-history').locator('li')).toHaveCount(1);

  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-review-01-draft.png` });
});

test('opening and closing the review tab leaves the canvas untouched', async ({ page }) => {
  await waitForStation(page);
  await generate(page);
  await bringIntoView(page, 'amazon');

  const before = await canvasState(page);

  await openReview(page, 'amazon');
  await page.waitForTimeout(400);
  await page.getByTestId('inspector-close').click();
  await expect(inspector(page)).toHaveCount(0);
  await page.waitForTimeout(300);

  expect(await canvasState(page)).toEqual(before);
});

test('editing shows a field-level diff and reset discards it', async ({ page }, testInfo) => {
  await waitForStation(page);
  await generate(page);
  await openReview(page, 'amazon');

  const title = page.getByTestId('review-title-input');
  const original = await title.inputValue();

  await title.fill(`${original} EDITED`);
  await expect(page.getByTestId('review-dirty')).toBeVisible();
  const pending = page.getByTestId('review-pending-diff');
  await expect(pending).toBeVisible();
  await expect(pending.locator('li[data-status="modified"]')).toHaveCount(1);
  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-review-02-dirty.png` });

  await page.getByTestId('review-reset').click();
  await expect(page.getByTestId('review-dirty')).toHaveCount(0);
  await expect(title).toHaveValue(original);
  // still exactly one revision: an abandoned edit writes nothing
  await expect(page.getByTestId('review-history').locator('li')).toHaveCount(1);
});

test('the golden path runs draft to approved and records who approved what', async ({
  page,
}, testInfo) => {
  await waitForStation(page);
  await generate(page);
  await openReview(page, 'amazon');

  await page.getByTestId('review-validate').click();
  await expect(page.getByTestId('review-state')).toHaveText('校验通过');
  await expect(page.getByTestId('review-no-blockers')).toBeVisible();

  // approval needs a named operator before it is offered at all
  await expect(page.getByTestId('review-approve')).toBeDisabled();
  await page.getByTestId('review-operator').fill('lottie');
  await page.getByTestId('review-reason').fill('文案与证据已核对');
  await expect(page.getByTestId('review-approve')).toBeEnabled();

  await page.getByTestId('review-approve').click();
  await expect(page.getByTestId('review-state')).toHaveText('已批准');

  const approvals = page.getByTestId('review-approvals');
  await expect(approvals).toContainText('批准');
  await expect(approvals).toContainText('lottie');
  await expect(approvals).toContainText('文案与证据已核对');
  // the record names the validation and the policy snapshot that permitted it
  await expect(approvals).toContainText('val-');
  await expect(approvals).toContainText('amazon-us-');

  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-review-03-approved.png` });
});

test('approval is blocked while a deterministic blocker stands', async ({ page }, testInfo) => {
  await waitForStation(page);
  await generate(page);
  await openReview(page, 'tiktok');

  // A TikTok title with a hashtag and an emoji trips blocking policy rules.
  await page.getByTestId('review-title-input').fill('🔥爆款 #summer 折叠水杯!!!');
  await page.getByTestId('review-save').click();
  await expect(page.getByTestId('review-dirty')).toHaveCount(0);

  await page.getByTestId('review-validate').click();
  await expect(page.getByTestId('review-state')).toHaveText('需修改');

  const blockers = page.getByTestId('review-blockers');
  await expect(blockers).toBeVisible();
  await expect(blockers.locator('li')).not.toHaveCount(0);

  await page.getByTestId('review-operator').fill('lottie');
  await page.getByTestId('review-reason').fill('先上线再说');
  // the button is not merely styled as unavailable — it cannot be pressed
  await expect(page.getByTestId('review-approve')).toBeDisabled();
  await expect(page.getByTestId('review-approve-hint')).toContainText('阻断');

  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-review-04-blocked.png` });
});

test('an edit after approval forks a candidate and leaves the approved revision active', async ({
  page,
}) => {
  await waitForStation(page);
  await generate(page);
  await openReview(page, 'amazon');

  await page.getByTestId('review-validate').click();
  await page.getByTestId('review-operator').fill('lottie');
  await page.getByTestId('review-reason').fill('ok');
  await page.getByTestId('review-approve').click();
  await expect(page.getByTestId('review-state')).toHaveText('已批准');
  const approvedId = await page.getByTestId('review-revision-id').textContent();

  // editing an approved revision must warn, then fork rather than overwrite
  await expect(page.getByTestId('review-fork-hint')).toBeVisible();
  const title = page.getByTestId('review-title-input');
  await title.fill(`${await title.inputValue()} v2`);
  await page.getByTestId('review-save').click();

  await expect(page.getByTestId('review-state')).toHaveText('草稿');
  await expect(page.getByTestId('review-revision-id')).not.toHaveText(approvedId!);
  // the approved revision is still the live one
  await expect(page.getByTestId('review-active-elsewhere')).toContainText(approvedId!);
  await expect(page.getByTestId('review-history').locator('li')).toHaveCount(2);
});

test('warnings are acknowledged with a named operator and a reason', async ({ page }) => {
  await waitForStation(page);
  await generate(page);
  await openReview(page, 'amazon');

  await page.getByTestId('review-validate').click();
  const warnings = page.getByTestId('review-warnings');
  await expect(warnings).toBeVisible();

  await page.getByTestId('review-warning-check').first().check();
  // acknowledgement is refused until responsibility is attributable
  await expect(page.getByTestId('review-acknowledge')).toBeDisabled();
  await page.getByTestId('review-operator').fill('lottie');
  await page.getByTestId('review-reason').fill('证书已在线下确认');
  await expect(page.getByTestId('review-acknowledge')).toBeEnabled();

  await page.getByTestId('review-acknowledge').click();
  await expect(warnings).toContainText('已确认');
});

test('rollback restores earlier copy as a new revision and keeps later history', async ({
  page,
}, testInfo) => {
  await waitForStation(page);
  await generate(page);
  await openReview(page, 'amazon');

  const title = page.getByTestId('review-title-input');
  const originalTitle = await title.inputValue();

  // approve v1
  await page.getByTestId('review-validate').click();
  await page.getByTestId('review-operator').fill('lottie');
  await page.getByTestId('review-reason').fill('v1');
  await page.getByTestId('review-approve').click();
  await expect(page.getByTestId('review-state')).toHaveText('已批准');
  const first = (await page.getByTestId('review-revision-id').textContent())!;

  // fork, edit and approve v2
  await title.fill(`${originalTitle} v2`);
  await page.getByTestId('review-save').click();
  // the save forked a candidate; confirm before grading it
  await expect(page.getByTestId('review-revision-id')).not.toHaveText(first);
  await expect(page.getByTestId('review-state')).toHaveText('草稿');
  const second = (await page.getByTestId('review-revision-id').textContent())!;

  await page.getByTestId('review-validate').click();
  await expect(page.getByTestId('review-state')).toHaveText('校验通过');
  await page.getByTestId('review-reason').fill('v2');
  await page.getByTestId('review-approve').click();
  await expect(page.getByTestId('review-state')).toHaveText('已批准');

  // roll back to v1
  await page.getByTestId('review-reason').fill('v2 文案有误');
  await page.locator(`[data-testid="review-rollback"][data-revision="${first}"]`).click();
  // the panel already reads 已批准, so wait on the thing that actually changes
  await expect(page.getByTestId('review-revision-id')).not.toHaveText(second);
  await expect(page.getByTestId('review-state')).toHaveText('已批准');

  const restored = (await page.getByTestId('review-revision-id').textContent())!;
  expect(restored).not.toBe(first);
  expect(restored).not.toBe(second);
  // exact content restored
  await expect(title).toHaveValue(originalTitle);
  // three revisions plus the restored one; nothing deleted
  const history = page.getByTestId('review-history');
  await expect(history.locator('li')).toHaveCount(3);
  await expect(history).toContainText(second);
  await expect(history).toContainText(`还原自 ${first}`);

  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-review-05-rolled-back.png` });
});

test('any two stored revisions can be compared field by field', async ({ page }, testInfo) => {
  await waitForStation(page);
  await generate(page);
  await openReview(page, 'amazon');

  await page.getByTestId('review-validate').click();
  await page.getByTestId('review-operator').fill('lottie');
  await page.getByTestId('review-reason').fill('v1');
  await page.getByTestId('review-approve').click();
  await expect(page.getByTestId('review-state')).toHaveText('已批准');
  const first = (await page.getByTestId('review-revision-id').textContent())!;

  const title = page.getByTestId('review-title-input');
  await title.fill(`${await title.inputValue()} v2`);
  await page.getByTestId('review-save').click();

  await page.locator(`[data-testid="review-diff"][data-revision="${first}"]`).click();
  const panel = page.getByTestId('review-diff-panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('tr[data-status="modified"]')).toHaveCount(1);
  await expect(panel).toContainText('修改');

  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-review-06-diff.png` });
});
