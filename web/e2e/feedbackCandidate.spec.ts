import { expect, test, type Page } from '@playwright/test';

// Feedback signal → candidate listing revision, end to end.
//
// Nothing is mocked. The import parser, the deterministic detectors, the
// revision ledger and the approval records are the real ones; the CSV is
// uploaded through the real file input. What these specs guard is the property
// the workflow exists for: a performance signal can become a *candidate* a
// human then reviews, and can never quietly rewrite what is already approved.

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
const panel = (page: Page) => page.locator('[data-testid="feedback-panel"]');

async function openReview(page: Page, platform: string) {
  await bringIntoView(page, platform);
  await page
    .locator(`[data-testid="listing-result"][data-platform="${platform}"]`)
    .getByTestId('open-details')
    .click();
  await expect(inspector(page)).toBeVisible();
  await page.locator('[data-testid="inspector-tab"][data-tab="review"]').click();
  await expect(page.locator('[data-testid="review-tab"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('review-revision-id')).not.toBeEmpty();
}

/**
 * Take the Amazon draft all the way to 已批准 and return its revision id.
 *
 * The baseline has to be genuinely approved: "a candidate never overwrites the
 * approved revision" is only a real assertion when there is one to overwrite.
 */
async function approveBaseline(page: Page): Promise<string> {
  await openReview(page, 'amazon');
  const revisionId = (await page.getByTestId('review-revision-id').textContent())!.trim();
  await page.getByTestId('review-validate').click();
  await expect(page.getByTestId('review-state')).toHaveText('校验通过');
  await page.getByTestId('review-operator').fill('lottie');
  await page.getByTestId('review-reason').fill('基线已核对');
  await page.getByTestId('review-approve').click();
  await expect(page.getByTestId('review-state')).toHaveText('已批准');
  await page.getByTestId('inspector-close').click();
  await expect(inspector(page)).toHaveCount(0);
  return revisionId;
}

/**
 * Two weeks of deliberately poor click-through on one revision.
 *
 * 12000 + 9000 impressions against 60 + 40 clicks is a 0.49% CTR: over the
 * 1000-impression floor and under the 1% CTR floor, so the real detector emits
 * exactly one `high_impressions_low_ctr` signal.
 */
function performanceCsv(revisionId: string): string {
  const header =
    'sku,platform,revision_id,period_start,period_end,impressions,clicks,add_to_cart,purchases,revenue,returns,return_reason,review_text,rating';
  return [
    header,
    `AERO-350,amazon,${revisionId},2026-08-01,2026-08-14,12000,60,10,4,119.60,0,,,4`,
    `AERO-350,amazon,${revisionId},2026-08-15,2026-08-28,9000,40,7,3,89.70,0,,,4`,
  ].join('\n');
}

async function openFeedback(page: Page, revisionId: string) {
  await page.click('#station-feedback');
  await expect(panel(page)).toBeVisible();
  await page.getByTestId('feedback-file').setInputFiles({
    name: 'amazon-aug.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(performanceCsv(revisionId), 'utf-8'),
  });
  await expect(page.getByTestId('feedback-notice')).toHaveText('已导入。');
  await expect(page.getByTestId('feedback-signal')).toHaveCount(1);
}

// --------------------------------------------------------------------------- //

test('a signal names the evidence behind it before offering any action', async ({
  page,
}, testInfo) => {
  await waitForStation(page);
  await generate(page);
  const baseline = await approveBaseline(page);
  await openFeedback(page, baseline);

  const signal = page.getByTestId('feedback-signal');
  await expect(signal).toHaveAttribute('data-signal', 'high_impressions_low_ctr');

  const evidence = page.getByTestId('feedback-evidence');
  // row count, the rows themselves, the period covered, and what it affects
  await expect(evidence).toContainText('2 行原始数据');
  await expect(evidence).toContainText('2026-08-01');
  await expect(evidence).toContainText('2026-08-28');
  await expect(evidence).toContainText(baseline);
  await expect(evidence).toContainText('标题');
  // the correlation caveat is stated, not buried
  await expect(signal).toContainText('无法归因');

  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-feedback-01-signal.png` });
});

test('the candidate draft is prefilled with the real baseline copy, not invented text', async ({
  page,
}) => {
  await waitForStation(page);
  await generate(page);
  await openReview(page, 'amazon');
  const baselineTitle = await page.getByTestId('review-title-input').inputValue();
  await page.getByTestId('inspector-close').click();
  await openReview(page, 'amazon');
  const baseline = (await page.getByTestId('review-revision-id').textContent())!.trim();
  await page.getByTestId('inspector-close').click();

  await openFeedback(page, baseline);
  await page.getByTestId('feedback-prepare-candidate').click();
  await expect(page.getByTestId('feedback-draft')).toBeVisible();
  // the operator edits the listing's own words; the tool does not write copy
  await expect(page.getByTestId('feedback-draft-title')).toHaveValue(baselineTitle);
  // and it will not submit unnamed
  await expect(page.getByTestId('feedback-create-candidate')).toBeDisabled();
});

test('promoting a signal creates a candidate and leaves the approved revision approved', async ({
  page,
}, testInfo) => {
  await waitForStation(page);
  await generate(page);
  const baseline = await approveBaseline(page);
  await openFeedback(page, baseline);

  await page.getByTestId('feedback-prepare-candidate').click();
  const title = page.getByTestId('feedback-draft-title');
  const original = await title.inputValue();
  await title.fill('折叠硅胶水杯 350ml 食品级硅胶 可放洗碗机');
  await page.getByTestId('feedback-operator').fill('lottie');
  await page.getByTestId('feedback-create-candidate').click();

  const created = page.getByTestId('feedback-created');
  await expect(created).toBeVisible({ timeout: 15_000 });
  const candidateId = (await created.locator('code').first().textContent())!.trim();
  // a fork, not an in-place edit
  expect(candidateId).not.toBe(baseline);
  await expect(created).toContainText('原已批准修订未被改动');
  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-feedback-02-created.png` });

  // hand-off: the candidate opens in the existing review interface
  await page.getByTestId('feedback-open-review').click();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.locator('[data-testid="review-tab"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('review-revision-id')).toHaveText(candidateId);
  // the candidate is a draft awaiting review; it did not inherit approval
  await expect(page.getByTestId('review-state')).toHaveText('草稿');

  // the field-level diff against the baseline is shown without being asked for
  const diff = page.getByTestId('review-diff-panel');
  await expect(diff).toBeVisible();
  await expect(diff).toContainText(baseline);
  await expect(diff).toContainText(candidateId);
  await expect(diff.locator('[data-status="modified"]')).not.toHaveCount(0);
  await expect(diff).toContainText(original.slice(0, 12));

  // the baseline is still there, still approved
  const history = page.getByTestId('review-history');
  await expect(history.locator('li')).toHaveCount(2);
  await expect(history.locator('li', { hasText: baseline })).toContainText('已批准');
  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-feedback-03-review.png` });
});

test('promoting the same signal twice replays one candidate instead of forking two', async ({
  page,
}) => {
  await waitForStation(page);
  await generate(page);
  const baseline = await approveBaseline(page);
  await openFeedback(page, baseline);

  await page.getByTestId('feedback-prepare-candidate').click();
  await page.getByTestId('feedback-draft-title').fill('折叠硅胶水杯 350ml 可放洗碗机');
  await page.getByTestId('feedback-operator').fill('lottie');
  await page.getByTestId('feedback-create-candidate').click();
  const first = (await page
    .getByTestId('feedback-created')
    .locator('code')
    .first()
    .textContent())!.trim();

  // close and come back: the same import + signal + baseline is the same key
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
  await page.click('#station-feedback');
  await expect(page.getByTestId('feedback-signal')).toHaveCount(1);
  await page.getByTestId('feedback-prepare-candidate').click();
  await page.getByTestId('feedback-draft-title').fill('完全不同的标题 350ml');
  await page.getByTestId('feedback-operator').fill('lottie');
  await page.getByTestId('feedback-create-candidate').click();

  const created = page.getByTestId('feedback-created');
  await expect(created).toBeVisible({ timeout: 15_000 });
  await expect(created).toContainText('重复请求');
  expect((await created.locator('code').first().textContent())!.trim()).toBe(first);

  // one candidate on the ledger, not two
  await page.keyboard.press('Escape');
  await openReview(page, 'amazon');
  await expect(page.getByTestId('review-history').locator('li')).toHaveCount(2);
});

test('an import with no threshold breach says so instead of inventing advice', async ({ page }) => {
  await waitForStation(page);
  await generate(page);
  const baseline = await approveBaseline(page);

  await page.click('#station-feedback');
  await expect(panel(page)).toBeVisible();
  // healthy numbers: 8% CTR, 20% CVR, no returns
  await page.getByTestId('feedback-file').setInputFiles({
    name: 'healthy.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      'sku,platform,revision_id,period_start,period_end,impressions,clicks,add_to_cart,purchases,revenue,returns,return_reason,review_text,rating\n' +
        `AERO-350,amazon,${baseline},2026-08-01,2026-08-14,12000,960,400,240,7176.00,0,,,5\n`,
      'utf-8',
    ),
  });
  await expect(page.getByTestId('feedback-notice')).toHaveText('已导入。');

  await expect(page.getByTestId('feedback-signal')).toHaveCount(0);
  await expect(page.getByTestId('feedback-no-signals')).toContainText('没有可操作的改进建议');
  await expect(page.getByTestId('feedback-create-candidate')).toHaveCount(0);
});
