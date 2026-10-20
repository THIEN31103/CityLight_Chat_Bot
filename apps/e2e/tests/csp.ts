// E2E_CSP=1: serve every page with the production Content-Security-Policy (copied from infra/Caddyfile, so the
// test follows the real header) and record violations, both the DOM event and Chrome's console message.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';

export const CSP_ON = process.env.E2E_CSP === '1';

export function productionCsp(host: string): string {
  const caddy = readFileSync(fileURLToPath(new URL('../../../infra/Caddyfile', import.meta.url)), 'utf8');
  const m = caddy.match(/Content-Security-Policy "([^"]+)"/);
  if (!m) throw new Error('no Content-Security-Policy line in infra/Caddyfile');
  // wss://{$SITE_HOST} -> the test host (vite preview is http, so also allow its plain ws)
  return m[1]!.replaceAll('{$SITE_HOST}', host).replace(`wss://${host}`, `wss://${host} ws://${host}`);
}

/** Adds the CSP to HTML responses of `page` and returns the list violations are pushed into. */
export async function enforceCsp(page: Page, baseURL: string): Promise<string[]> {
  const violations: string[] = [];
  const csp = productionCsp(new URL(baseURL).host);
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() !== 'document') return route.fallback();
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), 'content-security-policy': csp } });
  });
  await page.exposeFunction('__cspViolation', (v: string) => violations.push(v));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) =>
      (window as unknown as { __cspViolation: (v: string) => void }).__cspViolation(`${e.violatedDirective} ← ${e.blockedURI}`),
    );
  });
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy/i.test(m.text())) violations.push(m.text().slice(0, 300));
  });
  return violations;
}
