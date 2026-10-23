// M6: zone schedules (+ astronomical preview), dropping a cabinet's own schedule, and command batches.
// The scheduler worker keeps every cabinet on its desired schedule (decision M6-A); a batch is the
// operator's "send it now, show me the progress" on top of the same command queue (M4).
import { Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Module, Param, Post, Put, Query, Req } from '@nestjs/common';
import { Redis } from 'ioredis';
import { z } from 'zod';
import type { CommandBatch, CommandType, FwProfile, Schedule } from '@citylight/shared';
import { BATCH_CONTROL_TYPES, COMMAND_CAPABILITY, astroPreview, capabilitiesFor, defaultSchedule, describeCommand, firmwareBlocksCommands, hasPermission, vnDate } from '@citylight/shared';
import { buildCommandFrames } from '@citylight/coreif';
import { SCHEDULES_CHANNEL, batchById, selectBatches } from '@citylight/db/batches';
import { COMMANDS_NOTIFY } from '@citylight/db/commands';
import { loadDesired, scheduleFromRow, type ScheduleRow } from '@citylight/db/schedules';
import { AuthModule, AuthService, RequirePerm, type AuthedRequest, type SessionUser } from './auth';
import { CabinetsModule, CabinetsService } from './cabinets';
import { PARAMS, ScheduleBody } from './commands';
import { ApiError } from './errors';
import { REDIS, SQL, type Sql } from './infra';
import { parseCodes, pickWhere, scopeWhere } from './scope';

const uuid = z.string().uuid();
export const DIMMING_UNSUPPORTED = 'Tủ hiện tại chưa hỗ trợ tiết giảm (cần firmware có lệnh tiết giảm và bộ điều khiển đèn thông minh); hồ sơ chỉ được lưu.';
/**
 * Control batches (S56) only: at 3 frames/s on the shared topic 2,000 cabinets take ~11 min, well inside the 30-min
 * bulk queue TTL. Schedule / time batches stay unlimited (the scheduler resends schedules anyway).
 */
export const MAX_CONTROL_CABINETS = 2_000;
/** Cabinets: zones (zone 1 or 2) and / or codes ("TM01.0001", "TM01.*"), at least one of the two. */
const Target = z.object({ zoneIds: z.array(uuid).max(50).default([]), codes: z.string().max(20_000).optional() });
const ControlCommand = z.object({ type: z.enum(BATCH_CONTROL_TYPES), params: z.record(z.unknown()).default({}) });
const BatchBody = Target.extend({ kind: z.enum(['schedule', 'time', 'dimming', 'control']), command: ControlCommand.optional(), otp: z.string().optional() });
const PreviewBody = Target.extend({ kind: z.enum(['schedule', 'time', 'dimming', 'control']).default('time'), command: ControlCommand.optional() });

type Cab = { id: string; ltid: string; fw_profile: FwProfile; online: boolean | null };
type BatchCommand = NonNullable<CommandBatch['command']>;
const KIND_TYPE: Record<'schedule' | 'time', CommandType> = { schedule: 'SET_SCHEDULE', time: 'SET_TIME' };

/** Why a cabinet gets no command of this type (null = it can take it). */
function skipReason(c: Cab, type: CommandType): string | null {
  if (firmwareBlocksCommands(c.fw_profile)) return 'Firmware cũ 1307ebc: chặn điều khiển';
  const need = COMMAND_CAPABILITY[type];
  if (need && !capabilitiesFor(c.fw_profile).includes(need)) return 'Thiết bị chưa hỗ trợ chức năng này';
  return null;
}

@Injectable()
export class SchedulesService {
  constructor(
    @Inject(SQL) private readonly sql: Sql,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(CabinetsService) private readonly cabinets: CabinetsService,
  ) {}

  private async log(u: SessionUser, action: string, type: string, id: string | null, name: string, value: string, ip?: string) {
    await this.sql`INSERT INTO activity_logs (user_id, user_email, action, target_type, target_id, target_name, new_value, ip)
                   VALUES (${u.id}, ${u.email}, ${action}, ${type}, ${id}, ${name}, ${value}, ${ip ?? null})`;
  }

  private reconcile(payload: object) {
    return this.redis.publish(SCHEDULES_CHANNEL, JSON.stringify(payload)).catch(() => undefined);
  }

