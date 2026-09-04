import zlib from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';

// Image compliance inspection, end to end against the real backend.
//
// The fixtures are encoded here rather than committed, so the bytes under
// inspection are known exactly and the assertions are about measurements, not
// about a file someone once produced.

const SHOTS = 'e2e/screenshots';

function tag(testInfo: { project: { name: string } }) {
  return testInfo.project.name;
}

// --------------------------------------------------------------------------- //
// A minimal PNG encoder. Enough to build an exact test image.                  //
// --------------------------------------------------------------------------- //

function chunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(typed) >>> 0);
  return Buffer.concat([length, typed, crc]);
}

/** An RGB PNG of `size`, filled with `bg`, with a dark square in the middle. */
function png(size: number, bg: [number, number, number]): Buffer {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  const lo = Math.floor(size * 0.3);
  const hi = Math.floor(size * 0.7);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const inside = x >= lo && x < hi && y >= lo && y < hi;
      const [r, g, b] = inside ? [40, 60, 90] : bg;
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const WHITE_1200 = png(1200, [255, 255, 255]);
const BLUE_1200 = png(1200, [34, 120, 200]);
const WHITE_400 = png(400, [255, 255, 255]);

// --------------------------------------------------------------------------- //

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

async function openCompliance(page: Page, platform: string) {
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
  await page.locator('[data-testid="inspector-tab"][data-tab="compliance"]').click();
  await expect(page.getByTestId('image-inspection')).toBeVisible();
}

async function upload(page: Page, name: string, data: Buffer) {
  await page.getByTestId('inspect-upload').setInputFiles({
    name,
    mimeType: 'image/png',
    buffer: data,
  });
  await expect(page.getByTestId('image-asset').first()).toBeVisible({ timeout: 15_000 });
}

// --------------------------------------------------------------------------- //

test('a white 1200px main image passes the measurable rules and says so precisely', async ({
  page,
}, testInfo) => {
  await waitForStation(page);
  await generate(page);
  await openCompliance(page, 'amazon');
  await upload(page, 'white.png', WHITE_1200);

  const asset = page.getByTestId('image-asset').first();
  // measurements come from the bytes
  await expect(asset.getByTestId('image-measurements')).toContainText('1200×1200px');
  await expect(asset.getByTestId('image-measurements')).toContainText('1:1');
  await expect(asset.getByTestId('image-measurements')).toContainText('PNG');
  await expect(asset.getByTestId('image-measurements')).toContainText('pillow-decode/v1');

  // the background was sampled, not assumed
  const background = asset.getByTestId('image-background');
  await expect(background).toContainText('#ffffff');
  await expect(background).toContainText('100%');
  await expect(background).toContainText('border-sample-median/v1');

  await expect(asset.locator('[data-rule="amazon.main_image.white_background"]')).toHaveAttribute(
    'data-state',
    'pass',
  );
  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-image-01-white.png` });
});

test('a passing image is still not called compliant while checks remain unrun', async ({
  page,
}) => {
  await waitForStation(page);
  await generate(page);
  await openCompliance(page, 'amazon');
  await upload(page, 'white.png', WHITE_1200);

  const asset = page.getByTestId('image-asset').first();
  await expect(asset.getByTestId('image-verdict')).toContainText('待人工核验');
  await expect(asset.getByTestId('image-verdict')).not.toHaveAttribute('data-tone', 'ok');

  // subject coverage and overlaid text are named as unresolved, not omitted
  await expect(
    asset.locator('[data-rule="amazon.main_image.subject_coverage"]'),
  ).toHaveAttribute('data-state', 'manual_review');
  await expect(
    asset.locator('[data-rule="amazon.main_image.no_overlaid_text"]'),
  ).toHaveAttribute('data-state', 'manual_review');
  await expect(asset.getByTestId('image-open-questions')).toContainText('既不是通过也不是不通过');
});

test('a blue background fails the white-background rule with both numbers shown', async ({
  page,
}, testInfo) => {
  await waitForStation(page);
  await generate(page);
  await openCompliance(page, 'amazon');
  await upload(page, 'blue.png', BLUE_1200);

  const asset = page.getByTestId('image-asset').first();
  const rule = asset.locator('[data-rule="amazon.main_image.white_background"]');
  await expect(rule).toHaveAttribute('data-state', 'fail');
  await expect(rule).toContainText('34, 120, 200');
  await expect(rule).toContainText('250');
  await expect(rule).toContainText('amazon-us-');
  await expect(asset.getByTestId('image-verdict')).toHaveAttribute('data-tone', 'danger');

  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-image-02-blue.png` });
});

