// Area tree = the service region's ward list (S62). SERVICE_REGION=hcm-2025: one district-level row per former
// district "(cũ)", the 168 phường / xã / đặc khu under them, all under the organisation's root unit. Areas not in
// the list are deleted (their user_scopes go with them), except areas a cabinet still uses: those are kept and
// listed. Idempotent. Run once on the trial stack: sh infra/scripts/trial-ctl.sh seed-region
import { loadServiceRegion } from '@citylight/shared/region-node';
import { createSql } from './index';

const region = loadServiceRegion();
if (!region) throw new Error('SERVICE_REGION is not set');
const sql = createSql();

const orgs = await sql<{ id: string }[]>`SELECT id FROM organizations`;
if (orgs.length !== 1) throw new Error(`expected one organisation, found ${orgs.length}`);
const org = orgs[0]!.id;

const summary = await sql.begin(async (tx) => {
  const root = (await tx<{ id: string }[]>`SELECT id FROM areas WHERE organization_id = ${org} AND kind = 'unit' AND parent_id IS NULL`)[0];
  if (!root) throw new Error('no root unit: run seed first');
  const keep = new Set<string>([root.id]);
  let added = 0;
  for (const g of region.groups) {
    let d = (await tx<{ id: string }[]>`SELECT id FROM areas WHERE parent_id = ${root.id} AND kind = 'district' AND name = ${g.name}`)[0];
    if (!d) { d = (await tx<{ id: string }[]>`INSERT INTO areas (organization_id, parent_id, kind, name) VALUES (${org}, ${root.id}, 'district', ${g.name}) RETURNING id`)[0]!; added++; }
    keep.add(d.id);
    for (const w of g.wards) {
      let row = (await tx<{ id: string }[]>`SELECT id FROM areas WHERE parent_id = ${d.id} AND kind = 'ward' AND name = ${w}`)[0];
      if (!row) { row = (await tx<{ id: string }[]>`INSERT INTO areas (organization_id, parent_id, kind, name) VALUES (${org}, ${d.id}, 'ward', ${w}) RETURNING id`)[0]!; added++; }
      keep.add(row.id);
    }
  }
  const ids = [...keep];
  const used = await tx<{ id: string; name: string; cabinets: number }[]>`
    SELECT a.id, a.name, count(c.id)::int AS cabinets FROM areas a JOIN cabinets c ON c.district_id = a.id OR c.ward_id = a.id
    WHERE a.organization_id = ${org} AND NOT (a.id = ANY(${ids}::uuid[])) GROUP BY a.id, a.name`;
  const usedIds = used.map((u) => u.id);
  // a kept old ward keeps its old district too
  const parents = usedIds.length ? await tx<{ parent_id: string }[]>`SELECT DISTINCT parent_id FROM areas WHERE id = ANY(${usedIds}::uuid[]) AND parent_id IS NOT NULL` : [];
  const spare = [...ids, ...usedIds, ...parents.map((p) => p.parent_id)];
  const scopes = (await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM user_scopes s JOIN areas a ON a.id = s.area_id WHERE a.organization_id = ${org} AND NOT (a.id = ANY(${spare}::uuid[]))`)[0]!.n;
  // wards before districts (parent_id has no FK, but keep the tree consistent at every step)
  const wards = await tx`DELETE FROM areas WHERE organization_id = ${org} AND kind = 'ward' AND NOT (id = ANY(${spare}::uuid[]))`;
  const dists = await tx`DELETE FROM areas WHERE organization_id = ${org} AND kind = 'district' AND NOT (id = ANY(${spare}::uuid[]))`;
  return { added, deleted: wards.count + dists.count, scopes, used };
});

const units = region.groups.reduce((n, g) => n + g.wards.length, 0);
console.log(`[seed-region] ${region.id}: ${region.groups.length} groups, ${units} wards (${summary.added} added), ${summary.deleted} other areas deleted, ${summary.scopes} user scopes on them removed`);
for (const u of summary.used) console.log(`[seed-region] kept "${u.name}": still used by ${u.cabinets} cabinet(s), move them then run again`);
await sql.end();
