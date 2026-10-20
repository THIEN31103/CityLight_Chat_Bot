// Dimming profiles (spec S11, M9): one profile per lamp group at three levels — cabinet > zone >
// system — validated by shared/dimming.ts, with a savings estimate from the real GIS lamps (M8) and
// the electricity price setting. Profiles are stored only: sending them is refused until the
// firmware has the "dimming" capability (commands / batches answer 409 capability_unsupported).
import { Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Module, Param, Put, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import type { DimmingSegment, LampGroup } from '@citylight/shared';
import { LAMP_GROUP_LABELS, defaultDimmingSegments, estimateDimming, validateDimming } from '@citylight/shared';
import { RequirePerm, type AuthedRequest, type SessionUser } from './auth';
import { CabinetsModule, CabinetsService } from './cabinets';
import { ApiError } from './errors';
import { SQL, type Sql } from './infra';
import { scopeWhere } from './scope';

const Group = z.coerce.number().int().min(0).max(3).transform((g) => g as LampGroup);
const Segment = z.object({ enabled: z.boolean(), startMin: z.number().int(), endMin: z.number().int(), levelPct: z.number().int() });
const ProfileBody = z.object({ lampGroup: Group.optional(), segments: z.array(Segment).max(10) });
const DEFAULT_PRICE = 2000; // đ/kWh when the setting is missing

type Source = 'cabinet' | 'zone' | 'system' | 'default';

@Injectable()
export class DimmingService {
  constructor(@Inject(SQL) private readonly sql: Sql, @Inject(CabinetsService) private readonly cabinets: CabinetsService) {}

  private validate(segments: DimmingSegment[]) {
    const errors = validateDimming(segments);
    if (errors.length) throw new ApiError(422, 'invalid_profile', errors.join('; '), { errors: errors.join('; '), errorsEn: validateDimming(segments, 'en').join('; ') });
  }

  private async price(): Promise<number | null> {
    const r = (await this.sql<{ value: number }[]>`SELECT value FROM system_settings WHERE key = 'price_per_kwh'`)[0];
    const v = r ? Number(r.value) : DEFAULT_PRICE;
    return v > 0 ? v : null;
  }

  private async row(group: LampGroup, level: { cabinetId?: string; zoneId?: string | null }) {
    const rows = level.cabinetId
      ? await this.sql<{ segments: DimmingSegment[] }[]>`SELECT segments FROM dimming_profiles WHERE cabinet_id = ${level.cabinetId} AND lamp_group = ${group}`
      : level.zoneId
        ? await this.sql<{ segments: DimmingSegment[] }[]>`SELECT segments FROM dimming_profiles WHERE zone_id = ${level.zoneId} AND cabinet_id IS NULL AND lamp_group = ${group}`
        : await this.sql<{ segments: DimmingSegment[] }[]>`SELECT segments FROM dimming_profiles WHERE zone_id IS NULL AND cabinet_id IS NULL AND lamp_group = ${group}`;
    return rows[0]?.segments ?? null;
  }

  /** First profile found walking cabinet -> zone -> system -> built-in default. */
  private async resolve(group: LampGroup, cabinetId: string | null, zoneId: string | null): Promise<{ segments: DimmingSegment[]; source: Source }> {
    if (cabinetId) {
      const s = await this.row(group, { cabinetId });
      if (s) return { segments: s, source: 'cabinet' };
    }
    if (zoneId) {
      const s = await this.row(group, { zoneId });
      if (s) return { segments: s, source: 'zone' };
    }
    const s = await this.row(group, {});
    return s ? { segments: s, source: 'system' } : { segments: defaultDimmingSegments(), source: 'default' };
  }

  /** Lamps of this group in the user's scope, for a cabinet, a zone or everything. */
  private async estimate(u: SessionUser, group: LampGroup, segments: DimmingSegment[], filter: { cabinetId?: string; zoneId?: string | null }) {
    const r = (await this.sql<{ lamps: number; w: number; no_power: number }[]>`
      SELECT count(*)::int AS lamps, coalesce(sum(l.rated_power_w), 0)::int AS w, count(*) FILTER (WHERE l.rated_power_w IS NULL)::int AS no_power
      FROM lamps l JOIN poles p ON p.id = l.pole_id JOIN routes r ON r.id = p.route_id JOIN cabinets c ON c.id = r.cabinet_id
      WHERE l.lamp_group = ${group} AND ${scopeWhere(this.sql, u.scope)}
        ${filter.cabinetId ? this.sql`AND c.id = ${filter.cabinetId}` : filter.zoneId ? this.sql`AND c.zone1_id = ${filter.zoneId}` : this.sql``}`)[0]!;
    const price = await this.price();
    // ratedW + price let the web editor recompute while the user drags, with the same shared function
    return { ...estimateDimming(segments, r.lamps, r.w, price), ratedW: r.w, pricePerKwh: price, lampsWithoutPower: r.no_power };
  }

  private log(u: SessionUser, action: string, type: string, id: string | null, name: string, value: string, ip?: string) {
    return this.sql`INSERT INTO activity_logs (user_id, user_email, action, target_type, target_id, target_name, new_value, ip)
                    VALUES (${u.id}, ${u.email}, ${action}, ${type}, ${id}, ${name}, ${value}, ${ip ?? null})`;
  }

  private async zone(id: string) {
    const z0 = (await this.sql<{ name: string }[]>`SELECT name FROM zones WHERE id = ${z.string().uuid().parse(id)}`)[0];
    if (!z0) throw new ApiError(404, 'not_found', 'Không tìm thấy vùng');
    return z0;
  }

  // ---------------- system / zone level ----------------

  async getGroup(u: SessionUser, group: LampGroup, zoneId: string | null) {
    if (zoneId) await this.zone(zoneId);
    const r = await this.resolve(group, null, zoneId);
    return {
      lampGroup: group, segments: r.segments, source: r.source, inheritedFromZone: zoneId ? r.source !== 'zone' : r.source === 'default',
      estimate: await this.estimate(u, group, r.segments, { zoneId }),
    };
  }

  /** System / zone profiles cover many areas: only users who see the whole system change them. */
  async putGroup(u: SessionUser, group: LampGroup, zoneId: string | null, body: unknown, ip?: string) {
    if (!u.scope.all) throw new ApiError(403, 'forbidden_scope', 'Hồ sơ hệ thống / vùng áp cho nhiều khu vực: cần quyền toàn hệ thống');
    const b = ProfileBody.parse(body);
    this.validate(b.segments);
    const name = zoneId ? `Vùng ${(await this.zone(zoneId)).name}` : 'Toàn hệ thống';
    if (zoneId) {
      await this.sql`
        INSERT INTO dimming_profiles (lamp_group, zone_id, segments) VALUES (${group}, ${zoneId}, ${this.sql.json(b.segments as never)})
        ON CONFLICT (zone_id, lamp_group) WHERE cabinet_id IS NULL AND zone_id IS NOT NULL DO UPDATE SET segments = excluded.segments, updated_at = now()`;
    } else {
      await this.sql`
        INSERT INTO dimming_profiles (lamp_group, segments) VALUES (${group}, ${this.sql.json(b.segments as never)})
        ON CONFLICT (lamp_group) WHERE cabinet_id IS NULL AND zone_id IS NULL DO UPDATE SET segments = excluded.segments, updated_at = now()`;
    }
    await this.log(u, 'Lưu hồ sơ tiết giảm', zoneId ? 'zone' : 'system', zoneId, `${name} · ${LAMP_GROUP_LABELS[group]}`, JSON.stringify(b.segments), ip);
    return this.getGroup(u, group, zoneId);
  }

  async dropZone(u: SessionUser, group: LampGroup, zoneId: string, ip?: string) {
    if (!u.scope.all) throw new ApiError(403, 'forbidden_scope', 'Cần quyền toàn hệ thống');
    const z0 = await this.zone(zoneId);
    const r = await this.sql`DELETE FROM dimming_profiles WHERE zone_id = ${zoneId} AND cabinet_id IS NULL AND lamp_group = ${group} RETURNING id`;
    if (!r.length) throw new ApiError(404, 'no_zone_profile', 'Vùng không có hồ sơ riêng cho nhóm đèn này');
    await this.log(u, 'Bỏ hồ sơ tiết giảm riêng', 'zone', zoneId, `Vùng ${z0.name} · ${LAMP_GROUP_LABELS[group]}`, 'Theo hệ thống', ip);
  }

  // ---------------- cabinet level ----------------

  private async cab(u: SessionUser, id: string) {
    const cid = await this.cabinets.assertCabinet(u.scope, id);
    const c = (await this.sql<{ code: string; zone1_id: string | null }[]>`SELECT code, zone1_id FROM cabinets WHERE id = ${cid}`)[0]!;
    return { id: cid, ...c };
  }

  async getCabinet(u: SessionUser, id: string, group: LampGroup) {
    const c = await this.cab(u, id);
    const r = await this.resolve(group, c.id, c.zone1_id);
    return { lampGroup: group, segments: r.segments, source: r.source, inheritedFromZone: r.source !== 'cabinet', estimate: await this.estimate(u, group, r.segments, { cabinetId: c.id }) };
  }

  async putCabinet(u: SessionUser, id: string, body: unknown, ip?: string) {
    const c = await this.cab(u, id);
    const b = ProfileBody.parse(body);
    const group = b.lampGroup ?? 0;
    this.validate(b.segments);
    await this.sql`
      INSERT INTO dimming_profiles (lamp_group, cabinet_id, segments) VALUES (${group}, ${c.id}, ${this.sql.json(b.segments as never)})
      ON CONFLICT (cabinet_id, lamp_group) WHERE cabinet_id IS NOT NULL DO UPDATE SET segments = excluded.segments, updated_at = now()`;
    await this.log(u, 'Lưu hồ sơ tiết giảm', 'cabinet', c.id, `${c.code} · ${LAMP_GROUP_LABELS[group]}`, JSON.stringify(b.segments), ip);
    return this.getCabinet(u, c.id, group);
  }

  async dropCabinet(u: SessionUser, id: string, group: LampGroup, ip?: string) {
    const c = await this.cab(u, id);
    const r = await this.sql`DELETE FROM dimming_profiles WHERE cabinet_id = ${c.id} AND lamp_group = ${group} RETURNING id`;
    if (!r.length) throw new ApiError(404, 'no_cabinet_profile', 'Tủ không có hồ sơ riêng cho nhóm đèn này');
    await this.log(u, 'Bỏ hồ sơ tiết giảm riêng', 'cabinet', c.id, `${c.code} · ${LAMP_GROUP_LABELS[group]}`, 'Theo vùng / hệ thống', ip);
  }
}

@Controller()
export class DimmingController {
  constructor(@Inject(DimmingService) private readonly svc: DimmingService) {}

  @Get('dimming-profiles/:group') @RequirePerm('map.view')
  group(@Req() r: AuthedRequest, @Param('group') g: string, @Query('zoneId') zoneId?: string) {
    return this.svc.getGroup(r.user!, Group.parse(g), zoneId || null);
  }
  @Put('dimming-profiles/:group') @RequirePerm('dimming.manage')
  putGroup(@Req() r: AuthedRequest, @Param('group') g: string, @Body() b: unknown, @Query('zoneId') zoneId?: string) {
    return this.svc.putGroup(r.user!, Group.parse(g), zoneId || null, b, r.ip);
  }
  @Delete('dimming-profiles/:group') @HttpCode(204) @RequirePerm('dimming.manage')
  dropZone(@Req() r: AuthedRequest, @Param('group') g: string, @Query('zoneId') zoneId: string) {
    return this.svc.dropZone(r.user!, Group.parse(g), z.string().uuid().parse(zoneId), r.ip);
  }

  @Get('cabinets/:id/dimming') @RequirePerm('map.view')
  cabinet(@Req() r: AuthedRequest, @Param('id') id: string, @Query('group') g = '0') {
    return this.svc.getCabinet(r.user!, id, Group.parse(g));
  }
  @Put('cabinets/:id/dimming') @RequirePerm('dimming.manage')
  putCabinet(@Req() r: AuthedRequest, @Param('id') id: string, @Body() b: unknown) {
    return this.svc.putCabinet(r.user!, id, b, r.ip);
  }
  @Delete('cabinets/:id/dimming') @HttpCode(204) @RequirePerm('dimming.manage')
  dropCabinet(@Req() r: AuthedRequest, @Param('id') id: string, @Query('group') g = '0') {
    return this.svc.dropCabinet(r.user!, id, Group.parse(g), r.ip);
  }
}

@Module({ imports: [CabinetsModule], controllers: [DimmingController], providers: [DimmingService] })
export class DimmingModule {}
