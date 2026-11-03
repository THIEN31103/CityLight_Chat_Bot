// Node-only loader of the service region (S62), kept out of the package index so the web bundle never
// pulls in node:fs or the full polygon. SERVICE_REGION unset or empty = no region (production).
import { readFileSync } from 'node:fs';
import type { ServiceRegion } from './region';

export function loadServiceRegion(id = process.env.SERVICE_REGION ?? ''): ServiceRegion | null {
  if (!id) return null;
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`SERVICE_REGION "${id}": letters, digits and - only`);
  const r = JSON.parse(readFileSync(new URL(`../regions/${id}.json`, import.meta.url), 'utf8')) as ServiceRegion;
  if (r.id !== id || !r.polygons?.length) throw new Error(`regions/${id}.json is not a service region`);
  return r;
}
