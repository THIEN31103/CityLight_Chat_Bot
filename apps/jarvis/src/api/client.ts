// HTTP client for the CityLight API (/api/v1), signed in as the operator at the console (spec 10).
// Verified against apps/api/src/auth.ts: session cookie cl_sid (httpOnly), CSRF double-submit (cookie cl_csrf ->
// header x-csrf-token on every non-GET), 2FA challenge cookie cl_2fa scoped to /api/v1/auth, RFC 9457 errors.
// Cookies live in memory only and are never logged.
import type { User } from '@citylight/shared';

export const SESSION_COOKIE = 'cl_sid';
export const CSRF_COOKIE = 'cl_csrf';
export const CSRF_HEADER = 'x-csrf-token';
const IDEMPOTENCY = /^[\w-]{8,100}$/;

/** RFC 9457 problem body as the API sends it (apps/api/src/infra.ts problem()). */
export interface Problem {
  type?: string;
  title?: string;
  status: number;
  detail: string;
  code: string;
  params?: Record<string, string | number>;
}

export class ApiProblem extends Error {
  constructor(readonly status: number, readonly code: string, readonly detail: string, readonly params?: Record<string, string | number>) {
    super(`${status} ${code}: ${detail}`);
    this.name = 'ApiProblem';
  }
}

export type LoginResult = { kind: 'session'; user: User } | { kind: 'challenge' };

interface Cookie {
  value: string;
  path: string;
  expires: number | null;
}

export interface ApiClientOptions {
  baseUrl: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Idempotency-Key header (commands); 8-100 characters [\w-] */
  idempotencyKey?: string;
}

export class ApiClient {
  private readonly jar = new Map<string, Cookie>();
  private readonly base: URL;
  private readonly doFetch: typeof fetch;

  constructor(private readonly opts: ApiClientOptions) {
    this.base = new URL(`${opts.baseUrl.replace(/\/+$/, '')}/`);
    this.doFetch = opts.fetch ?? fetch;
  }

  get signedIn() {
    return this.cookie(SESSION_COOKIE, '/') !== undefined;
  }

  // ---------- auth ----------

  async login(email: string, password: string, signal?: AbortSignal): Promise<LoginResult> {
    const r = await this.request<{ requires2fa: boolean; user?: User }>('POST', 'auth/login', { email, password, remember: false }, { signal });
    if (r.requires2fa) return { kind: 'challenge' };
    if (!r.user) throw new ApiProblem(502, 'bad_response', 'Máy chủ không trả thông tin người dùng');
    return { kind: 'session', user: r.user };
  }

  /** Second step with the 6-digit TOTP code (or a recovery code); the challenge cookie came with login(). */
  async verify2fa(input: { code: string } | { recoveryCode: string }, signal?: AbortSignal): Promise<User> {
    const r = await this.request<{ user: User }>('POST', 'auth/2fa/verify', input, { signal });
    return r.user;
  }

  /** Step-up for 403 reauth_required: opens a short window on this session (apps/api/src/auth.ts REAUTH_TTL_S). */
  reauth(code: string, signal?: AbortSignal) {
    return this.request<{ validForS: number }>('POST', 'auth/reauth', { code }, { signal });
  }

  me(signal?: AbortSignal) {
    return this.request<User>('GET', 'auth/me', undefined, { signal });
  }

  async logout(signal?: AbortSignal) {
    try {
      if (this.signedIn) await this.request('POST', 'auth/logout', undefined, { signal });
    } finally {
      this.jar.clear();
    }
  }

  // ---------- generic ----------