  private async zone(id: string) {
    const z = (await this.sql<{ id: string; name: string; lat: number; lng: number }[]>`
      SELECT id, name, ST_Y(center) AS lat, ST_X(center) AS lng FROM zones WHERE id = ${uuid.parse(id)}`)[0];
    if (!z) throw new ApiError(404, 'not_found', 'Không tìm thấy vùng');
    return z;
  }

  async zoneSchedule(id: string): Promise<Schedule> {
    const z = await this.zone(id);
    const r = (await this.sql<ScheduleRow[]>`SELECT * FROM schedules WHERE zone_id = ${z.id}`)[0];
    return r ? scheduleFromRow(r) : { ...defaultSchedule(), inheritedFromZone: false };
  }

  /** A zone schedule covers cabinets of many areas: only users who see the whole system may change it. */
  async setZoneSchedule(u: SessionUser, id: string, body: unknown, ip?: string): Promise<Schedule> {
    if (!u.scope.all) throw new ApiError(403, 'forbidden_scope', 'Lịch vùng áp cho nhiều khu vực: cần quyền toàn hệ thống');
    const z = await this.zone(id);
    const s = ScheduleBody.parse(body);
    await this.sql`
      INSERT INTO schedules (zone_id, mode, source, on1, off1, on2, off2, branch1_enabled, branch2_enabled, offset_on_min, offset_off_min, updated_at)
      VALUES (${z.id}, ${s.mode}, ${s.source}, ${s.on1}, ${s.off1}, ${s.on2}, ${s.off2}, ${s.branch1Enabled}, ${s.branch2Enabled}, ${s.offsetOnMin}, ${s.offsetOffMin}, now())
      ON CONFLICT (zone_id) DO UPDATE SET mode = excluded.mode, source = excluded.source, on1 = excluded.on1, off1 = excluded.off1,
        on2 = excluded.on2, off2 = excluded.off2, branch1_enabled = excluded.branch1_enabled, branch2_enabled = excluded.branch2_enabled,
        offset_on_min = excluded.offset_on_min, offset_off_min = excluded.offset_off_min, updated_at = now()`;
    const text = s.source === 'astronomical' ? `Lịch thiên văn (lặn ${s.offsetOnMin >= 0 ? '+' : ''}${s.offsetOnMin}′, mọc ${s.offsetOffMin >= 0 ? '+' : ''}${s.offsetOffMin}′)` : `Chế độ ${s.mode}: ${s.on1} → ${s.off1}`;
    await this.log(u, 'Lưu lịch vùng', 'zone', z.id, z.name, text, ip);
    await this.reconcile({ zoneId: z.id });
    return this.zoneSchedule(z.id);
  }

  async preview(id: string, days: number, onMin?: number, offMin?: number) {
    const z = await this.zone(id);
    const s = await this.zoneSchedule(id);
    return astroPreview({ lat: Number(z.lat), lng: Number(z.lng) }, vnDate(), days, onMin ?? s.offsetOnMin, offMin ?? s.offsetOffMin);
  }

  async dropCabinetSchedule(u: SessionUser, id: string, ip?: string) {
    const cid = await this.cabinets.assertCabinet(u.scope, id);
    const done = await this.sql`DELETE FROM schedules WHERE cabinet_id = ${cid} RETURNING id`;
    if (!done.length) throw new ApiError(404, 'no_cabinet_schedule', 'Tủ không có lịch riêng');
    const c = (await this.sql<{ code: string; name: string }[]>`SELECT code, name FROM cabinets WHERE id = ${cid}`)[0]!;
    await this.log(u, 'Bỏ lịch riêng của tủ', 'cabinet', cid, `${c.code} - ${c.name}`, 'Dùng lịch vùng', ip);
    await this.reconcile({ cabinetId: cid });
  }

  // ---------------- batches ----------------

  /** Cabinets of a batch: zones and / or codes inside the user's areas (S56). */
  private async cabinetsOf(u: SessionUser, t: { zoneIds: string[]; codes: string[] }) {
    if (!t.zoneIds.length && !t.codes.length) return [];
    return this.sql<Cab[]>`
      SELECT c.id, c.ltid, c.fw_profile, s.online FROM cabinets c LEFT JOIN cabinet_state s ON s.cabinet_id = c.id
      WHERE ${scopeWhere(this.sql, u.scope)} AND ${pickWhere(this.sql, t.zoneIds, t.codes)} ORDER BY c.code`;
  }

