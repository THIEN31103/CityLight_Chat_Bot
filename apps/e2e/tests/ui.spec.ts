// Main flows behind the login. Default target = mock web (fixed accounts, 2FA code 123456), see playwright.config.ts.
import { createHmac } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const REAL = !!process.env.E2E_UI_URL;
const EMAIL = process.env.E2E_EMAIL ?? (REAL ? '' : 'dieuhanh@citylight.local');
const PASSWORD = process.env.E2E_PASSWORD ?? (REAL ? '' : 'demo');
const TOTP_SECRET = process.env.E2E_TOTP_SECRET ?? '';
// real site: the cabinet code to open (and command); mock: picked at run time (the mock fleet is random per load)
let CABINET = process.env.E2E_CABINET ?? '';
const ALLOW_COMMANDS = !REAL || process.env.E2E_ALLOW_COMMANDS === '1';

test.skip(REAL && (!EMAIL || !PASSWORD), 'real site: set E2E_EMAIL / E2E_PASSWORD (a test account, never a person’s own)');

/** RFC 6238 code (SHA-1, 6 digits, 30 s) from a base32 secret, same as the authenticator app. */
function totp(secret: string, at = Date.now()): string {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secret.replace(/[\s=]/g, '').toUpperCase()) bits += alpha.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac('sha1', key).update(msg).digest();
  const o = h[h.length - 1]! & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Mật khẩu').fill(PASSWORD);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  const code = page.getByLabel('Mã xác thực (2FA)');
  const landed = page.getByLabel('Tìm tủ');
  await expect(code.or(landed)).toBeVisible();
  if (await code.isVisible()) {
    await code.fill(REAL ? totp(TOTP_SECRET) : '123456');
    await page.getByRole('button', { name: 'Xác thực' }).click();
  }
  await expect(landed).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

let page: Page;
const pageErrors: string[] = [];

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await login(page);
});
test.afterAll(async () => page?.close());

test('map loads with cabinets and KPI', async () => {
  await expect(page.locator('canvas.maplibregl-canvas')).toBeVisible();
  await expect(page.getByText(/online/i).first()).toBeVisible();
});

test('search a cabinet and open its detail', async () => {
  test.skip(REAL && !CABINET, 'set E2E_CABINET (code) to test the cabinet drawer');
  const search = page.getByLabel('Tìm tủ');
  await search.fill(CABINET || 'TL0');
  // results are buttons "<b>code</b> · name  [status]"; take the wanted code, or the first online one in the mock
  const results = page.locator('button:has(b)').filter({ hasNotText: 'Mất kết nối' });
  const pick = CABINET ? results.filter({ hasText: CABINET }).first() : results.first();
  await expect(pick).toBeVisible();
  CABINET ||= (await pick.locator('b').innerText()).trim();
  await pick.dispatchEvent('mousedown');
  await expect(page.getByRole('tab', { name: 'Điều khiển' })).toBeVisible();
  await expect(page.getByText(CABINET).first()).toBeVisible();
});

test('manual command goes through to "Đã xác nhận"', async () => {
  test.skip(!CABINET || !ALLOW_COMMANDS, 'commands on a real site need E2E_ALLOW_COMMANDS=1 and a test cabinet');
  await page.getByRole('tab', { name: 'Điều khiển' }).click();
  const on = page.getByRole('button', { name: 'Bật N1' });
  const confirmed = page.getByText('Đã xác nhận').first();
  // the mock fails 5 % of commands on purpose (rc:-1): send again, at most 3 tries
  for (let attempt = 1; attempt <= 3; attempt++) {
    await expect(on).toBeEnabled();
    await on.click();
    await page.getByRole('button', { name: 'Gửi lệnh', exact: true }).click();
    // the pressed button shows the command in flight until the cabinet answers
    await expect(on).toHaveAttribute('aria-busy', 'true');
    await expect(on).toHaveAttribute('aria-busy', 'false', { timeout: 45_000 });
    if (REAL || (await confirmed.isVisible())) break;
  }
  await expect(confirmed).toBeVisible();
  await expect(on).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Về tự động' })).toHaveAttribute('aria-pressed', 'false');
});

for (const [path, heading] of [
  ['/alarms', /Cảnh báo/],
  ['/incidents', /Sự cố/],
  ['/schedules', /Lịch/],
  ['/logs/activity', /Nhật ký/],
] as const) {
  test(`page ${path} renders`, async () => {
    await page.goto(path);
    await expect(page).toHaveURL(new RegExp(path));
    await expect(page.getByText(heading).first()).toBeVisible();
    await expect(page.getByText('Đã xảy ra lỗi')).toHaveCount(0);
  });
}

test('no uncaught errors in the page, then log out', async () => {
  expect(pageErrors).toEqual([]);
  // user menu = the header button that shows the name + role
  await page.getByRole('button', { name: /Quản trị|Điều hành|Giám sát|Duy tu|Bảo trì/ }).last().click();
  await page.getByRole('menuitem', { name: 'Đăng xuất' }).click();
  await expect(page).toHaveURL(/\/login/);
});
