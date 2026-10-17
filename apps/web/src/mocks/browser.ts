import { getResponse } from 'msw';
import { handlers } from './handlers';
import { onMockEvent } from './db';
import { setTransport } from '@/lib/api';
import { setRealtime } from '@/lib/realtime';

/**
 * M1-UI mock backend, resolved in-page (no Service Worker).
 * A Service Worker is stopped by the browser after ~30 s idle and forgets its clients on restart,
 * after which every /api call fell through to the dev server and the app stopped loading.
 */
export async function startMocks() {
  // Remove the worker registered by earlier builds so it cannot intercept anything.
  const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
  await Promise.all(regs.filter((r) => r.active?.scriptURL.includes('mockServiceWorker')).map((r) => r.unregister()));

  setTransport(async (request) => {
    const res = await getResponse(handlers, request);
    if (res) return res;
    const url = new URL(request.url);
    return new Response(JSON.stringify({ code: 'not_mocked', status: 501, detail: `Chưa có mock cho ${request.method} ${url.pathname}` }), {
      status: 501,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  // Mock realtime: push mock DB events straight to subscribers (real build uses Socket.IO).
  setRealtime({
    subscribe(event, handler) {
      return onMockEvent((e, payload) => {
        if (e === event) handler(payload);
      });
    },
  });
}
