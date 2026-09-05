import { expect, test, type Page } from '@playwright/test';

// The storyboard workflow, driven through the product.
//
// The backend, the storyboard ledger, the validation and the per-shot state are
// all real. The only thing intercepted is the paid video provider call, at the
// network boundary — which is also what lets a test make one shot fail and
// check that retrying it does not re-run the successful ones.

const SHOTS = 'e2e/screenshots';

function tag(testInfo: { project: { name: string } }) {
  return testInfo.project.name;
}

async function waitForStation(page: Page) {
  await page.goto('/');
  await page.waitForSelector('#station-generate', { timeout: 20_000 });
  await page.waitForTimeout(900);
}

/** Add a video node through the sidebar, the way a user would. */
async function addVideoNode(page: Page) {
  await page.click('#station-fill');
  await page.waitForTimeout(200);

  await page.locator('[class*="railAdd"]').first().click();
  await page.getByRole('button', { name: '视频' }).first().click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { editor: any }).editor
            .getCurrentPageShapes()
            .filter((s: any) => s.props?.node?.type === 'video_generation').length,
      ),
    )
    .toBeGreaterThan(0);
  await page.waitForTimeout(500);
}

/** Add a video node and open its storyboard. */
async function openStoryboard(page: Page) {
  await addVideoNode(page);
  await page.getByTestId('open-storyboard').first().click();
  await expect(page.getByTestId('storyboard-panel')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('storyboard-shots').locator('li')).toHaveCount(4, {
    timeout: 15_000,
  });
}

/** Intercept the paid video call. `failFor` makes those prompts fail. */
async function mockVideoProvider(page: Page, options: { failFor?: string[] } = {}) {
  const calls: string[] = [];
  await page.route('**/api/media/video', async route => {
    const body = route.request().postDataJSON() as { prompt?: string };
    const prompt = body?.prompt ?? '';
    calls.push(prompt);
    const shouldFail = (options.failFor ?? []).some(needle => prompt.includes(needle));
    if (shouldFail) {
      await route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ code: 1, error: 'provider_failure', message: '模型服务暂时不可用' }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 0,
        data: { url: `https://mock.invalid/${encodeURIComponent(prompt).slice(0, 20)}.mp4` },
      }),
    });
  });
  return { calls };
}

// --------------------------------------------------------------------------- //

