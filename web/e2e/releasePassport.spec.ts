import { expect, test, type Page } from '@playwright/test';

// Release Passport golden path, against the real backend.
//
// The passport's whole value is that it refuses to overstate. These specs check
// the refusals as carefully as the happy path: blocked without an approval,
// blocked when a claim has no evidence, honest about what it never checked, and
// an export that cannot happen without a deliberate confirmation.

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

async function openReview(page: Page, platform: string) {
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
  await page
    .locator(`[data-testid="listing-result"][data-platform="${platform}"]`)
    .getByTestId('open-details')
    .click();
  await page.locator('[data-testid="inspector-tab"][data-tab="review"]').click();
  await expect(page.getByTestId('review-tab')).toBeVisible({ timeout: 15_000 });
}

/** Approve the Amazon listing, optionally rewriting the copy first. */
async function approveAmazon(page: Page, title?: string) {
  await openReview(page, 'amazon');
  if (title) {
    await page.getByTestId('review-title-input').fill(title);
    // The demo template asserts 350ml, food-grade silicone and BPA-Free in its
    // bullets too, so rewriting only the title would leave the evidence gate
    // blocking — correctly. Clear the claims from every field.
    const fields = page.getByTestId('review-field-input');
    for (let i = 0; i < (await fields.count()); i++) {
      await fields.nth(i).fill('Pocket-sized and easy to carry on the go.');
    }
    await page.getByTestId('review-save').click();
    await expect(page.getByTestId('review-dirty')).toHaveCount(0);
  }
  await page.getByTestId('review-validate').click();
  await expect(page.getByTestId('review-state')).toHaveText('校验通过');
  await page.getByTestId('review-operator').fill('lottie');
  await page.getByTestId('review-reason').fill('内部复核通过');
  await page.getByTestId('review-approve').click();
  await expect(page.getByTestId('review-state')).toHaveText('已批准');
  await page.getByTestId('inspector-close').click();
}

async function openPassport(page: Page) {
  await page.click('#station-passport');
  await expect(page.getByTestId('passport-panel')).toBeVisible();
  await expect(page.getByTestId('passport-readiness')).toBeVisible({ timeout: 15_000 });
}

/** A title with no evidence-bearing claim, so the evidence gate has nothing to
 *  refuse and the passport can reach a handoff-ready state. */
const UNCLAIMED_TITLE = 'Collapsible Travel Cup with Leakproof Lid and Carry Loop';

/**
 * Strip the evidence-bearing claims from the SKU source of truth.
 *
 * The demo selling points assert 350ml, food-grade silicone and BPA-Free with
 * no certificate uploaded, so the evidence gate blocks every platform — which
 * is correct, and is what the "unbacked claim" spec above proves. The specs
 * that are about passport assembly need that blocker out of the way so they
 * are testing what they claim to test.
 */
async function useClaimFreeSku(page: Page) {
  await page.evaluate(() => {
    const editor = (window as unknown as { editor: any }).editor;
    const sku = editor
      .getCurrentPageShapes()
      .find((s: any) => s.props?.node?.type === 'sku_listing');
    editor.updateShape({
      id: sku.id,
      type: 'node',
      props: {
        node: {
          ...sku.props.node,
          points: '口袋能装\n防漏盖\n适合徒步、办公、出差',
        },
      },
    });
  });
  await page.waitForTimeout(200);
}

// --------------------------------------------------------------------------- //

test('a SKU with nothing approved yields a blocked passport that names the gap', async ({
  page,
}, testInfo) => {
  await waitForStation(page);
  await generate(page);
  await openPassport(page);

  await expect(page.getByTestId('passport-readiness')).toHaveText('阻断');
  await expect(page.getByTestId('passport-reasons')).toContainText('已批准');
  await expect(page.getByTestId('passport-no-export')).toBeVisible();
  await expect(page.getByTestId('passport-export')).toHaveCount(0);

  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-passport-01-blocked.png` });
});

test('an approved claim with no evidence behind it blocks the handoff', async ({ page }) => {
  await waitForStation(page);
  await generate(page);
  // the demo Amazon title asserts 350ml, and no certificate has been uploaded
  await approveAmazon(page);
  await openPassport(page);

  await expect(page.getByTestId('passport-readiness')).toHaveText('阻断');
  await expect(page.getByTestId('passport-reasons')).toContainText('证据闸门');
  await expect(page.getByTestId('passport-export')).toHaveCount(0);
});

test('the passport binds to exact ids and never claims marketplace approval', async ({
  page,
}, testInfo) => {
  await waitForStation(page);
  await generate(page);
  await useClaimFreeSku(page);
  await approveAmazon(page, UNCLAIMED_TITLE);
  await openPassport(page);

  await expect(page.getByTestId('passport-readiness')).not.toHaveText('阻断');
  await expect(page.getByTestId('passport-id')).toContainText('psp-');
  await expect(page.getByTestId('passport-summary')).toContainText('rev-');
  await expect(page.getByTestId('passport-summary')).toContainText('由操作者声明，未经核验');
  await expect(page.getByTestId('passport-approvals')).toContainText('lottie');
  await expect(page.getByTestId('passport-compliance')).toContainText('amazon-us-');

  const disclaimer = page.getByTestId('passport-disclaimer');
  await expect(disclaimer).toContainText('不会向任何平台发布');
  await expect(disclaimer).toContainText('不代表平台会通过审核');

  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-passport-02-ready.png` });
});

