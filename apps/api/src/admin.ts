// Administration (spec S16, M8): areas, management units, zones (+ assigning cabinets), cabinet
// registration / edit / decommission, telemetry field map (read-only + unknown keys), settings.
// Every change is audited; the ingest worker / scheduler reload over Redis.
import { Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Module, Param, Patch, Post, Put, Req } from '@nestjs/common';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { DEFAULT_FIELD_MAP, LAMP_GROUP_LABELS, OFFLINE_AFTER_MS } from '@citylight/shared';
import { SCHEDULES_CHANNEL } from '@citylight/db/batches';
import { CONFIG_CHANNEL } from '@citylight/db/notify';
import { RequirePerm, type AuthedRequest, type SessionUser } from './auth';
import { CabinetsModule, CabinetsService } from './cabinets';
import { ApiError } from './errors';
import { REDIS, SQL, type Sql } from './infra';

const uuid = z.string().uuid();
const Name = z.string().trim().min(1).max(120);
const Point = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
const CabinetCode = z.string().trim().min(2).max(40).regex(/^[\w.-]+$/, 'chỉ chữ, số, . _ -');
const Ltid = z.string().trim().min(1).max(32).regex(/^[A-Za-z0-9_-]+$/).transform((s) => s.toUpperCase());

const CabinetBody = z.object({
  ltid: Ltid,
  code: CabinetCode,
  name: Name,
  location: Point,
  address: z.string().trim().max(300).nullish(),
  street: z.string().trim().max(120).nullish(),
  districtId: uuid.nullish(),
  wardId: uuid.nullish(),
  managementUnitId: uuid.nullish(),
  zone1Id: uuid.nullish(),
  fwProfile: z.enum(['v2-1307ebc', 'v2-current', 'v3']).default('v2-current'),
  notes: z.string().trim().max(2000).nullish(),
});
const CabinetPatch = CabinetBody.partial().omit({ fwProfile: true }).extend({ fwProfile: z.enum(['v2-1307ebc', 'v2-current', 'v3']).optional() });

export const SETTING_DEFAULTS = { offline_after_s: OFFLINE_AFTER_MS / 1000, lamp_group_labels: LAMP_GROUP_LABELS as Record<string, string> };
const SettingsBody = z.object({
  offlineAfterS: z.number().int().min(30).max(900),
  lampGroupLabels: z.record(z.enum(['0', '1', '2', '3']), z.string().trim().min(1).max(40)),
});

