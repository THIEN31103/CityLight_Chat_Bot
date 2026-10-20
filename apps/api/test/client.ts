// Shared by the API e2e scripts: a fetch client with a cookie jar + CSRF header (like the browser), TOTP helper.
import { hotp, totpStep } from '../src/totp';

export const BASE = process.env.API_URL ?? 'http://localhost:3000';

/** fetch with a cookie jar and the CSRF header, like the browser. */
export class Client {
  jar = new Map<string, string>();
  csrf = true;
  async call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
    const headers: Record<string, string> = { ...extra, cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ') };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.csrf && this.jar.has('cl_csrf')) headers['x-csrf-token'] = this.jar.get('cl_csrf')!;
    const res = await fetch(`${BASE}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) {
      const [kv, ...attrs] = c.split(';');
      const i = kv!.indexOf('=');
      const k = kv!.slice(0, i).trim();
      const v = kv!.slice(i + 1).trim();
      const expired = attrs.some((a) => /expires=thu, 01 jan 1970/i.test(a)) || v === '';
      if (expired) this.jar.delete(k);
      else this.jar.set(k, decodeURIComponent(v));
    }
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, data };
  }
  get = (p: string) => this.call('GET', p);
  post = (p: string, b: unknown = {}, h: Record<string, string> = {}) => this.call('POST', p, b, h);
  put = (p: string, b: unknown, h: Record<string, string> = {}) => this.call('PUT', p, b, h);
  patch = (p: string, b: unknown) => this.call('PATCH', p, b);
}

export async function login(email: string, password: string) {
  const c = new Client();
  const r = await c.post('/auth/login', { email, password, remember: false });
  return { c, r };
}

/** Next acceptable code: never reuse a step (server rejects steps <= last). */
export function nextCode(secret: Buffer, last: { step: number }) {
  const step = Math.max(totpStep(Date.now()), last.step + 1);
  if (step > totpStep(Date.now()) + 1) throw new Error('no fresh TOTP step yet');
  last.step = step;
  return hotp(secret, step);
}


/** A4 (S45): open the 5-minute re-auth window on this session (user administration, IMEI, decommission). */
export async function reauth(c: Client, secret: Buffer, last: { step: number }) {
  const r = await c.post('/auth/reauth', { code: await freshCode(secret, last) });
  if (r.status !== 200) throw new Error(`reauth failed: ${r.status} ${JSON.stringify(r.data)}`);
}

/** nextCode, waiting (≤ 30 s) when this 30 s window has no unused step left. */
export async function freshCode(secret: Buffer, last: { step: number }) {
  while (last.step + 1 > totpStep(Date.now()) + 1) await new Promise((r) => setTimeout(r, 1000));
  return nextCode(secret, last);
}
