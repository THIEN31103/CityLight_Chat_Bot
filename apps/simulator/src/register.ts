// Registers the simulator fleet (SIM0001..N) as cabinets in the DB, at the same deterministic positions
// the simulator reports in LGPS. Idempotent (ON CONFLICT ltid DO NOTHING).
//   npm run sim:register -- --count 10000
import { eq, inArray, sql } from 'drizzle-orm';
import { createDb, schema } from '@citylight/db';
import { DISTRICTS, MANAGEMENT_UNITS, ZONES, fleetLocation } from '@citylight/db/fixtures';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const count = Number(arg('count', '100'));
const prefix = arg('prefix', 'SIM');

const { db, client } = createDb();
const org = (await db.select().from(schema.organizations).limit(1))[0];
if (!org) throw new Error('Run `npm run db:seed` first');

const districtRows = await db.select().from(schema.areas).where(inArray(schema.areas.name, DISTRICTS.map((d) => d.name)));
const districtId = new Map(districtRows.map((a) => [a.name, a.id]));
const wardRows = await db.select().from(schema.areas).where(eq(schema.areas.kind, 'ward'));
const wardsOf = new Map<string, string[]>();
for (const w of wardRows) wardsOf.set(w.parentId!, [...(wardsOf.get(w.parentId!) ?? []), w.id]);
const muRows = await db.select().from(schema.managementUnits);
const muId = new Map(muRows.map((m) => [m.name, m.id]));
const zoneRows = await db.select().from(schema.zones);
const zoneOfDistrict = new Map<string, string>();
for (const z of ZONES) {
  const id = zoneRows.find((r) => r.name === z.name)?.id;
  if (id) z.districts.forEach((d) => zoneOfDistrict.set(d, id));
}

const STREETS = ['Nguyễn Huệ', 'Lê Lợi', 'Hai Bà Trưng', 'Điện Biên Phủ', 'Cách Mạng Tháng 8', 'Võ Văn Kiệt', 'Nguyễn Văn Linh', 'Phạm Văn Đồng', 'Lý Thường Kiệt', 'Trường Chinh', 'Cộng Hòa', 'Quang Trung'];

let inserted = 0;
const BATCH = 1000;
for (let start = 0; start < count; start += BATCH) {
  const rows = [];
  for (let i = start; i < Math.min(count, start + BATCH); i++) {
    const loc = fleetLocation(i);
    const d = DISTRICTS[loc.district]!;
    const dId = districtId.get(d.name) ?? null;
    const wards = dId ? wardsOf.get(dId) ?? [] : [];
    const street = STREETS[i % STREETS.length]!;
    rows.push({
      organizationId: org.id,
      ltid: `${prefix}${String(i + 1).padStart(4, '0')}`,
      code: `TL${String(loc.district + 1).padStart(2, '0')}.${String(i + 1).padStart(4, '0')}`,
      name: `${street} ${(i % 9) + 1}`,
      address: `${(i * 37) % 500 + 1} ${street}`,
      street,
      districtId: dId,
      wardId: wards.length ? wards[i % wards.length]! : null,
      managementUnitId: muId.get(MANAGEMENT_UNITS[loc.district % MANAGEMENT_UNITS.length]!) ?? null,
      zone1Id: zoneOfDistrict.get(d.name) ?? null,
      location: { x: loc.lng, y: loc.lat },
      installedAt: new Date(Date.now() - ((i * 7919) % 900) * 86_400_000),
    });
  }
  const res = await db.insert(schema.cabinets).values(rows).onConflictDoNothing({ target: schema.cabinets.ltid }).returning({ id: schema.cabinets.id });
  inserted += res.length;
}
// every cabinet gets a state row (offline until its first frame)
await db.execute(sql`INSERT INTO cabinet_state (cabinet_id, status, online) SELECT id, 'offline', false FROM cabinets ON CONFLICT DO NOTHING`);
console.log(`[register] ${inserted} new cabinets (${count} requested, prefix ${prefix})`);
await client.end();