test('an undersized image fails the dimension rule', async ({ page }) => {
  await waitForStation(page);
  await generate(page);
  await openCompliance(page, 'amazon');
  await upload(page, 'small.png', WHITE_400);

  const rule = page
    .getByTestId('image-asset')
    .first()
    .locator('[data-rule="amazon.main_image.min_dimensions"]');
  await expect(rule).toHaveAttribute('data-state', 'fail');
  await expect(rule).toContainText('400×400');
  await expect(rule).toContainText('1000×1000');
});

test('an unreadable file is rejected without leaving a record behind', async ({ page }) => {
  await waitForStation(page);
  await generate(page);
  await openCompliance(page, 'amazon');

  await page.getByTestId('inspect-upload').setInputFiles({
    name: 'broken.png',
    mimeType: 'image/png',
    buffer: Buffer.from('this is not a png at all'),
  });

  await expect(page.getByTestId('image-error')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('image-asset')).toHaveCount(0);
  await expect(page.getByTestId('image-none')).toBeVisible();
});

test('the SVG placeholder is reported as unmeasurable rather than passed', async ({ page }) => {
  await waitForStation(page);
  await generate(page);
  await openCompliance(page, 'amazon');

  // The demo cards use vector placeholders: there are no pixels to sample, and
  // the tool must say that instead of producing a verdict.
  await page.getByTestId('inspect-current-image').click();
  await expect(page.getByTestId('image-error')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('image-asset')).toHaveCount(0);
});

test('the inspected original opens in the existing lightbox', async ({ page }, testInfo) => {
  await waitForStation(page);
  await generate(page);
  await openCompliance(page, 'amazon');
  await upload(page, 'white.png', WHITE_1200);

  await page.getByTestId('image-asset').first().getByTestId('view-original').click();
  const lightbox = page.getByTestId('image-lightbox');
  await expect(lightbox).toBeVisible();
  // it is the stored, inspected bytes that open — not the canvas placeholder
  await expect(lightbox.locator('img')).toHaveAttribute('src', /\/api\/media\/assets\/.+\/original/);

  await page.screenshot({ path: `${SHOTS}/${tag(testInfo)}-image-03-lightbox.png` });
  await page.keyboard.press('Escape');
  await expect(lightbox).toHaveCount(0);
});

test('a stored asset verifies against its recorded checksum', async ({ page }) => {
  await waitForStation(page);
  await generate(page);
  await openCompliance(page, 'amazon');
  await upload(page, 'white.png', WHITE_1200);

  await page.getByTestId('image-asset').first().getByTestId('image-verify').click();
  await expect(page.getByTestId('image-checksum')).toContainText('校验一致');
});

test('TikTok grades the same image by its own snapshot', async ({ page }) => {
  await waitForStation(page);
  await generate(page);
  await openCompliance(page, 'tiktok');
  await upload(page, 'blue.png', BLUE_1200);

  const asset = page.getByTestId('image-asset').first();
  // TikTok has no white-background rule, so the blue image is not blocked...
  await expect(asset.locator('[data-rule="amazon.main_image.white_background"]')).toHaveCount(0);
  await expect(asset.locator('[data-rule="tiktok.main_image.min_dimensions"]')).toHaveAttribute(
    'data-state',
    'pass',
  );
  // ...but the background is still measured and shown
  await expect(asset.getByTestId('image-background')).toContainText('#2278c8');
});
