// Whole QR journey in a real Chrome against the real stack: a board carrying an ID and a cabinet code reports in, the
// label tool makes its QR, Chrome's camera sees that QR (fake capture device fed with the label), an account with
// cabinet approval registers it in Administration, then an empty form and a board replacement go the same way. The board is the simulator; the page is the
// production build under the production CSP. Needs api + ingest + `vite preview` of a real-mode build on E2E_UI_URL.
// Run: QR_TOOL=<path to create_qr.html> npm run e2e:qr-flow
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash } from '@node-rs/argon2';
import { chromium, type Browser, type Page } from '@playwright/test';
import { createSql } from '@citylight/db';
import { SimCabinet } from '../simulator/src/cabinet';
import { base32Decode } from '../api/src/totp';
import { freshCode, login } from '../api/test/client';
import { enforceCsp } from './tests/csp';

const BASE = process.env.E2E_UI_URL ?? 'http://localhost:4173';
const MQTT_URL = process.env.E2E_MQTT_URL ?? process.env.MQTT_URL ?? 'mqtt://localhost:1885';
const TOOL = process.env.QR_TOOL;
const OUT = process.env.QR_FLOW_OUT ?? join(tmpdir(), 'citylight-qr-flow');
const DOMAIN = 'e2e-flow.citylight.test';
const FRAME = { w: 640, h: 480, qr: 400 };

const sql = createSql(process.env.DATABASE_URL, 2);
const checks: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, info?: string) => {
  checks.push({ name, ok });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` — ${info}` : ''}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 30_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const v = await fn();
    if (v) return v;
    await sleep(500);
  }
  throw new Error(`timeout waiting for ${what}`);
}

const hex = (n: number) => randomBytes(n).toString('hex').toUpperCase();
const row = () => ({ code: `TF${hex(2)}`, ltid: `Q${hex(3)}` });
const first = row();
const second = row();
const spare = { code: first.code, ltid: `Q${hex(3)}` };
const LTIDS = [first.ltid, second.ltid, spare.ltid];

const board = (r: { code: string; ltid: string }) =>
  new SimCabinet({ ltid: r.ltid, brokerUrl: MQTT_URL, fault: 'none', location: { lat: 10.77, lng: 106.69 }, telemetryMs: 2000, cabinetCode: r.code });

/** Runs the label tool and turns the label it drew into a video file Chrome can use as its camera. */
async function labelVideo(browser: Browser, code: string): Promise<string> {
  const page = await browser.newPage();
  await page.goto(`file:///${TOOL!.replaceAll('\\', '/')}`);
  await page.fill('#list', code);
  await page.click('#make');
  await page.waitForSelector(`.tem[data-code="${code}"] canvas`);
  await page.screenshot({ path: join(OUT, `tool-${code}.png`) });
  const luma = await page.evaluate(({ code, w, h, qr }) => {
    const label = document.querySelector<HTMLCanvasElement>(`.tem[data-code="${code}"] canvas`)!;
    const frame = document.createElement('canvas');
    frame.width = w;
    frame.height = h;
    const ctx = frame.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(label, (w - qr) / 2, (h - qr) / 2, qr, (qr * label.height) / label.width);
    const rgba = ctx.getImageData(0, 0, w, h).data;
    const out = new Uint8Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = Math.round(0.299 * rgba[i * 4]! + 0.587 * rgba[i * 4 + 1]! + 0.114 * rgba[i * 4 + 2]!);
    return Array.from(out);
  }, { code, ...FRAME });
  await page.close();
  const y = Buffer.from(luma);
  const chroma = Buffer.alloc((FRAME.w * FRAME.h) / 2, 0x80);
  const frames = Array.from({ length: 10 }, () => [Buffer.from('FRAME\n'), y, chroma]).flat();
  const file = join(OUT, `label-${code}.y4m`);
  writeFileSync(file, Buffer.concat([Buffer.from(`YUV4MPEG2 W${FRAME.w} H${FRAME.h} F10:1 Ip A1:1 C420jpeg\n`), ...frames]));
  return file;
}