@Injectable()
export class AdminService {
  constructor(
    @Inject(SQL) private readonly sql: Sql,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CabinetsService) private readonly cabinets: CabinetsService,
  ) {}

  private log(u: SessionUser, action: string, type: string, id: string | null, name: string, value: string | null, ip?: string) {
    return this.sql`INSERT INTO activity_logs (user_id, user_email, action, target_type, target_id, target_name, new_value, ip)
                    VALUES (${u.id}, ${u.email}, ${action}, ${type}, ${id}, ${name}, ${value}, ${ip ?? null})`;
  }
  private reload(type: 'registry' | 'settings') {
    if (type === 'registry') this.cabinets.invalidateMap();
    return this.redis.publish(CONFIG_CHANNEL, JSON.stringify({ type })).catch(() => undefined);
  }

  // ---------------- areas ----------------

  async createArea(u: SessionUser, body: unknown, ip?: string) {
    const b = z.object({ kind: z.enum(['district', 'ward']), name: Name, parentId: uuid }).parse(body);
    const parent = (await this.sql<{ kind: string }[]>`SELECT kind FROM areas WHERE id = ${b.parentId} AND organization_id = ${u.organizationId}`)[0];
    if (!parent || parent.kind !== (b.kind === 'district' ? 'unit' : 'district'))
      throw new ApiError(422, 'invalid_parent', b.kind === 'district' ? 'Quận phải nằm dưới một đơn vị' : 'Phường phải nằm dưới một quận');
    const dup = await this.sql`SELECT 1 FROM areas WHERE parent_id = ${b.parentId} AND lower(name) = lower(${b.name})`;
    if (dup.length) throw new ApiError(409, 'duplicate', `"${b.name}" đã có`);
    const row = (await this.sql<{ id: string }[]>`
      INSERT INTO areas (organization_id, parent_id, kind, name) VALUES (${u.organizationId}, ${b.parentId}, ${b.kind}, ${b.name}) RETURNING id`)[0]!;
    await this.log(u, 'Thêm khu vực', 'area', row.id, b.name, b.kind, ip);
    return { id: row.id, ...b };
  }

  async renameArea(u: SessionUser, id: string, body: unknown, ip?: string) {
    const b = z.object({ name: Name }).parse(body);
    const r = (await this.sql<{ name: string }[]>`UPDATE areas SET name = ${b.name} WHERE id = ${uuid.parse(id)} AND organization_id = ${u.organizationId} RETURNING name`)[0];
    if (!r) throw new ApiError(404, 'not_found', 'Không tìm thấy khu vực');
    await this.log(u, 'Đổi tên khu vực', 'area', id, b.name, null, ip);
    return { id, name: b.name };
  }

  async deleteArea(u: SessionUser, id: string, ip?: string) {
    const aid = uuid.parse(id);
    const a = (await this.sql<{ name: string; kind: string }[]>`SELECT name, kind FROM areas WHERE id = ${aid} AND organization_id = ${u.organizationId}`)[0];
    if (!a) throw new ApiError(404, 'not_found', 'Không tìm thấy khu vực');
    if (a.kind === 'unit') throw new ApiError(409, 'in_use', 'Không xóa đơn vị gốc');
    const use = (await this.sql<{ cab: number; child: number; scopes: number }[]>`
      SELECT (SELECT count(*)::int FROM cabinets WHERE district_id = ${aid} OR ward_id = ${aid}) AS cab,
             (SELECT count(*)::int FROM areas WHERE parent_id = ${aid}) AS child,
             (SELECT count(*)::int FROM user_scopes WHERE area_id = ${aid}) AS scopes`)[0]!;
    if (use.cab || use.child || use.scopes)
      throw new ApiError(409, 'in_use', `Còn ${use.cab} tủ, ${use.child} khu vực con, ${use.scopes} người dùng được phân quyền ở "${a.name}"`);
    await this.sql`DELETE FROM areas WHERE id = ${aid}`;
    await this.log(u, 'Xóa khu vực', 'area', aid, a.name, null, ip);
  }

  // ---------------- management units ----------------

  async createUnit(u: SessionUser, body: unknown, ip?: string) {
    const b = z.object({ name: Name }).parse(body);
    const r = (await this.sql<{ id: string }[]>`INSERT INTO management_units (organization_id, name) VALUES (${u.organizationId}, ${b.name}) RETURNING id`)[0]!;
    await this.log(u, 'Thêm khu quản lý', 'management_unit', r.id, b.name, null, ip);
    return { id: r.id, name: b.name };
  }
  async renameUnit(u: SessionUser, id: string, body: unknown, ip?: string) {
    const b = z.object({ name: Name }).parse(body);
    const r = await this.sql`UPDATE management_units SET name = ${b.name} WHERE id = ${uuid.parse(id)} AND organization_id = ${u.organizationId} RETURNING id`;
    if (!r.length) throw new ApiError(404, 'not_found', 'Không tìm thấy khu quản lý');
    await this.log(u, 'Đổi tên khu quản lý', 'management_unit', id, b.name, null, ip);
    return { id, name: b.name };
  }
  async deleteUnit(u: SessionUser, id: string, ip?: string) {
    const mid = uuid.parse(id);
    const n = (await this.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM cabinets WHERE management_unit_id = ${mid}`)[0]!.n;
    if (n) throw new ApiError(409, 'in_use', `Còn ${n} tủ thuộc khu quản lý này`);
    const r = await this.sql`DELETE FROM management_units WHERE id = ${mid} AND organization_id = ${u.organizationId} RETURNING name`;
    if (!r.length) throw new ApiError(404, 'not_found', 'Không tìm thấy khu quản lý');
    await this.log(u, 'Xóa khu quản lý', 'management_unit', mid, String(r[0]!.name), null, ip);
  }

  // ---------------- zones ----------------

  async createZone(u: SessionUser, body: unknown, ip?: string) {
    const b = z.object({ name: Name, center: Point }).parse(body);
    const r = (await this.sql<{ id: string }[]>`
      INSERT INTO zones (organization_id, name, center) VALUES (${u.organizationId}, ${b.name}, ST_SetSRID(ST_MakePoint(${b.center.lng}, ${b.center.lat}), 4326)) RETURNING id`)[0]!;
    await this.log(u, 'Thêm vùng', 'zone', r.id, b.name, `${b.center.lat}, ${b.center.lng}`, ip);
    return { id: r.id, name: b.name, center: b.center, cabinetCount: 0 };
  }
  async updateZone(u: SessionUser, id: string, body: unknown, ip?: string) {
    const b = z.object({ name: Name.optional(), center: Point.optional() }).parse(body);
    const r = await this.sql`
      UPDATE zones SET name = coalesce(${b.name ?? null}, name),
        center = CASE WHEN ${!!b.center} THEN ST_SetSRID(ST_MakePoint(${b.center?.lng ?? 0}, ${b.center?.lat ?? 0}), 4326) ELSE center END
      WHERE id = ${uuid.parse(id)} AND organization_id = ${u.organizationId} RETURNING name`;
    if (!r.length) throw new ApiError(404, 'not_found', 'Không tìm thấy vùng');
    await this.log(u, 'Sửa vùng', 'zone', id, String(r[0]!.name), JSON.stringify(b), ip);
    // the centre drives astronomical times
    if (b.center) await this.redis.publish(SCHEDULES_CHANNEL, JSON.stringify({ zoneId: id })).catch(() => undefined);
  }
  async deleteZone(u: SessionUser, id: string, ip?: string) {
    const zid = uuid.parse(id);
    const n = (await this.sql<{ c: number; s: number }[]>`
      SELECT (SELECT count(*)::int FROM cabinets WHERE zone1_id = ${zid} OR zone2_id = ${zid}) AS c, (SELECT count(*)::int FROM schedules WHERE zone_id = ${zid}) AS s`)[0]!;
    if (n.c) throw new ApiError(409, 'in_use', `Còn ${n.c} tủ trong vùng này, chuyển tủ sang vùng khác trước`);
    await this.sql.begin(async (tx) => {
      await tx`DELETE FROM schedules WHERE zone_id = ${zid}`;
      await tx`DELETE FROM thresholds WHERE zone_id = ${zid}`;
      const r = await tx`DELETE FROM zones WHERE id = ${zid} AND organization_id = ${u.organizationId} RETURNING name`;
      if (!r.length) throw new ApiError(404, 'not_found', 'Không tìm thấy vùng');
    });
    await this.log(u, 'Xóa vùng', 'zone', zid, zid, null, ip);
  }

  /** Put cabinets in a zone, by area (district / ward, with their wards) and/or by id. */
  async assignZone(u: SessionUser, id: string, body: unknown, ip?: string) {
    const b = z.object({ areaIds: z.array(uuid).max(200).default([]), cabinetIds: z.array(uuid).max(20_000).default([]) })
      .refine((x) => x.areaIds.length || x.cabinetIds.length, 'Chọn khu vực hoặc tủ').parse(body);
    const zid = uuid.parse(id);
    const z0 = (await this.sql<{ name: string }[]>`SELECT name FROM zones WHERE id = ${zid} AND organization_id = ${u.organizationId}`)[0];
    if (!z0) throw new ApiError(404, 'not_found', 'Không tìm thấy vùng');
    const r = await this.sql`
      UPDATE cabinets SET zone1_id = ${zid}, updated_at = now()
      WHERE organization_id = ${u.organizationId} AND active
        AND (district_id = ANY(${b.areaIds}::uuid[]) OR ward_id = ANY(${b.areaIds}::uuid[]) OR id = ANY(${b.cabinetIds}::uuid[]))
      RETURNING id`;
    await this.log(u, 'Gán tủ vào vùng', 'zone', zid, z0.name, `${r.length} tủ`, ip);
    await this.redis.publish(SCHEDULES_CHANNEL, JSON.stringify({ zoneId: zid })).catch(() => undefined);
    await this.reload('registry'); // thresholds follow the zone
    return { assigned: r.length };
  }

  // ---------------- cabinets ----------------

  private async checkPlaces(u: SessionUser, b: { districtId?: string | null; wardId?: string | null; zone1Id?: string | null; managementUnitId?: string | null }) {
    if (b.wardId) {
      const w = (await this.sql<{ parent_id: string }[]>`SELECT parent_id FROM areas WHERE id = ${b.wardId} AND kind = 'ward' AND organization_id = ${u.organizationId}`)[0];
      if (!w) throw new ApiError(422, 'invalid_request', 'Phường không tồn tại');
      if (b.districtId && w.parent_id !== b.districtId) throw new ApiError(422, 'invalid_request', 'Phường không thuộc quận đã chọn');
    }
    if (b.districtId && !(await this.sql`SELECT 1 FROM areas WHERE id = ${b.districtId} AND kind = 'district' AND organization_id = ${u.organizationId}`).length)
      throw new ApiError(422, 'invalid_request', 'Quận không tồn tại');
    if (b.zone1Id && !(await this.sql`SELECT 1 FROM zones WHERE id = ${b.zone1Id} AND organization_id = ${u.organizationId}`).length)
      throw new ApiError(422, 'invalid_request', 'Vùng không tồn tại');
    if (b.managementUnitId && !(await this.sql`SELECT 1 FROM management_units WHERE id = ${b.managementUnitId} AND organization_id = ${u.organizationId}`).length)
      throw new ApiError(422, 'invalid_request', 'Khu quản lý không tồn tại');
  }

  /** Register a cabinet (from an unknown device or by hand); the ingest worker picks it up at once. */
  async registerCabinet(u: SessionUser, body: unknown, ip?: string) {
    const b = CabinetBody.parse(body);
    // a ward implies its district
    const districtId = b.districtId ?? (b.wardId ? (await this.sql<{ p: string }[]>`SELECT parent_id AS p FROM areas WHERE id = ${b.wardId}`)[0]?.p ?? null : null);
    await this.checkPlaces(u, { ...b, districtId });
    const dup = (await this.sql<{ ltid: string; code: string }[]>`SELECT ltid, code FROM cabinets WHERE upper(ltid) = ${b.ltid} OR code = ${b.code}`)[0];
    if (dup) throw new ApiError(409, 'duplicate', dup.ltid.toUpperCase() === b.ltid ? `LTID ${b.ltid} đã được đăng ký` : `Mã tủ ${b.code} đã có`);
    const id = await this.sql.begin(async (tx) => {
      const r = (await tx<{ id: string }[]>`
        INSERT INTO cabinets (organization_id, ltid, code, name, address, street, ward_id, district_id, management_unit_id, zone1_id, location, fw_profile, notes, imei)
        VALUES (${u.organizationId}, ${b.ltid}, ${b.code}, ${b.name}, ${b.address ?? null}, ${b.street ?? null}, ${b.wardId ?? null}, ${districtId},
                ${b.managementUnitId ?? null}, ${b.zone1Id ?? null}, ST_SetSRID(ST_MakePoint(${b.location.lng}, ${b.location.lat}), 4326), ${b.fwProfile}, ${b.notes ?? null},
                (SELECT imei FROM unknown_devices WHERE upper(ltid) = ${b.ltid}))
        RETURNING id`)[0]!;
      await tx`INSERT INTO cabinet_state (cabinet_id, status, online) VALUES (${r.id}, 'offline', false) ON CONFLICT DO NOTHING`;
      await tx`DELETE FROM unknown_devices WHERE upper(ltid) = ${b.ltid}`;
      return r.id;
    });
    await this.log(u, 'Đăng ký tủ', 'cabinet', id, `${b.code} - ${b.name}`, `LTID ${b.ltid}`, ip);
    await this.reload('registry');
    return { id };
  }

  async updateCabinet(u: SessionUser, id: string, body: unknown, ip?: string) {
    const cid = uuid.parse(id);
    const b = CabinetPatch.parse(body);
    const cur = (await this.sql<{ ltid: string; code: string; district_id: string | null }[]>`SELECT ltid, code, district_id FROM cabinets WHERE id = ${cid} AND organization_id = ${u.organizationId}`)[0];
    if (!cur) throw new ApiError(404, 'not_found', 'Không tìm thấy tủ');
    await this.checkPlaces(u, { districtId: b.districtId === undefined ? cur.district_id : b.districtId, wardId: b.wardId, zone1Id: b.zone1Id, managementUnitId: b.managementUnitId });
    if (b.ltid && b.ltid !== cur.ltid.toUpperCase() && (await this.sql`SELECT 1 FROM cabinets WHERE upper(ltid) = ${b.ltid} AND id <> ${cid}`).length)
      throw new ApiError(409, 'duplicate', `LTID ${b.ltid} đã được đăng ký`);
    if (b.code && b.code !== cur.code && (await this.sql`SELECT 1 FROM cabinets WHERE code = ${b.code} AND id <> ${cid}`).length)
      throw new ApiError(409, 'duplicate', `Mã tủ ${b.code} đã có`);
    const set = (k: keyof typeof b) => b[k] !== undefined;
    await this.sql`
      UPDATE cabinets SET
        ltid = CASE WHEN ${set('ltid')} THEN ${b.ltid ?? null} ELSE ltid END,
        code = CASE WHEN ${set('code')} THEN ${b.code ?? null} ELSE code END,
        name = CASE WHEN ${set('name')} THEN ${b.name ?? null} ELSE name END,
        address = CASE WHEN ${set('address')} THEN ${b.address ?? null} ELSE address END,
        street = CASE WHEN ${set('street')} THEN ${b.street ?? null} ELSE street END,
        district_id = CASE WHEN ${set('districtId')} THEN ${b.districtId ?? null}::uuid ELSE district_id END,
        ward_id = CASE WHEN ${set('wardId')} THEN ${b.wardId ?? null}::uuid ELSE ward_id END,
        management_unit_id = CASE WHEN ${set('managementUnitId')} THEN ${b.managementUnitId ?? null}::uuid ELSE management_unit_id END,
        zone1_id = CASE WHEN ${set('zone1Id')} THEN ${b.zone1Id ?? null}::uuid ELSE zone1_id END,
        location = CASE WHEN ${set('location')} THEN ST_SetSRID(ST_MakePoint(${b.location?.lng ?? 0}, ${b.location?.lat ?? 0}), 4326) ELSE location END,
        fw_profile = CASE WHEN ${set('fwProfile')} THEN ${b.fwProfile ?? 'v2-current'}::fw_profile ELSE fw_profile END,
        notes = CASE WHEN ${set('notes')} THEN ${b.notes ?? null} ELSE notes END,
        updated_at = now()
      WHERE id = ${cid}`;
    await this.log(u, 'Sửa thông tin tủ', 'cabinet', cid, b.code ?? cur.code, JSON.stringify(b), ip);
    await this.reload('registry');
    if (set('zone1Id')) await this.redis.publish(SCHEDULES_CHANNEL, JSON.stringify({ cabinetId: cid })).catch(() => undefined);
    return { id: cid };
  }

  /** Decommission: hidden everywhere (scopeWhere), workers drop it, open alarms closed, history kept. */
  async setActive(u: SessionUser, id: string, active: boolean, ip?: string) {
    const cid = uuid.parse(id);
    const r = (await this.sql<{ code: string }[]>`
      UPDATE cabinets SET active = ${active}, decommissioned_at = CASE WHEN ${active} THEN NULL ELSE now() END, updated_at = now()
      WHERE id = ${cid} AND organization_id = ${u.organizationId} AND active <> ${active} RETURNING code`)[0];
    if (!r) throw new ApiError(409, 'no_change', active ? 'Tủ đang hoạt động' : 'Tủ đã ngừng sử dụng');
    if (!active) {
      await this.sql`UPDATE alarms SET active = false, ended_at = now() WHERE cabinet_id = ${cid} AND active`;
      await this.sql`UPDATE cabinet_state SET online = false, status = 'offline', updated_at = now() WHERE cabinet_id = ${cid}`;
      await this.sql`UPDATE commands SET status = 'cancelled', error = 'Tủ ngừng sử dụng' WHERE cabinet_id = ${cid} AND status = 'queued'`;
    }
    await this.log(u, active ? 'Dùng lại tủ' : 'Ngừng sử dụng tủ', 'cabinet', cid, r.code, null, ip);
    await this.reload('registry');
  }

  // ---------------- field map + settings ----------------

  /** Mapping in use (code) + keys cabinets send that nothing maps yet (cabinet_state.extra). */
  async fieldMap() {
    const unknown = await this.sql<{ key: string; cabinets: number; sample: string }[]>`
      SELECT k AS key, count(*)::int AS cabinets, min(v) AS sample
      FROM cabinet_state s, jsonb_each_text(coalesce(s.extra, '{}'::jsonb)) AS e(k, v)
      GROUP BY k ORDER BY count(*) DESC LIMIT 100`;
    return { entries: DEFAULT_FIELD_MAP, unknownKeys: unknown };
  }

  async settings() {
    const rows = await this.sql<{ key: string; value: unknown; updated_at: Date; updated_by: string | null }[]>`SELECT key, value, updated_at, updated_by FROM system_settings`;
    const v = Object.fromEntries(rows.map((r) => [r.key, r.value])) as Partial<typeof SETTING_DEFAULTS>;
    const last = rows.sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime())[0];
    return {
      offlineAfterS: Number(v.offline_after_s ?? SETTING_DEFAULTS.offline_after_s),
      lampGroupLabels: { ...SETTING_DEFAULTS.lamp_group_labels, ...(v.lamp_group_labels ?? {}) },
      updatedAt: last?.updated_at.toISOString() ?? null, updatedBy: last?.updated_by ?? null,
    };
  }

  async saveSettings(u: SessionUser, body: unknown, ip?: string) {
    const b = SettingsBody.parse(body);
    await this.sql.begin(async (tx) => {
      for (const [key, value] of [['offline_after_s', b.offlineAfterS], ['lamp_group_labels', b.lampGroupLabels]] as const) {
        await tx`INSERT INTO system_settings (key, value, updated_at, updated_by) VALUES (${key}, ${tx.json(value as never)}, now(), ${u.email})
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`;
      }
    });
    await this.log(u, 'Cấu hình hệ thống', 'settings', null, 'system', JSON.stringify(b), ip);
    await this.reload('settings');
    return this.settings();
  }
}

@Controller()
export class AdminController {
  constructor(@Inject(AdminService) private readonly svc: AdminService) {}

  @Post('areas') @RequirePerm('admin.catalog')
  createArea(@Req() r: AuthedRequest, @Body() b: unknown) { return this.svc.createArea(r.user!, b, r.ip); }
  @Patch('areas/:id') @RequirePerm('admin.catalog')
  renameArea(@Req() r: AuthedRequest, @Param('id') id: string, @Body() b: unknown) { return this.svc.renameArea(r.user!, id, b, r.ip); }
  @Delete('areas/:id') @HttpCode(204) @RequirePerm('admin.catalog')
  deleteArea(@Req() r: AuthedRequest, @Param('id') id: string) { return this.svc.deleteArea(r.user!, id, r.ip); }

  @Post('management-units') @RequirePerm('admin.catalog')
  createUnit(@Req() r: AuthedRequest, @Body() b: unknown) { return this.svc.createUnit(r.user!, b, r.ip); }
  @Patch('management-units/:id') @RequirePerm('admin.catalog')
  renameUnit(@Req() r: AuthedRequest, @Param('id') id: string, @Body() b: unknown) { return this.svc.renameUnit(r.user!, id, b, r.ip); }
  @Delete('management-units/:id') @HttpCode(204) @RequirePerm('admin.catalog')
  deleteUnit(@Req() r: AuthedRequest, @Param('id') id: string) { return this.svc.deleteUnit(r.user!, id, r.ip); }

  @Post('zones') @RequirePerm('admin.catalog')
  createZone(@Req() r: AuthedRequest, @Body() b: unknown) { return this.svc.createZone(r.user!, b, r.ip); }
  @Patch('zones/:id') @HttpCode(204) @RequirePerm('admin.catalog')
  updateZone(@Req() r: AuthedRequest, @Param('id') id: string, @Body() b: unknown) { return this.svc.updateZone(r.user!, id, b, r.ip); }
  @Delete('zones/:id') @HttpCode(204) @RequirePerm('admin.catalog')
  deleteZone(@Req() r: AuthedRequest, @Param('id') id: string) { return this.svc.deleteZone(r.user!, id, r.ip); }
  @Post('zones/:id/assign') @HttpCode(200) @RequirePerm('admin.catalog')
  assignZone(@Req() r: AuthedRequest, @Param('id') id: string, @Body() b: unknown) { return this.svc.assignZone(r.user!, id, b, r.ip); }

  @Post('cabinets') @RequirePerm('admin.devices')
  register(@Req() r: AuthedRequest, @Body() b: unknown) { return this.svc.registerCabinet(r.user!, b, r.ip); }
  @Patch('cabinets/:id') @RequirePerm('admin.devices')
  update(@Req() r: AuthedRequest, @Param('id') id: string, @Body() b: unknown) { return this.svc.updateCabinet(r.user!, id, b, r.ip); }
  @Post('cabinets/:id/decommission') @HttpCode(204) @RequirePerm('admin.devices')
  decommission(@Req() r: AuthedRequest, @Param('id') id: string) { return this.svc.setActive(r.user!, id, false, r.ip); }
  @Post('cabinets/:id/reactivate') @HttpCode(204) @RequirePerm('admin.devices')
  reactivate(@Req() r: AuthedRequest, @Param('id') id: string) { return this.svc.setActive(r.user!, id, true, r.ip); }

  @Get('field-map') @RequirePerm('admin.devices')
  fieldMap() { return this.svc.fieldMap(); }

  @Get('settings') @RequirePerm('system.view')
  settings() { return this.svc.settings(); }
  @Put('settings') @RequirePerm('admin.catalog')
  saveSettings(@Req() r: AuthedRequest, @Body() b: unknown) { return this.svc.saveSettings(r.user!, b, r.ip); }
}

@Module({ imports: [CabinetsModule], controllers: [AdminController], providers: [AdminService] })
export class AdminModule {}