test('the passport says what it never checked instead of leaving it blank', async ({ page }) => {
  await waitForStation(page);
  await generate(page);
  await useClaimFreeSku(page);
  await approveAmazon(page, UNCLAIMED_TITLE);
  await openPassport(page);

  const coverage = page.getByTestId('passport-coverage');
  await expect(coverage).toContainText('图片像素检查');
  await expect(coverage).toContainText('未检查任何图片');
  await expect(coverage).toContainText('主体占比 / 叠加文字');
  await expect(coverage).toContainText('需目标检测与 OCR');
  // and the media section is explicit rather than absent
  await expect(page.getByTestId('passport-media-empty')).toContainText('未覆盖');
});

test('the package manifest is shown before anything is exported', async ({ page }, testInfo) => {
  await waitForStation(page);
  await generate(page);
  await useClaimFreeSku(page);
  await approveAmazon(page, UNCLAIMED_TITLE);
  await openPassport(page);

  const manifest = page.getByTestId('passport-manifest');
  await expect(manifest).toBeVisible();
  for (const file of [
    'release-passport.json',
    'listing.json',
    'listing.md',
    'validation-report.json',
    'evidence-index.json',
    'approvals.json',
    'policy-snapshots.json',
    'README.md',
  ]) {
    await expect(manifest).toContainText(file);
  }
  // every row carries an originating entity, and the listing rows name the revision
  await expect(manifest).toContainText('revision:');
  await expect(manifest).toContainText('passport:');
  const rows = manifest.locator('tbody tr');
  expect(await rows.count()).toBeGreaterThanOrEqual(8);

  // previewing contents must not record an export
  await expect(page.getByTestId('passport-export-record')).toHaveCount(0);
  await expect(page.getByTestId('passport-readiness')).not.toHaveText('已导出');

  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-passport-03-manifest.png` });
});

test('exporting requires a deliberate confirmation that states nothing is published', async ({
  page,
}, testInfo) => {
  await waitForStation(page);
  await generate(page);
  await useClaimFreeSku(page);
  await approveAmazon(page, UNCLAIMED_TITLE);
  await openPassport(page);

  await page.getByTestId('passport-export').click();
  const confirm = page.getByTestId('passport-confirm');
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('不会发布到任何平台');
  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-passport-04-confirm.png` });

  // cancelling exports nothing
  await page.getByTestId('passport-export-cancel').click();
  await expect(confirm).toHaveCount(0);
  await expect(page.getByTestId('passport-export-record')).toHaveCount(0);

  await page.getByTestId('passport-export').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('passport-export-confirm').click(),
  ]);

  expect(download.suggestedFilename()).toContain('.zip');
  await expect(page.getByTestId('passport-notice')).toContainText('未向任何平台发布');
  await expect(page.getByTestId('passport-export-record')).toContainText('已校验');
  await expect(page.getByTestId('passport-readiness')).toHaveText('已导出');
});

test('editing the approved listing supersedes the exported passport', async ({ page }) => {
  await waitForStation(page);
  await generate(page);
  await useClaimFreeSku(page);
  await approveAmazon(page, UNCLAIMED_TITLE);
  await openPassport(page);
  const first = (await page.getByTestId('passport-id').textContent())!;
  await page.locator('#passport-panel').getByRole('button', { name: '关闭' }).click();

  // approve a second revision
  await openReview(page, 'amazon');
  await page.getByTestId('review-title-input').fill(`${UNCLAIMED_TITLE} v2`);
  await page.getByTestId('review-save').click();
  await page.getByTestId('review-validate').click();
  await page.getByTestId('review-reason').fill('v2');
  await page.getByTestId('review-approve').click();
  await expect(page.getByTestId('review-state')).toHaveText('已批准');
  await page.getByTestId('inspector-close').click();

  await openPassport(page);
  await expect(page.getByTestId('passport-id')).not.toHaveText(first);
  await expect(page.getByTestId('passport-content')).toContainText('v2');
});

test('an image with a failed inspection blocks the passport', async ({ page }) => {
  await waitForStation(page);
  await generate(page);
  await useClaimFreeSku(page);
  await approveAmazon(page, UNCLAIMED_TITLE);

  // upload a blue-background main image via the compliance tab
  await openReview(page, 'amazon');
  await page.locator('[data-testid="inspector-tab"][data-tab="compliance"]').click();
  const zlib = await import('node:zlib');
  const size = 800;
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    for (let x = 0; x < size; x++) {
      raw[row + 1 + x * 3] = 34;
      raw[row + 2 + x * 3] = 120;
      raw[row + 3 + x * 3] = 200;
    }
  }
  const chunk = (type: string, body: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(typed) >>> 0);
    return Buffer.concat([len, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const blue = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  await page
    .getByTestId('inspect-upload')
    .setInputFiles({ name: 'blue.png', mimeType: 'image/png', buffer: blue });
  await expect(page.getByTestId('image-asset').first()).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('inspector-close').click();

  await openPassport(page);
  await expect(page.getByTestId('passport-readiness')).toHaveText('阻断');
  await expect(page.getByTestId('passport-reasons')).toContainText('图片');
  await expect(page.getByTestId('passport-export')).toHaveCount(0);
});
