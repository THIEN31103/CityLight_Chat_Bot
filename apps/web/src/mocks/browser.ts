import { getResponse } from 'msw';
import type { User } from '@citylight/shared';
import { handlers, setMockSessionUser } from './handlers';
import { onMockEvent } from './db';
import { setTransport } from '@/lib/api';
import { setRealtime } from '@/lib/realtime';
import { createSocketRealtime } from '@/lib/realtime-socket';

async function mockResponse(request: Request): Promise<Response> {
  const res = await getResponse(handlers, request);
  if (res) return res;
  const url = new URL(request.url);
  return new Response(JSON.stringify({ code: 'not_mocked', status: 501, detail: `Chưa có mock cho ${request.method} ${url.pathname}` }), {
    status: 501,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Mock backend resolved in-page (no Service Worker: the browser stops an idle SW after ~30 s and it
 * forgets its clients, after which every /api call fell through to the dev server).
 *
 * mode 'mock'   — everything from the in-page handlers + mock realtime (Cloudflare demo).
 * mode 'hybrid' — real API first; only routes the API does not have yet (code route_not_found) fall
 *                 back to the mock handlers. Realtime = Socket.IO from the real API.
 */
export async function startMocks(mode: 'mock' | 'hybrid' = 'mock') {
  const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
  await Promise.all(regs.filter((r) => r.active?.scriptURL.includes('mockServiceWorker')).map((r) => r.unregister()));

  if (mode === 'mock') {
    setTransport(mockResponse);
    setRealtime({
      subscribe(event, handler) {
        return onMockEvent((e, payload) => {
          if (e === event) handler(payload);
        });
      },
    });
    return;
  }

  setTransport(async (request) => {
    const backup = request.clone();
    const res = await fetch(request);
    const path = new URL(request.url).pathname;
    if (res.ok && /\/auth\/(me|login|2fa\/verify)$/.test(path)) {
      // keep the mock handlers' session in step so fallback routes accept the real user
      const body = (await res.clone().json().catch(() => null)) as { user?: User } | User | null;
      const user = body && 'user' in body ? body.user : (body as User | null);
      if (user?.id) setMockSessionUser(user);
    }
    if (res.status === 404) {
      const p = (await res.clone().json().catch(() => null)) as { code?: string } | null;
      if (p?.code === 'route_not_found') return mockResponse(backup);
    }
    return res;
  });
  setRealtime(createSocketRealtime());
}
