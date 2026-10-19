// Production smoke checks without an account: safe to run any time against the VPS.
import { expect, test } from '@playwright/test';

test('site is served over HTTPS with the security headers', async ({ request, baseURL }) => {
  expect(baseURL).toMatch(/^https:/);
  const r = await request.get('/');
  expect(r.status()).toBe(200);
  const h = r.headers();
  expect(h['strict-transport-security']).toContain('max-age=');
  expect(h['x-frame-options']).toBe('DENY');
  expect(h['x-content-type-options']).toBe('nosniff');
  // pages must not be cached (a deploy has to show up at once), hashed assets can be
  expect(h['cache-control']).toContain('no-cache');
});

test('plain HTTP redirects to HTTPS', async ({ request, baseURL }) => {
  const r = await request.get(baseURL!.replace('https:', 'http:') + '/', { maxRedirects: 0 });
  expect([301, 302, 307, 308]).toContain(r.status());
  expect(r.headers()['location']).toMatch(/^https:/);
});

test('API health: database and redis ok', async ({ request }) => {
  const r = await request.get('/api/v1/health');
  expect(r.ok()).toBeTruthy();
  expect(await r.json()).toMatchObject({ status: 'ok', db: 'ok', redis: 'ok' });
});

test('protected API answers 401 without a session', async ({ request }) => {
  for (const path of ['/api/v1/auth/me', '/api/v1/map/cabinets', '/api/v1/system/stats']) {
    const r = await request.get(path);
    expect(r.status(), path).toBe(401);
  }
});

test('opening the app without a session lands on the login page', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByLabel('Email')).toBeVisible();
  await expect(page.getByLabel('Mật khẩu')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Đăng nhập' })).toBeVisible();
  // the production build must never ship the mock hint
  await expect(page.getByText('Chế độ mock')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('wrong credentials show an error and no session', async ({ page }) => {
  // an address that does not exist: no real account gets a failed-login count or a lock
  await page.goto('/login');
  await page.getByLabel('Email').fill(`e2e-nobody-${Date.now()}@example.invalid`);
  await page.getByLabel('Mật khẩu').fill('not-the-password');
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page.locator('form .text-st-offline')).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});
