// Smoke test against a running CityLight API (local stack by default): sign in, read, check sanitize.
//   npm run smoke -w @citylight/jarvis -- [6-digit 2FA code]
// Credentials come from JARVIS_SMOKE_EMAIL / JARVIS_SMOKE_PASSWORD (local test accounts only; never a real one in a file).
// Prints timings and sizes, never cookies, passwords or codes. Only GET requests after sign-in, plus logout.
import { ApiClient, ApiProblem } from '../src/api/client';
import { CityLightReads } from '../src/api/read';
import { loadConfig } from '../src/config';
import { sanitizeForLlm } from '../src/sanitize/llm';

const cfg = loadConfig();
const email = process.env.JARVIS_SMOKE_EMAIL;
const password = process.env.JARVIS_SMOKE_PASSWORD;
const code = process.argv[2];
if (!email || !password) {
  console.error('Set JARVIS_SMOKE_EMAIL and JARVIS_SMOKE_PASSWORD (a local test account).');
  process.exit(2);
}

const api = new ApiClient({ baseUrl: cfg.apiBase, timeoutMs: cfg.apiTimeoutMs });
const reads = new CityLightReads(api);

async function step<T>(name: string, fn: () => Promise<T>, show: (v: T) => string = () => '') {
  const t0 = performance.now();
  try {
    const v = await fn();
    console.log(`ok   ${name.padEnd(22)} ${(performance.now() - t0).toFixed(0).padStart(5)} ms  ${show(v)}`);
    return v;
  } catch (e) {
    const why = e instanceof ApiProblem ? `${e.status} ${e.code}: ${e.detail}` : (e as Error).message;
    console.log(`FAIL ${name.padEnd(22)} ${(performance.now() - t0).toFixed(0).padStart(5)} ms  ${why}`);
    return undefined;
  }
}

console.log(`API ${cfg.apiBase}`);
await step('health', () => reads.health(), (h) => h.status);
const login = await step('login', () => api.login(email, password), (r) => r.kind);
if (login?.kind === 'challenge') {
  if (!code) {
    console.error('This account has 2FA: run again with the current 6-digit code as the argument.');
    process.exit(2);
  }
  await step('2fa/verify', () => api.verify2fa({ code }), (u) => u.role);
}
if (!api.signedIn) process.exit(1);

await step('auth/me', () => reads.me(), (u) => `${u.role}, scopeAll=${u.scopeAll}`);
await step('map/stats', () => reads.mapStats(), (s) => `${s.cabinets.total} tủ, online ${s.onlinePct.toFixed(0)}%`);
await step('alarms (open)', () => reads.alarms({ active: true, size: 10 }), (p) => `${p.total} đang mở`);
await step('alarm-rules', () => reads.alarmRules(), (r) => `${r.length} mã`);
await step('areas/tree', () => reads.areaTree(), (t) => `${t.areas.length} khu vực`);
const found = await step('search DM00', () => reads.search('DM00'), (l) => l.map((c) => c.code).join(' ') || '(không có)');
const first = found?.[0];
if (first) {
  const detail = await step(`cabinets/${first.code}`, () => reads.cabinet(first.id), (d) => `${JSON.stringify(d).length} B`);
  await step('diagnostics', () => reads.diagnostics(first.id), (d) => `${d.items.length} mục`);
  await step('telemetry 6h', () => reads.telemetry(first.id, ['vL1', 'leakMa']), (p) => `${p.length} điểm`);
  if (detail) {
    const clean = JSON.stringify(sanitizeForLlm(detail));
    const leaked = ['"ltid"', '"imei"', '"simIccid"'].filter((k) => clean.includes(k));
    console.log(`${leaked.length ? 'FAIL' : 'ok  '} sanitize               ${leaked.length ? `còn ${leaked.join(', ')}` : `${clean.length} B, không còn LTID / IMEI / ICCID`}`);
  }
}
await step('logout', () => api.logout());