  private target(b: z.infer<typeof Target>) {
    return { zoneIds: b.zoneIds, codes: parseCodes(b.codes, MAX_CONTROL_CABINETS) };
  }

  /** Control command of a batch, params checked like a single command; needs cabinet.control on top of batch.run. */
  private control(u: SessionUser, c: z.infer<typeof ControlCommand> | undefined): BatchCommand {
    if (!hasPermission(u.role, 'cabinet.control')) throw new ApiError(403, 'forbidden', 'Không đủ quyền');
    if (!c) throw new ApiError(422, 'invalid_params', 'Chưa chọn lệnh điều khiển', { reason: 'command' });
    return { type: c.type, params: PARAMS[c.type]!.parse(c.params) };
  }

  async previewBatch(u: SessionUser, body: unknown) {
    const b = PreviewBody.parse(body);
    const type = b.kind === 'control' ? (b.command?.type ?? 'MANUAL_ALL') : b.kind === 'schedule' ? 'SET_SCHEDULE' : 'SET_TIME';
    const cabs = await this.cabinetsOf(u, this.target(b));
    const blocked = cabs.filter((c) => firmwareBlocksCommands(c.fw_profile)).length;
    return {
      total: cabs.length,
      offline: cabs.filter((c) => !c.online).length,
      blocked,
      /** not 1307ebc but missing the capability (e.g. manual control) */
      unsupported: cabs.filter((c) => skipReason(c, type)).length - blocked,
      max: b.kind === 'control' ? MAX_CONTROL_CABINETS : null,
    };
  }

  /**
   * Online cabinets get a command each; offline ones are recorded (schedules: the scheduler sends later; control:
   * never sent later on its own, a late on / off would surprise people), unsupported ones fail.
   */
  private async enqueueItems(u: SessionUser, batchId: string, kind: 'schedule' | 'time' | 'control', cabs: Cab[], command: BatchCommand | null) {
    const desired = kind === 'schedule' ? new Map((await loadDesired(this.sql, cabs.map((c) => c.id))).map((d) => [d.cabinetId, d.window])) : null;
    const cmd = { ids: [] as string[], params: [] as string[], frames: [] as string[] };
    const items: { cabinet_id: string; result: 'pending' | 'failed' | 'offline'; error: string | null; command_id: string | null }[] = [];
    const type = kind === 'control' ? command!.type : KIND_TYPE[kind];
    for (const c of cabs) {
      const skip = skipReason(c, type);
      if (skip) items.push({ cabinet_id: c.id, result: 'failed', error: skip, command_id: null });
      else if (!c.online) items.push({ cabinet_id: c.id, result: 'offline', error: 'Tủ mất kết nối lúc gửi', command_id: null });
      else {
        const params = kind === 'schedule' ? (desired!.get(c.id) as unknown as Record<string, unknown>) : kind === 'control' ? command!.params : {};
        cmd.ids.push(c.id);
        cmd.params.push(JSON.stringify(params));
        cmd.frames.push(buildCommandFrames(c.ltid, type, params).join('\n'));
      }
    }
    const created = cmd.ids.length
      ? await this.sql<{ id: string; cabinet_id: string }[]>`
          INSERT INTO commands (cabinet_id, type, params, frame, batch_id, requested_by)
          SELECT x.cabinet_id, ${type}, x.params::jsonb, x.frame, ${batchId}, ${u.id}
          FROM unnest(${cmd.ids}::uuid[], ${cmd.params}::text[], ${cmd.frames}::text[]) AS x(cabinet_id, params, frame)
          RETURNING id, cabinet_id`
      : [];
    for (const r of created) items.push({ cabinet_id: r.cabinet_id, result: 'pending', error: null, command_id: r.id });
    for (let i = 0; i < items.length; i += 2000) {
      const chunk = items.slice(i, i + 2000).map((it) => ({ batch_id: batchId, ...it }));
      await this.sql`
        INSERT INTO command_batch_items ${this.sql(chunk)}
        ON CONFLICT (batch_id, cabinet_id) DO UPDATE SET result = excluded.result, error = excluded.error, command_id = excluded.command_id`;
    }
    if (created.length) await this.sql`SELECT pg_notify(${COMMANDS_NOTIFY}, ${batchId})`;
    else await this.sql`UPDATE command_batches SET finished_at = now() WHERE id = ${batchId}`;
    return created.length;
  }

