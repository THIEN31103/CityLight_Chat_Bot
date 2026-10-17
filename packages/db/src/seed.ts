// Base data: organisation, management units, districts/wards, zones, field map, admin user.
// Idempotent: re-running keeps existing rows. Admin credentials come from env (never hard-coded):
//   SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD (>= 12 chars).
import { hash } from '@node-rs/argon2';
import { eq } from 'drizzle-orm';
import { DEFAULT_FIELD_MAP } from '@citylight/shared';
import { createDb } from './index';
import { areas, deviceFieldMap, managementUnits, organizations, users, zones } from './schema';
import { DISTRICTS, MANAGEMENT_UNITS, ZONES } from './fixtures';

const { db, client } = createDb();

const ORG = 'Đơn vị vận hành CityLight';
let org = (await db.select().from(organizations).where(eq(organizations.name, ORG)))[0];
if (!org) org = (await db.insert(organizations).values({ name: ORG }).returning())[0]!;

for (const name of MANAGEMENT_UNITS) {
  const found = await db.select().from(managementUnits).where(eq(managementUnits.name, name));
  if (!found.length) await db.insert(managementUnits).values({ organizationId: org.id, name });
}

let root = (await db.select().from(areas).where(eq(areas.name, ORG)))[0];
if (!root) root = (await db.insert(areas).values({ organizationId: org.id, kind: 'unit', name: ORG }).returning())[0]!;
for (const d of DISTRICTS) {
  let dist = (await db.select().from(areas).where(eq(areas.name, d.name)))[0];
  if (!dist) dist = (await db.insert(areas).values({ organizationId: org.id, parentId: root.id, kind: 'district', name: d.name }).returning())[0]!;
  const wards = await db.select().from(areas).where(eq(areas.parentId, dist.id));
  for (let w = wards.length + 1; w <= d.wards; w++) {
    await db.insert(areas).values({ organizationId: org.id, parentId: dist.id, kind: 'ward', name: `Phường ${w}` });
  }
}

for (const z of ZONES) {
  const found = await db.select().from(zones).where(eq(zones.name, z.name));
  if (!found.length) await db.insert(zones).values({ organizationId: org.id, name: z.name, center: { x: z.lng, y: z.lat } });
}

for (const f of DEFAULT_FIELD_MAP) {
  await db.insert(deviceFieldMap).values({ ...f, scale: f.scale ?? null }).onConflictDoNothing();
}

const email = process.env.SEED_ADMIN_EMAIL;
const password = process.env.SEED_ADMIN_PASSWORD;
if (email && password) {
  if (password.length < 12) throw new Error('SEED_ADMIN_PASSWORD must be >= 12 characters');
  const existing = await db.select().from(users).where(eq(users.email, email));
  if (!existing.length) {
    await db.insert(users).values({ organizationId: org.id, email, fullName: 'Quản trị hệ thống', role: 'admin', passwordHash: await hash(password) });
    console.log(`[seed] admin user ${email} created`);
  }
} else {
  console.log('[seed] SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD not set: no admin user created');
}

console.log(`[seed] organisation, ${MANAGEMENT_UNITS.length} management units, ${DISTRICTS.length} districts, ${ZONES.length} zones, field map ready`);
await client.end();