const camera = (video: string) =>
  chromium.launch({ channel: 'chromium', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`] });

/** A page on the production build, with the production CSP enforced. */
async function desktop(browser: Browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 850 }, locale: 'vi-VN', permissions: ['camera'] });
  const page = await ctx.newPage();
  const csp = await enforceCsp(page, BASE);
  return { page, csp };
}

async function signIn(page: Page, email: string, password: string, code?: () => Promise<string>) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', password);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  if (code) {
    await page.getByRole('button', { name: 'Xác thực' }).waitFor();
    await page.locator('main input, form input').first().fill(await code());
    await page.keyboard.press('Enter');
  }
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}

async function main() {
  if (!TOOL) throw new Error('set QR_TOOL to the path of create_qr.html');
  mkdirSync(OUT, { recursive: true });
  const users = `%@${DOMAIN}`;
  const cleanup = async () => {
    await sql`DELETE FROM cabinets WHERE ltid = ANY(${LTIDS})`;
    await sql`DELETE FROM unknown_devices WHERE ltid = ANY(${LTIDS})`;
    await sql`DELETE FROM users WHERE email LIKE ${users}`;
  };
  await cleanup();

  const org = (await sql<{ id: string }[]>`SELECT id FROM organizations LIMIT 1`)[0]!.id;
  const pw = `Flow-${randomBytes(9).toString('hex')}`;
  const h = await hash(pw);
  await sql`INSERT INTO users (organization_id, email, full_name, password_hash, role, scope_all, can_enroll) VALUES
    (${org}, ${'lapdat@' + DOMAIN}, 'Người lắp đặt', ${h}, 'viewer', false, true), (${org}, ${'admin@' + DOMAIN}, 'Quản trị', ${h}, 'admin', true, false)`;
  const { c: api } = await login(`admin@${DOMAIN}`, pw);
  const setup = await api.post('/auth/2fa/setup');
  const secret = base32Decode(setup.data.secret);
  const step = { step: 0 };
  await api.post('/auth/2fa/enable', { code: await freshCode(secret, step) });
  const totp = () => freshCode(secret, step);

  const boards = [board(first), board(second)];
  const tool = await chromium.launch({ channel: 'chromium' });
  const browsers: Browser[] = [tool];
  try {
    // ---------- 1. the board is set up with an ID and a cabinet code, then powered ----------
    console.log(`\nBảng mã: ${first.code} = ${first.ltid}, ${second.code} = ${second.ltid}`);
    boards.forEach((b) => b.start());
    const seen = await waitFor('boards in the unregistered list', async () => {
      const rows = (await api.get('/devices/unknown')).data as { ltid: string; code: string | null }[];
      const hit = rows.find((r) => r.ltid === first.ltid);
      return hit?.code && rows.some((r) => r.ltid === second.ltid) ? hit : null;
    });
    check('Board chạy lên nằm trong danh sách chưa đăng ký, đúng ID và mã tủ', seen.code === first.code);
    check('Chưa quét thì chưa thành tủ', (await sql`SELECT 1 FROM cabinets WHERE ltid = ANY(${LTIDS})`).length === 0);

    // ---------- 2. an account with cabinet approval only: the row, the QR button, confirm ----------
    const video1 = await labelVideo(tool, first.code);
    check('Tool tạo được tem QR', true, video1);
    const cam1 = await camera(video1);
    browsers.push(cam1);
    const { page: installer, csp: csp1 } = await desktop(cam1);
    await signIn(installer, `lapdat@${DOMAIN}`, pw);
    await installer.goto(`${BASE}/admin/users`);
    await installer.waitForURL('**/admin/devices');
    check('Tài khoản chỉ có quyền Duyệt tủ được đưa thẳng tới Đăng ký tủ', true);
    check('Tài khoản đó không thấy mục Người dùng', (await installer.getByRole('link', { name: 'Người dùng' }).count()) === 0);
    const row1 = installer.getByRole('row').filter({ hasText: first.ltid });
    await row1.getByRole('button', { name: 'Duyệt & đăng ký' }).click();
    const code1 = installer.locator('[role=dialog] input').nth(1);
    check('Form tự điền mã tủ board báo lên', (await code1.inputValue()) === first.code);
    await code1.fill('');
    await installer.getByRole('button', { name: 'Quét mã QR trên tủ' }).click();
    await waitFor('code from the label', async () => (await code1.inputValue()) === first.code);
    check('Camera đọc được tem, điền đúng mã tủ', true);
    await installer.screenshot({ path: join(OUT, '1-form-da-quet.png') });
    await installer.getByRole('dialog').getByRole('button', { name: 'Đăng ký', exact: true }).click();
    await installer.getByRole('row').filter({ hasText: first.code }).filter({ hasText: 'Quét QR' }).waitFor();
    await installer.screenshot({ path: join(OUT, '2-da-dang-ky.png') });
    const cabinet = (await sql<{ id: string; ltid: string; name: string }[]>`SELECT id, ltid, name FROM cabinets WHERE code = ${first.code}`)[0];
    check('Tủ được tạo, gắn đúng ID đã cài', cabinet?.ltid === first.ltid && cabinet.name === first.code);
    await waitFor('cabinet online', async () => (await sql`SELECT 1 FROM cabinet_state WHERE cabinet_id = ${cabinet!.id} AND online`).length === 1);
    check('Tủ online, server nhận dữ liệu của board', true);
    const log = (await sql<{ user_email: string }[]>`SELECT user_email FROM activity_logs WHERE action = 'Đăng ký tủ bằng QR' AND target_id = ${cabinet!.id}`)[0];
    check('Nhật ký ghi đúng người duyệt', log?.user_email === `lapdat@${DOMAIN}`);
    check('Trang chạy dưới CSP thật, không vi phạm', csp1.length === 0, csp1.join(' | ').slice(0, 200));
    await cam1.close();

    // ---------- 3. the QR button on an empty form fills everything ----------
    const video2 = await labelVideo(tool, second.code);
    const cam3 = await camera(video2);
    browsers.push(cam3);
    const { page: admin, csp: csp3 } = await desktop(cam3);
    await signIn(admin, `admin@${DOMAIN}`, pw, totp);
    await admin.goto(`${BASE}/admin/devices`);
    await admin.getByRole('button', { name: 'Đăng ký tủ mới' }).click();
    await admin.getByRole('button', { name: 'Quét mã QR trên tủ' }).click();
    await waitFor('form filled from the label', async () => (await admin.locator('[role=dialog] input').nth(1).inputValue()) === second.code);
    check('Quét trong form trống điền mã tủ', true);
    check('Quét trong form trống tự điền ID của thiết bị', (await admin.locator('[role=dialog] input').first().inputValue()) === second.ltid);
    await admin.screenshot({ path: join(OUT, '3-form-trong.png') });
    await admin.getByRole('dialog').getByRole('button', { name: 'Đăng ký', exact: true }).click();
    await waitFor('cabinet from the form', async () => (await sql`SELECT 1 FROM cabinets WHERE code = ${second.code} AND ltid = ${second.ltid}`).length === 1);
    check('Duyệt từ form trống thành công', true);
    check('Form chạy dưới CSP thật, không vi phạm', csp3.length === 0, csp3.join(' | ').slice(0, 200));
    await cam3.close();

    // ---------- 4. the board is replaced: new board with the old cabinet code, the old label still on the box ----------
    await boards[0]!.stop();
    const replacement = board(spare);
    boards.push(replacement);
    replacement.start();
    await waitFor('spare board', async () => ((await api.get('/devices/unknown')).data as { ltid: string; replaces: unknown }[]).find((r) => r.ltid === spare.ltid)?.replaces);
    const cam4 = await camera(video1);
    browsers.push(cam4);
    const { page: swap } = await desktop(cam4);
    await signIn(swap, `admin@${DOMAIN}`, pw, totp);
    await swap.goto(`${BASE}/admin/devices`);
    const row2 = swap.getByRole('row').filter({ hasText: spare.ltid });
    await row2.getByRole('button', { name: 'Thay thiết bị' }).waitFor();
    check('Danh sách hiện nút Thay thiết bị cho board mới', (await row2.getByRole('button', { name: 'Duyệt & đăng ký' }).count()) === 0);
    await swap.screenshot({ path: join(OUT, '4-thay-thiet-bi.png') });
    await swap.getByRole('button', { name: 'Đăng ký tủ mới' }).click();
    await swap.getByRole('button', { name: 'Quét mã QR trên tủ' }).click();
    await swap.getByRole('alertdialog').or(swap.getByRole('dialog')).getByRole('button', { name: 'Thay thiết bị' }).click();
    const box = swap.getByRole('dialog').locator('input');
    await box.waitFor();
    await box.fill(await totp());
    await swap.keyboard.press('Enter');
    await swap.getByRole('row').filter({ hasText: spare.ltid }).filter({ hasText: 'Thay thiết bị' }).filter({ hasText: first.code }).waitFor();
    await swap.screenshot({ path: join(OUT, '5-da-thay.png') });
    const moved = (await sql<{ id: string; ltid: string }[]>`SELECT id, ltid FROM cabinets WHERE code = ${first.code}`)[0];
    check('Quét tem cũ để thay board: giữ tủ, chuyển sang ID mới', moved?.id === cabinet!.id && moved?.ltid === spare.ltid);
    await cam4.close();
  } finally {
    await Promise.all(boards.map((b) => b.stop().catch(() => undefined)));
    await Promise.all(browsers.map((b) => b.close().catch(() => undefined)));
    await sleep(1500);
    await cleanup();
  }
  await sql.end();
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n[e2e:qr-flow] ${checks.length - failed.length}/${checks.length} kiểm tra đạt. Ảnh: ${OUT}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