  async createBatch(u: SessionUser, body: unknown, ip?: string): Promise<CommandBatch> {
    const b = BatchBody.parse(body);
    // checks before the OTP: nothing could be sent anyway, so do not burn a code on them
    if (b.kind === 'dimming') throw new ApiError(409, 'capability_unsupported', DIMMING_UNSUPPORTED);
    const command = b.kind === 'control' ? this.control(u, b.command) : null;
    const t = this.target(b);
    const zones = await this.sql<{ name: string }[]>`SELECT name FROM zones WHERE id = ANY(${t.zoneIds}::uuid[]) ORDER BY name`;
    if (zones.length !== t.zoneIds.length) throw new ApiError(404, 'not_found', 'Không tìm thấy vùng');
    const cabs = await this.cabinetsOf(u, t);
    if (!cabs.length) throw new ApiError(422, 'empty_batch', 'Không có tủ nào trong phạm vi của bạn ở các vùng / mã đã chọn');
    if (command && cabs.length > MAX_CONTROL_CABINETS)
      throw new ApiError(422, 'too_many_cabinets', `Quá ${MAX_CONTROL_CABINETS} tủ: chọn ít vùng / mã hơn`, { max: MAX_CONTROL_CABINETS });
    await this.auth.reauthTotp(u.id, b.otp);
    const shown = t.codes.map((c) => c.toUpperCase());
    const codes = shown.length > 10 ? [...shown.slice(0, 10), `… (+${shown.length - 10} mã)`] : shown;
    const scope = [...zones.map((z) => z.name), ...codes].join(', ');
    const id = (await this.sql<{ id: string }[]>`
      INSERT INTO command_batches (kind, command_type, params, scope, total, requested_by)
      VALUES (${b.kind}, ${command?.type ?? null}, ${command ? this.sql.json(command.params as never) : null}, ${scope}, ${cabs.length}, ${u.id})
      RETURNING id`)[0]!.id;
    const sent = await this.enqueueItems(u, id, b.kind, cabs, command);
    const action = { schedule: 'Đồng bộ lịch hàng loạt', time: 'Đồng bộ giờ hàng loạt', control: 'Điều khiển hàng loạt' }[b.kind];
    await this.log(u, action, 'batch', id, scope, `${command ? `${describeCommand(command.type, command.params)} · ` : ''}${cabs.length} tủ, gửi ${sent}`, ip);
    return (await batchById(this.sql, id))!;
  }

  private async ownBatch(u: SessionUser, id: string) {
    const b = await batchById(this.sql, uuid.parse(id));
    if (!b) throw new ApiError(404, 'not_found', 'Không tìm thấy lệnh hàng loạt');
    if (!u.scope.all && b.requestedById !== u.id) throw new ApiError(403, 'forbidden_scope', 'Lệnh hàng loạt của người khác');
    return b;
  }

  async retry(u: SessionUser, id: string, body: unknown, ip?: string) {
    const b = await this.ownBatch(u, id);
    if (b.kind === 'dimming') throw new ApiError(409, 'capability_unsupported', DIMMING_UNSUPPORTED);
    if (b.kind === 'control' && !hasPermission(u.role, 'cabinet.control')) throw new ApiError(403, 'forbidden', 'Không đủ quyền');
    await this.auth.reauthTotp(u.id, (body as { otp?: string })?.otp);
    const cabs = await this.sql<Cab[]>`
      SELECT c.id, c.ltid, c.fw_profile, s.online FROM command_batch_items i JOIN cabinets c ON c.id = i.cabinet_id
      LEFT JOIN cabinet_state s ON s.cabinet_id = c.id WHERE i.batch_id = ${b.id} AND i.result IN ('failed', 'offline') AND c.active`;
    if (!cabs.length) throw new ApiError(409, 'nothing_to_retry', 'Không còn tủ lỗi hoặc offline để gửi lại');
    await this.sql`UPDATE command_batches SET finished_at = NULL WHERE id = ${b.id}`;
    // a control batch resends the command it was created with
    const sent = await this.enqueueItems(u, b.id, b.kind, cabs, b.command);
    await this.log(u, 'Gửi lại tủ lỗi (hàng loạt)', 'batch', b.id, b.scope, `${b.command ? `${describeCommand(b.command.type, b.command.params)} · ` : ''}${cabs.length} tủ, gửi ${sent}`, ip);
    return (await batchById(this.sql, b.id))!;
  }

