// M9 dimming end-to-end check: profiles at three levels (system > zone > cabinet) and inheritance,
// validation (422), permission dimming.manage, scope, savings estimate from the real GIS lamps and the
// electricity price, sending still refused (batch + SET_DIMMING → 409), audit. Needs the api only.
// Users *@e2e-dim.citylight.test, zone "E2E Vùng DIM", cabinets E2E.DIM01/02; removed at the end.
// Uses lamp group 3; an existing system profile of group 3 and the settings rows are restored. ~10 s.
// Run: npm run e2e:dimming
import { hash } from '@node-rs/argon2';
import { createSql } from '@citylight/db';
import { defaultDimmingSegments, estimateDimming, type DimmingSegment } from '@citylight/shared';
import { base32Decode } from '../src/totp';
import { login, nextCode } from './client';

const DOMAIN = 'e2e-dim.citylight.test';
const G = 3;
const sql = createSql(process.env.DATABASE_URL, 2);
const checks: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, info?: string) => {
  checks.push({ name, ok });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` — ${info}` : ''}`);
};
const levels = (...pct: number[]): DimmingSegment[] => defaultDimmingSegments().map((s, i) => ({ ...s, levelPct: pct[i] ?? s.levelPct }));

async function main() {
  const cleanup = async () => {
    await sql`DELETE FROM cabinets WHERE ltid IN ('E2EDIM01', 'E2EDIM02')`;
    await sql`DELETE FROM zones WHERE name = 'E2E Vùng DIM'`;
    await sql`DELETE FROM users WHERE email LIKE ${'%@' + DOMAIN}`;
  };
  await cleanup();
  const keepSystem = (await sql<{ segments: unknown }[]>`SELECT segments FROM dimming_profiles WHERE cabinet_id IS NULL AND zone_id IS NULL AND lamp_group = ${G}`)[0];
  // saving the price rewrites every setting row: put all of them back as they were afterwards
  const SETTING_KEYS = ['price_per_kwh', 'offline_after_s', 'lamp_group_labels'];
  const keepSettings = await sql<{ key: string; value: unknown; updated_at: Date; updated_by: string | null }[]>`SELECT key, value, updated_at, updated_by FROM system_settings WHERE key = ANY(${SETTING_KEYS})`;
  await sql`DELETE FROM dimming_profiles WHERE cabinet_id IS NULL AND zone_id IS NULL AND lamp_group = ${G}`;

  const org = (await sql<{ id: string }[]>`SELECT id FROM organizations LIMIT 1`)[0]!.id;
  const [dX, dY] = await sql<{ id: string }[]>`SELECT id FROM areas WHERE name IN ('Quận 5', 'Quận 8') AND kind = 'district' ORDER BY name`;
  const zone = (await sql<{ id: string }[]>`INSERT INTO zones (organization_id, name, center) VALUES (${org}, 'E2E Vùng DIM', ST_SetSRID(ST_MakePoint(106.66, 10.75), 4326)) RETURNING id`)[0]!.id;
  const cabs = await sql<{ id: string; ltid: string }[]>`
    INSERT INTO cabinets (organization_id, ltid, code, name, district_id, zone1_id, location) VALUES
      (${org}, 'E2EDIM01', 'E2E.DIM01', 'E2E tủ tiết giảm 1', ${dX!.id}, ${zone}, ST_SetSRID(ST_MakePoint(106.66, 10.75), 4326)),
      (${org}, 'E2EDIM02', 'E2E.DIM02', 'E2E tủ tiết giảm 2', ${dX!.id}, ${zone}, ST_SetSRID(ST_MakePoint(106.661, 10.751), 4326))
    RETURNING id, ltid`;
  const c1 = cabs.find((c) => c.ltid === 'E2EDIM01')!.id;
  const c2 = cabs.find((c) => c.ltid === 'E2EDIM02')!.id;
  // GIS: cabinet 1 = 3 poles × 2 lamps of group 3 at 150 W (+1 lamp of group 1, not counted); cabinet 2 = 1 lamp of group 3 without power
  const [r1] = await sql<{ id: string }[]>`INSERT INTO routes (cabinet_id, code, branch) VALUES (${c1}, 'E2E.DIM01_N1', 1) RETURNING id`;
  const [r2] = await sql<{ id: string }[]>`INSERT INTO routes (cabinet_id, code, branch) VALUES (${c2}, 'E2E.DIM02_N1', 1) RETURNING id`;
  for (let i = 1; i <= 3; i++) {
    const [p] = await sql<{ id: string }[]>`
      INSERT INTO poles (route_id, code, location, lamp_count, seq) VALUES (${r1!.id}, ${`E2E.DIM01_N1_${i}`}, ST_SetSRID(ST_MakePoint(${106.66 + i * 0.0003}, 10.75), 4326), 2, ${i}) RETURNING id`;
    await sql`INSERT INTO lamps (pole_id, code, lamp_group, rated_power_w) VALUES (${p!.id}, ${`E2E.DIM01_N1_${i}_D1`}, ${G}, 150), (${p!.id}, ${`E2E.DIM01_N1_${i}_D2`}, ${G}, 150)`;
    if (i === 1) await sql`INSERT INTO lamps (pole_id, code, lamp_group, rated_power_w) VALUES (${p!.id}, 'E2E.DIM01_N1_1_D3', 1, 100)`;
  }
  const [p2] = await sql<{ id: string }[]>`INSERT INTO poles (route_id, code, location, seq) VALUES (${r2!.id}, 'E2E.DIM02_N1_1', ST_SetSRID(ST_MakePoint(106.6613, 10.751), 4326), 1) RETURNING id`;
  await sql`INSERT INTO lamps (pole_id, code, lamp_group, rated_power_w) VALUES (${p2!.id}, 'E2E.DIM02_N1_1_D1', ${G}, NULL)`;

  const pw = `Dim-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const h = await hash(pw);
  const users = await sql<{ id: string; email: string }[]>`
    INSERT INTO users (organization_id, email, full_name, password_hash, role, scope_all) VALUES
      (${org}, ${'admin@' + DOMAIN}, 'E2E dim admin', ${h}, 'admin', true),
      (${org}, ${'opx@' + DOMAIN}, 'E2E dim operator X', ${h}, 'operator', false),
      (${org}, ${'opy@' + DOMAIN}, 'E2E dim operator Y', ${h}, 'operator', false),
      (${org}, ${'view@' + DOMAIN}, 'E2E dim viewer', ${h}, 'viewer', true)
    RETURNING id, email`;
  const uid = (p: string) => users.find((u) => u.email.startsWith(p))!.id;
  await sql`INSERT INTO user_scopes (user_id, area_id) VALUES (${uid('opx')}, ${dX!.id}), (${uid('opy')}, ${dY!.id})`;
  const twoFa = async (email: string) => {
    const { c } = await login(email, pw);
    const s = await c.post('/auth/2fa/setup');
    await c.post('/auth/2fa/enable', { code: nextCode(base32Decode(s.data.secret), { step: 0 }) });
    return c;
  };
  const admin = await twoFa(`admin@${DOMAIN}`);
  const opx = await twoFa(`opx@${DOMAIN}`);
  const opy = await twoFa(`opy@${DOMAIN}`);
  const { c: view } = await login(`view@${DOMAIN}`, pw);

  try {
    // ---------- price setting ----------
    const st = await admin.get('/settings');
    const setPrice = (v: number) => admin.put('/settings', { offlineAfterS: st.data.offlineAfterS, lampGroupLabels: st.data.lampGroupLabels, pricePerKwh: v });
    check('Cấu hình có giá điện (mặc định 2.000 đ/kWh)', st.status === 200 && typeof st.data.pricePerKwh === 'number', `${st.data.pricePerKwh}`);
    check('Lưu giá điện 2.500 đ/kWh', (await setPrice(2500)).data?.pricePerKwh === 2500);

    // ---------- defaults + inheritance ----------
    const s0 = await admin.get(`/dimming-profiles/${G}`);
    check('Chưa lưu gì → hệ thống dùng mặc định có sẵn', s0.status === 200 && s0.data.source === 'default' && s0.data.segments.length === 5);
    const cab0 = await admin.get(`/cabinets/${c1}/dimming?group=${G}`);
    check('Tủ chưa có hồ sơ → kế thừa (mặc định)', cab0.data.source === 'default' && cab0.data.inheritedFromZone === true);

    // ---------- permission / scope / validation ----------
    check('Giám sát không lưu được → 403', (await view.put(`/dimming-profiles/${G}`, { segments: levels() })).status === 403);
    const opSys = await opx.put(`/dimming-profiles/${G}`, { segments: levels() });
    check('Điều hành theo khu vực không sửa hồ sơ hệ thống → 403', opSys.status === 403 && opSys.data.code === 'forbidden_scope');
    const gap = levels();
    gap[2]!.startMin = 1450;
    const bad = await admin.put(`/dimming-profiles/${G}`, { segments: gap });
    check('Thời đoạn hở → 422 nêu thời đoạn', bad.status === 422 && bad.data.detail.includes('Thời đoạn 3'), bad.data?.detail);
    const six = [...levels(), { enabled: true, startMin: 1785, endMin: 1800, levelPct: 100 }];
    check('6 thời đoạn → 422, mức 120 % → 422',
      (await admin.put(`/dimming-profiles/${G}`, { segments: six })).status === 422 && (await admin.put(`/cabinets/${c1}/dimming`, { lampGroup: G, segments: levels(100, 120) })).status === 422);
    check('Điều hành ngoài khu vực không xem / sửa được tủ',
      [403, 404].includes((await opy.get(`/cabinets/${c1}/dimming?group=${G}`)).status) && [403, 404].includes((await opy.put(`/cabinets/${c1}/dimming`, { lampGroup: G, segments: levels() })).status));

    // ---------- three levels ----------
    const sys = levels(100, 80, 60, 80, 100);
    const zon = levels(100, 70, 40, 70, 100);
    const own = levels(100, 50, 30, 50, 100);
    const ps = await admin.put(`/dimming-profiles/${G}`, { segments: sys });
    check('Lưu hồ sơ toàn hệ thống', ps.status === 200 && ps.data.source === 'system');
    const viaSys = await admin.get(`/cabinets/${c1}/dimming?group=${G}`);
    check('Tủ kế thừa hồ sơ hệ thống', viaSys.data.source === 'system' && viaSys.data.segments[2].levelPct === 60);
    const pz = await admin.put(`/dimming-profiles/${G}?zoneId=${zone}`, { segments: zon });
    check('Lưu hồ sơ vùng', pz.status === 200 && pz.data.source === 'zone' && pz.data.inheritedFromZone === false);
    check('Tủ trong vùng kế thừa hồ sơ vùng', (await admin.get(`/cabinets/${c2}/dimming?group=${G}`)).data.source === 'zone');
    const pc = await opx.put(`/cabinets/${c1}/dimming`, { lampGroup: G, segments: own });
    check('Điều hành trong khu vực lưu hồ sơ riêng cho tủ', pc.status === 200 && pc.data.source === 'cabinet' && pc.data.segments[2].levelPct === 30);
    check('Tủ khác vẫn theo vùng; nhóm đèn khác không bị ảnh hưởng',
      (await admin.get(`/cabinets/${c2}/dimming?group=${G}`)).data.segments[2].levelPct === 40 && (await admin.get(`/cabinets/${c1}/dimming?group=1`)).data.source !== 'cabinet');

    // ---------- estimate from GIS lamps ----------
    const e1 = pc.data.estimate;
    const want1 = estimateDimming(own, 6, 900, 2500);
    check('Ước tính tủ = 6 đèn × 150 W của nhóm, theo giá đã đặt',
      e1.lamps === 6 && e1.ratedW === 900 && e1.kwhPerNight === want1.kwhPerNight && e1.vndPerYear === want1.vndPerYear && e1.pricePerKwh === 2500,
      `${e1.kwhPerNight} kWh/đêm, ${e1.vndPerYear} đ/năm`);
    const ez = pz.data.estimate;
    check('Ước tính vùng = 7 đèn (1 đèn chưa có công suất), 900 W', ez.lamps === 7 && ez.ratedW === 900 && ez.lampsWithoutPower === 1);
    check('Hệ thống gồm cả đèn của vùng thử', ps.data.estimate.lamps >= 0 && (await admin.get(`/dimming-profiles/${G}`)).data.estimate.lamps >= 7);
    await setPrice(0);
    const noPrice = (await admin.get(`/cabinets/${c1}/dimming?group=${G}`)).data.estimate;
    check('Giá điện 0 → chỉ có kWh, không có tiền', noPrice.vndPerYear === null && noPrice.kwhPerNight === want1.kwhPerNight);
    const opyZone = (await opy.get(`/dimming-profiles/${G}?zoneId=${zone}`)).data.estimate;
    check('Ước tính theo phạm vi người xem (ngoài khu vực → 0 đèn)', opyZone.lamps === 0, `${opyZone.lamps}`);

    // ---------- drop own profiles ----------
    check('Bỏ hồ sơ riêng của tủ → về hồ sơ vùng',
      (await admin.call('DELETE', `/cabinets/${c1}/dimming?group=${G}`)).status === 204 && (await admin.get(`/cabinets/${c1}/dimming?group=${G}`)).data.source === 'zone');
    check('Bỏ lần nữa → 404', (await admin.call('DELETE', `/cabinets/${c1}/dimming?group=${G}`)).status === 404);
    check('Bỏ hồ sơ vùng → tủ về hồ sơ hệ thống',
      (await admin.call('DELETE', `/dimming-profiles/${G}?zoneId=${zone}`)).status === 204 && (await admin.get(`/cabinets/${c1}/dimming?group=${G}`)).data.source === 'system');

    // ---------- sending stays blocked ----------
    const batch = await admin.post('/command-batches', { kind: 'dimming', zoneIds: [zone] });
    check('Đồng bộ tiết giảm hàng loạt → 409 nêu lý do (trước khi hỏi OTP)', batch.status === 409 && batch.data.code === 'capability_unsupported' && batch.data.detail.includes('chưa hỗ trợ tiết giảm'), batch.data?.detail);
    const cmd = await admin.post(`/cabinets/${c1}/commands`, { type: 'SET_DIMMING', params: {} }, { 'Idempotency-Key': crypto.randomUUID() });
    check('Lệnh SET_DIMMING tới tủ → 409 capability_unsupported', cmd.status === 409 && cmd.data.code === 'capability_unsupported');

    // ---------- audit ----------
    const logs = await sql<{ user_id: string; action: string }[]>`
      SELECT user_id, action FROM activity_logs WHERE user_id = ANY(${[uid('admin'), uid('opx')]}::uuid[]) AND action LIKE '%tiết giảm%'`;
    const n = (a: string) => logs.filter((l) => l.action === a).length;
    check('Nhật ký: 3 lần lưu, 2 lần bỏ hồ sơ riêng', n('Lưu hồ sơ tiết giảm') === 3 && n('Bỏ hồ sơ tiết giảm riêng') === 2, `${n('Lưu hồ sơ tiết giảm')}/${n('Bỏ hồ sơ tiết giảm riêng')}`);
  } finally {
    await cleanup();
    await sql`DELETE FROM dimming_profiles WHERE cabinet_id IS NULL AND zone_id IS NULL AND lamp_group = ${G}`;
    if (keepSystem) await sql`INSERT INTO dimming_profiles (lamp_group, segments) VALUES (${G}, ${sql.json(keepSystem.segments as never)})`;
    await sql`DELETE FROM system_settings WHERE key = ANY(${SETTING_KEYS})`;
    for (const k of keepSettings)
      await sql`INSERT INTO system_settings (key, value, updated_at, updated_by) VALUES (${k.key}, ${sql.json(k.value as never)}, ${k.updated_at}, ${k.updated_by})`;
    await sql.end();
  }
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await sql.end().catch(() => undefined);
  process.exit(1);
});