test('the storyboard opens with the four-beat default and never moves the canvas', async ({
  page,
}, testInfo) => {
  await waitForStation(page);
  await addVideoNode(page);

  // Snapshot after the node exists: adding one reframes the canvas by design.
  // What must not move is the canvas when the *panel* opens and closes.
  const snapshot = () =>
    page.evaluate(() => {
      const editor = (window as unknown as { editor: any }).editor;
      return {
        shapes: editor
          .getCurrentPageShapes()
          .map((s: any) => ({ id: String(s.id), x: Math.round(s.x), y: Math.round(s.y) }))
          .sort((a: any, b: any) => a.id.localeCompare(b.id)),
        camera: editor.getCamera(),
      };
    });
  const before = await snapshot();

  await page.getByTestId('open-storyboard').first().click();
  await expect(page.getByTestId('storyboard-panel')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('storyboard-shots').locator('li')).toHaveCount(4, {
    timeout: 15_000,
  });
  expect(await snapshot()).toEqual(before);

  await page.getByRole('button', { name: '关闭' }).first().click();
  await expect(page.getByTestId('storyboard-panel')).toHaveCount(0);
  expect(await snapshot()).toEqual(before);

  await page.getByTestId('open-storyboard').first().click();
  await expect(page.getByTestId('storyboard-panel')).toBeVisible();

  await expect(page.getByTestId('storyboard-validation')).toContainText('15');
  await expect(page.getByTestId('storyboard-validation')).toContainText('4 次付费生成调用');
  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-storyboard-01-default.png` });
});

test('a shot can be edited, reordered, added and removed, and it persists', async ({ page }) => {
  await waitForStation(page);
  await openStoryboard(page);

  const shots = page.getByTestId('storyboard-shot');
  await shots.first().getByTestId('shot-instruction').fill('水杯从桌面展开');
  await expect(page.getByTestId('storyboard-notice')).toContainText('已保存分镜');

  await shots.first().getByTestId('shot-overlay').fill('折叠到 4cm');
  await page.waitForTimeout(400);

  // reorder
  await shots.nth(1).getByTestId('shot-down').click();
  await page.waitForTimeout(500);

  // add and remove
  await page.getByTestId('storyboard-add-shot').click();
  await expect(page.getByTestId('storyboard-shot')).toHaveCount(5);
  await page.getByTestId('storyboard-shot').last().getByTestId('shot-remove').click();
  await expect(page.getByTestId('storyboard-shot')).toHaveCount(4);

  // reopen: the edits came back from the server, not from component memory
  await page.getByRole('button', { name: '关闭' }).first().click();
  await page.getByTestId('open-storyboard').first().click();
  await expect(page.getByTestId('storyboard-panel')).toBeVisible();
  await expect(
    page.getByTestId('storyboard-shot').first().getByTestId('shot-instruction'),
  ).toHaveValue('水杯从桌面展开');
});

test('a shot instruction accepts normal sequential typing without disabling the field', async ({ page }) => {
  await waitForStation(page);
  await openStoryboard(page);

  const input = page.getByTestId('storyboard-shot').first().getByTestId('shot-instruction');
  await input.fill('');
  await input.pressSequentially('水杯缓慢展开', { delay: 40 });
  await expect(input).toHaveValue('水杯缓慢展开');
  await expect(page.getByTestId('storyboard-notice')).toContainText('已保存分镜');

  await page.getByRole('button', { name: '关闭' }).first().click();
  await page.getByTestId('open-storyboard').first().click();
  await expect(page.getByTestId('storyboard-panel')).toBeVisible();
  await expect(
    page.getByTestId('storyboard-shot').first().getByTestId('shot-instruction'),
  ).toHaveValue('水杯缓慢展开');
});

test('an invalid duration blocks generation and names the problem', async ({ page }) => {
  await waitForStation(page);
  await openStoryboard(page);

  await page.getByTestId('storyboard-shot').first().getByTestId('shot-duration').fill('0.5');
  await expect(page.getByTestId('storyboard-problems')).toBeVisible();
  await expect(page.getByTestId('storyboard-problems')).toContainText('短于');
  await expect(page.getByTestId('storyboard-preview-plan')).toBeDisabled();
});

test('generating four shots states the cost and needs an explicit confirmation', async ({
  page,
}, testInfo) => {
  await waitForStation(page);
  const provider = await mockVideoProvider(page);
  await openStoryboard(page);

  await page.getByTestId('storyboard-preview-plan').click();
  const confirm = page.getByTestId('storyboard-confirm');
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('4');
  await expect(confirm).toContainText('付费生成调用');
  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-storyboard-02-confirm.png` });

  // cancelling the confirmation spends nothing
  await page.getByTestId('storyboard-confirm-cancel').click();
  await expect(confirm).toHaveCount(0);
  expect(provider.calls).toHaveLength(0);

  await page.getByTestId('storyboard-preview-plan').click();
  await page.getByTestId('storyboard-confirm-yes').click();

  await expect(page.getByTestId('storyboard-progress')).toContainText('分镜 4/4 已生成', {
    timeout: 30_000,
  });
  expect(provider.calls).toHaveLength(4);
  // progress is a count, never a percentage
  await expect(page.getByTestId('storyboard-progress')).not.toContainText('%');
});