  get<T>(path: string, query?: Record<string, string | number | boolean | undefined>, o: RequestOptions = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) qs.set(k, String(v));
    const q = qs.toString();
    return this.request<T>('GET', q ? `${path}?${q}` : path, undefined, o);
  }

  post<T>(path: string, body?: unknown, o: RequestOptions = {}) {
    return this.request<T>('POST', path, body, o);
  }

  async request<T = unknown>(method: string, path: string, body?: unknown, o: RequestOptions = {}): Promise<T> {
    const url = new URL(path.replace(/^\/+/, ''), this.base);
    const headers: Record<string, string> = { accept: 'application/json' };
    const cookie = this.cookieHeader(url.pathname);
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      const csrf = this.cookie(CSRF_COOKIE, url.pathname);
      if (csrf) headers[CSRF_HEADER] = csrf;
    }
    if (o.idempotencyKey !== undefined) {
      if (!IDEMPOTENCY.test(o.idempotencyKey)) throw new Error('Idempotency-Key must be 8-100 characters [A-Za-z0-9_-]');
      headers['idempotency-key'] = o.idempotencyKey;
    }
    const timeout = AbortSignal.timeout(o.timeoutMs ?? this.opts.timeoutMs);
    const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;

    let res: Response;
    try {
      res = await this.doFetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal, redirect: 'manual' });
    } catch (e) {
      if (o.signal?.aborted) throw e;
      if (timeout.aborted) throw new ApiProblem(504, 'timeout', 'Máy chủ CityLight không trả lời kịp');
      throw new ApiProblem(503, 'unreachable', 'Không kết nối được máy chủ CityLight');
    }
    this.storeCookies(res);
    const text = await res.text();
    const data = text ? safeJson(text) : undefined;
    if (!res.ok) {
      if (res.status === 401) this.dropSession();
      const p = (data && typeof data === 'object' ? data : {}) as Partial<Problem>;
      throw new ApiProblem(res.status, p.code ?? `http_${res.status}`, p.detail ?? res.statusText, p.params);
    }
    return data as T;
  }

  // ---------- cookies (in memory, never logged) ----------

  private storeCookies(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';');
      const eq = pair?.indexOf('=') ?? -1;
      if (!pair || eq < 1) continue;
      const name = pair.slice(0, eq).trim();
      const value = decodeURIComponent(pair.slice(eq + 1).trim());
      let cookiePath = '/';
      let expires: number | null = null;
      for (const a of attrs) {
        const [k, ...rest] = a.split('=');
        const key = k?.trim().toLowerCase();
        const v = rest.join('=').trim();
        if (key === 'path' && v) cookiePath = v;
        else if (key === 'max-age') expires = Date.now() + Number(v) * 1000;
        else if (key === 'expires' && expires === null) expires = Date.parse(v);
      }
      const k = `${cookiePath}\u0000${name}`;
      if (!value || (expires !== null && expires <= Date.now())) this.jar.delete(k);
      else this.jar.set(k, { value, path: cookiePath, expires });
    }
  }

  private dropSession() {
    for (const k of [...this.jar.keys()]) if (k.endsWith(`\u0000${SESSION_COOKIE}`) || k.endsWith(`\u0000${CSRF_COOKIE}`)) this.jar.delete(k);
  }

  private live(): [string, Cookie][] {
    const now = Date.now();
    const out: [string, Cookie][] = [];
    for (const [k, c] of this.jar) {
      if (c.expires !== null && c.expires <= now) this.jar.delete(k);
      else out.push([k.split('\u0000')[1]!, c]);
    }
    return out;
  }

  private cookie(name: string, requestPath: string) {
    return this.live().find(([n, c]) => n === name && pathMatches(requestPath, c.path))?.[1].value;
  }

  private cookieHeader(requestPath: string) {
    return this.live()
      .filter(([, c]) => pathMatches(requestPath, c.path))
      .map(([n, c]) => `${n}=${encodeURIComponent(c.value)}`)
      .join('; ');
  }
}

function pathMatches(requestPath: string, cookiePath: string) {
  if (cookiePath === '/' || requestPath === cookiePath) return true;
  return requestPath.startsWith(cookiePath.endsWith('/') ? cookiePath : `${cookiePath}/`);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