  list(u: SessionUser) {
    return selectBatches(this.sql, u.scope.all
      ? this.sql`GROUP BY b.id, u.email ORDER BY b.created_at DESC LIMIT 100`
      : this.sql`WHERE b.requested_by = ${u.id} GROUP BY b.id, u.email ORDER BY b.created_at DESC LIMIT 100`);
  }

  async detail(u: SessionUser, id: string) {
    const batch = await this.ownBatch(u, id);
    const items = await this.sql<{ cabinetId: string; cabinetName: string; result: string; error: string | null }[]>`
      SELECT i.cabinet_id AS "cabinetId", c.code || ' - ' || c.name AS "cabinetName", i.result, i.error
      FROM command_batch_items i JOIN cabinets c ON c.id = i.cabinet_id WHERE i.batch_id = ${batch.id}
      ORDER BY CASE i.result WHEN 'failed' THEN 0 WHEN 'offline' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END, c.code`;
    const { requestedById: _, ...b } = batch;
    return { batch: b, items };
  }
}

@Controller()
export class SchedulesController {
  constructor(@Inject(SchedulesService) private readonly svc: SchedulesService) {}

  @Get('zones/:id/schedule')
  @RequirePerm('map.view')
  zone(@Param('id') id: string) {
    return this.svc.zoneSchedule(id);
  }

  @Put('zones/:id/schedule')
  @RequirePerm('schedule.manage')
  setZone(@Req() r: AuthedRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.svc.setZoneSchedule(r.user!, id, body, r.ip);
  }

  @Get('zones/:id/schedule/preview')
  @RequirePerm('map.view')
  preview(@Param('id') id: string, @Query('days') days = '30', @Query('offsetOnMin') on?: string, @Query('offsetOffMin') off?: string) {
    const n = (v?: string) => (v === undefined || v === '' ? undefined : z.coerce.number().int().min(-120).max(120).parse(v));
    return this.svc.preview(id, Math.min(90, Math.max(1, Number(days) || 30)), n(on), n(off));
  }

  @Delete('cabinets/:id/schedule')
  @HttpCode(204)
  @RequirePerm('schedule.manage')
  async drop(@Req() r: AuthedRequest, @Param('id') id: string) {
    await this.svc.dropCabinetSchedule(r.user!, id, r.ip);
  }

  @Post('command-batches/preview')
  @HttpCode(200)
  @RequirePerm('batch.run')
  previewBatch(@Req() r: AuthedRequest, @Body() body: unknown) {
    return this.svc.previewBatch(r.user!, body);
  }

  @Post('command-batches')
  @HttpCode(202)
  @RequirePerm('batch.run')
  create(@Req() r: AuthedRequest, @Body() body: unknown) {
    return this.svc.createBatch(r.user!, body, r.ip);
  }

  @Get('command-batches')
  @RequirePerm('log.view')
  list(@Req() r: AuthedRequest) {
    return this.svc.list(r.user!).then((l) => l.map(({ requestedById: _, ...b }) => b));
  }

  @Get('command-batches/:id')
  @RequirePerm('log.view')
  detail(@Req() r: AuthedRequest, @Param('id') id: string) {
    return this.svc.detail(r.user!, id);
  }

  @Post('command-batches/:id/retry-failed')
  @HttpCode(202)
  @RequirePerm('batch.run')
  retry(@Req() r: AuthedRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.svc.retry(r.user!, id, body, r.ip);
  }
}

@Module({ imports: [AuthModule, CabinetsModule], controllers: [SchedulesController], providers: [SchedulesService] })
export class SchedulesModule {}