test('an in-flight first shot can be cancelled from the panel', async ({ page }) => {
  await waitForStation(page);
  await openStoryboard(page);

  await page.route('**/api/media/video', async route => {
    await page.waitForTimeout(5_000);
    await route
      .fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 0, data: { url: 'https://mock.invalid/late.mp4' } }),
      })
      .catch(() => undefined);
  });

  await page.getByTestId('storyboard-preview-plan').click();
  await page.getByTestId('storyboard-confirm-yes').click();

  const cancel = page.getByTestId('storyboard-cancel');
  await expect(cancel).toBeVisible();
  await expect(cancel).toBeEnabled();
  await cancel.click();
  await expect(page.getByTestId('storyboard-notice')).toContainText('已取消本次生成', {
    timeout: 10_000,
  });
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('retrying one failed shot does not regenerate the successful ones', async ({
  page,
}, testInfo) => {
  await waitForStation(page);
  await openStoryboard(page);

  // make the closing shot identifiable, then make only it fail
  await page.getByTestId('storyboard-shot').last().getByTestId('shot-instruction').fill('收尾镜头');
  await page.waitForTimeout(500);

  const first = await mockVideoProvider(page, { failFor: ['收尾镜头'] });
  await page.getByTestId('storyboard-preview-plan').click();
  await page.getByTestId('storyboard-confirm-yes').click();

  await expect(page.getByTestId('storyboard-progress')).toContainText('分镜 3/4 已生成', {
    timeout: 30_000,
  });
  expect(first.calls).toHaveLength(4);
  const failed = page.locator('[data-testid="storyboard-shot"][data-status="failed"]');
  await expect(failed).toHaveCount(1);
  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-storyboard-03-failed.png` });

  // now let it succeed, and retry only that shot
  await page.unroute('**/api/media/video');
  const retry = await mockVideoProvider(page);
  await failed.getByTestId('shot-retry').click();

  await expect(page.getByTestId('storyboard-progress')).toContainText('分镜 4/4 已生成', {
    timeout: 30_000,
  });
  expect(retry.calls).toHaveLength(1);
});

test('subtitles and the content package come from the real backend', async ({ page }, testInfo) => {
  await waitForStation(page);
  await mockVideoProvider(page);
  await openStoryboard(page);

  // no captions until there is real caption text
  await page.getByTestId('storyboard-load-package').click();
  await expect(page.getByTestId('storyboard-no-captions')).toBeVisible();
  await expect(page.getByTestId('storyboard-download-vtt')).toHaveCount(0);

  await page.getByTestId('storyboard-shot').first().getByTestId('shot-overlay').fill('折叠到 4cm');
  await page.waitForTimeout(600);
  await page.getByTestId('storyboard-load-package').click();
  await expect(page.getByTestId('storyboard-download-vtt')).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('storyboard-download-vtt').click(),
  ]);
  expect(download.suggestedFilename()).toBe('captions.vtt');
  const path = await download.path();
  const fs = await import('node:fs/promises');
  const body = await fs.readFile(path!, 'utf-8');
  expect(body).toContain('WEBVTT');
  expect(body).toContain('折叠到 4cm');

  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-storyboard-04-package.png` });
});

test('the package never claims a final video when nothing was composed', async ({ page }) => {
  await waitForStation(page);
  await mockVideoProvider(page);
  await openStoryboard(page);

  await page.getByTestId('storyboard-load-package').click();
  await expect(page.getByTestId('storyboard-not-composed')).toBeVisible();
  await expect(page.getByTestId('storyboard-not-composed')).toContainText(
    /不会声称已合成成片|可尝试合成最终成片/,
  );
  await expect(page.getByTestId('storyboard-final-video')).toHaveCount(0);
  await expect(page.getByTestId('storyboard-package-summary')).toContainText('未合成成片');
});

test('the video node exposes no audio or camera-mode control', async ({ page }) => {
  await waitForStation(page);
  await openStoryboard(page);

  // The fields were removed from the contract; nothing may surface them.
  const shape = await page.evaluate(() => {
    const editor = (window as unknown as { editor: any }).editor;
    const node = editor
      .getCurrentPageShapes()
      .find((s: any) => s.props?.node?.type === 'video_generation');
    return node?.props?.node ?? {};
  });
  expect('audio' in shape).toBe(false);
  expect('cameraMode' in shape).toBe(false);
});
