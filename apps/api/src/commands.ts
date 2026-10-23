// Commands (spec 12, M4): enqueue only. The command-worker (apps/workers/src/command-worker.ts) sends,
// matches acks, retries and confirms through telemetry. API-side rules (owner decision M4-D):
//  - refused at once, never queued: cabinet offline, old firmware 1307ebc (no LTID filter), capability missing
//  - cabinet.control / schedule.manage permission + area scope (2FA is enforced by the auth guard)
//  - Idempotency-Key, per-user rate limit, at most MAX_QUEUED_PER_CABINET waiting per cabinet
//  - every request and every outcome goes to activity_logs
import { Body, Controller, Get, Headers, HttpCode, Inject, Injectable, Module, Param, Post, Put, Query, Req } from '@nestjs/common';
import { Redis } from 'ioredis';
import { z } from 'zod';
import type { Command, CommandType, FwProfile, Page } from '@citylight/shared';
import { COMMAND_CAPABILITY, capabilitiesFor, describeCommand, desiredSchedule, firmwareBlocksCommands, type Schedule } from '@citylight/shared';
import { FrameError, buildCommandFrames } from '@citylight/coreif';
import { SCHEDULES_CHANNEL } from '@citylight/db/batches';
import { COMMANDS_NOTIFY, EVENTS_CHANNEL, commandById, selectCommands } from '@citylight/db/commands';
import { RequirePerm, type AuthedRequest, type SessionUser } from './auth';
import { CabinetsModule, CabinetsService } from './cabinets';
import { ApiError } from './errors';
import { REDIS, SQL, type Sql } from './infra';
import { scopeWhere } from './scope';

const CMD_PER_MIN = Number(process.env.COMMANDS_PER_MIN ?? 30);
const MAX_QUEUED_PER_CABINET = 5;

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'giờ dạng HH:MM');
export const ScheduleBody = z.object({
  mode: z.union([z.literal(1), z.literal(2)]),
  source: z.enum(['manual', 'astronomical']).default('manual'),
  on1: HHMM,
  off1: HHMM,
  on2: HHMM.default('18:15'),
  off2: HHMM.default('23:00'),
  branch1Enabled: z.boolean().default(true),
  branch2Enabled: z.boolean().default(true),
  offsetOnMin: z.number().int().min(-120).max(120).default(10),
  offsetOffMin: z.number().int().min(-120).max(120).default(-10),
});

/** Params kept per type (anything else in the body is dropped, never stored); also used by control batches. */
export const PARAMS: Partial<Record<CommandType, z.ZodType<Record<string, unknown>>>> = {
  MANUAL_ALL: z.object({ on: z.boolean() }),
  MANUAL_BRANCH: z.object({ branch: z.union([z.literal(1), z.literal(2)]), on: z.boolean() }),
  AUTO: z.object({}),
  SET_TIME: z.object({}),
  SET_SCHEDULE: ScheduleBody,
  PULSE_ON: z.object({}),
  DIAG: z.object({}),
};

const SendBody = z.object({
  type: z.enum(['MANUAL_ALL', 'MANUAL_BRANCH', 'AUTO', 'SET_SCHEDULE', 'SET_TIME', 'PULSE_ON', 'DIAG', 'SET_DIMMING', 'LAMP_CONTROL']),
  params: z.record(z.unknown()).default({}),
  // web sends it; ignored on purpose: offline cabinets are refused, not queued (M4-D)
  queueIfOffline: z.boolean().optional(),
});

const IdemKey = z.string().min(8).max(100).regex(/^[\w-]+$/);

@Injectable()
export class CommandsService {
  constructor(
    @Inject(SQL) private readonly sql: Sql,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CabinetsService) private readonly cabinets: CabinetsService,
  ) {}

  private async log(u: SessionUser, action: string, cabinet: { id: string; label: string }, value: string, ip?: string) {
    await this.sql`INSERT INTO activity_logs (user_id, user_email, action, target_type, target_id, target_name, new_value, ip)
                   VALUES (${u.id}, ${u.email}, ${action}, 'cabinet', ${cabinet.id}, ${cabinet.label}, ${value}, ${ip ?? null})`;
  }

  private async announce(cmd: Command) {
    await this.redis.publish(EVENTS_CHANNEL, JSON.stringify({ type: 'command.updated', command: cmd })).catch(() => undefined);
  }

  async enqueue(u: SessionUser, cabinetId: string, type: CommandType, rawParams: unknown, idemKey: string | undefined, ip?: string): Promise<Command> {
    const cid = await this.cabinets.assertCabinet(u.scope, cabinetId);
    const key = idemKey ? IdemKey.parse(idemKey) : null;
    if (key) {
      const seen = await this.sql<{ id: string; requested_by: string }[]>`SELECT id, requested_by FROM commands WHERE idempotency_key = ${key}`;
      if (seen[0]) {
        if (seen[0].requested_by !== u.id) throw new ApiError(409, 'idempotency_conflict', 'Idempotency-Key đã được dùng cho lệnh khác');
        return (await commandById(this.sql, seen[0].id))!;
      }
    }
    const n = await this.redis.incr(`cl:rl:cmd:${u.id}`);
    if (n === 1) await this.redis.expire(`cl:rl:cmd:${u.id}`, 60);
    if (n > CMD_PER_MIN) throw new ApiError(429, 'too_many_commands', `Tối đa ${CMD_PER_MIN} lệnh/phút, vui lòng đợi`, { max: CMD_PER_MIN });

    const rows = await this.sql<{ ltid: string; code: string; name: string; fw_profile: FwProfile; online: boolean | null; active: boolean }[]>`
      SELECT c.ltid, c.code, c.name, c.fw_profile, s.online, c.active FROM cabinets c LEFT JOIN cabinet_state s ON s.cabinet_id = c.id WHERE c.id = ${cid}`;
    const cab = rows[0]!;
    if (!cab.active) throw new ApiError(409, 'cabinet_decommissioned', 'Tủ đã ngừng sử dụng');
    if (firmwareBlocksCommands(cab.fw_profile))
      throw new ApiError(409, 'cabinet_unsafe_firmware', 'Firmware cũ không lọc LTID: chặn điều khiển để tránh ảnh hưởng tủ khác');
    const need = COMMAND_CAPABILITY[type];
    const schema = PARAMS[type];
    if (!schema || (need && !capabilitiesFor(cab.fw_profile).includes(need)))
      throw new ApiError(409, 'capability_unsupported', 'Thiết bị chưa hỗ trợ chức năng này');
    if (!cab.online) throw new ApiError(409, 'cabinet_offline', 'Tủ đang mất kết nối, không gửi được lệnh');
    const params = schema.parse(rawParams ?? {});
    let frames: string[];
    try {
      frames = buildCommandFrames(cab.ltid, type, params);
    } catch (e) {
      if (e instanceof FrameError) throw new ApiError(422, 'invalid_params', e.message, { reason: e.message });
      throw e;
    }
    const waiting = await this.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM commands WHERE cabinet_id = ${cid} AND status = 'queued'`;
    if ((waiting[0]?.n ?? 0) >= MAX_QUEUED_PER_CABINET)
      throw new ApiError(429, 'cabinet_busy', `Tủ đang có ${MAX_QUEUED_PER_CABINET} lệnh chờ gửi, vui lòng đợi`, { max: MAX_QUEUED_PER_CABINET });

    const inserted = await this.sql<{ id: string }[]>`
      INSERT INTO commands (cabinet_id, type, params, frame, idempotency_key, requested_by)
      VALUES (${cid}, ${type}, ${this.sql.json(params as never)}, ${frames.join('\n')}, ${key}, ${u.id})
      ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`;
    const id = inserted[0]?.id ?? (await this.sql<{ id: string }[]>`SELECT id FROM commands WHERE idempotency_key = ${key}`)[0]!.id;
    const cmd = (await commandById(this.sql, id))!;
    if (inserted[0]) {
      await this.log(u, 'Gửi lệnh', { id: cid, label: `${cab.code} - ${cab.name}` }, describeCommand(type, params), ip);
      // "queued" goes out before the worker is woken, so browsers never get it after "sent"
      await this.announce(cmd);
      await this.sql`SELECT pg_notify(${COMMANDS_NOTIFY}, ${id})`;
    }
    return cmd;
  }

  async forCabinet(u: SessionUser, cabinetId: string, limit: number): Promise<Command[]> {
    const cid = await this.cabinets.assertCabinet(u.scope, cabinetId);
    return selectCommands(this.sql, this.sql`WHERE m.cabinet_id = ${cid} ORDER BY m.queued_at DESC LIMIT ${limit}`);
  }

  async one(u: SessionUser, id: string): Promise<Command> {
    const cid = z.string().uuid().parse(id);
    const cmd = await commandById(this.sql, cid);
    if (!cmd) throw new ApiError(404, 'not_found', 'Không tìm thấy lệnh');
    await this.cabinets.assertCabinet(u.scope, cmd.cabinetId);
    return cmd;
  }

  async list(u: SessionUser, page: number, size: number): Promise<Page<Command>> {
    const where = this.sql`WHERE ${scopeWhere(this.sql, u.scope)}`;
    const total = await this.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM commands m JOIN cabinets c ON c.id = m.cabinet_id ${where}`;
    const items = await selectCommands(this.sql, this.sql`${where} ORDER BY m.queued_at DESC LIMIT ${size} OFFSET ${(page - 1) * size}`);
    return { items, total: total[0]?.n ?? 0, page, size };
  }

  /** Only a command still waiting in the queue can be cancelled; one on the wire cannot be recalled. */
  async cancel(u: SessionUser, id: string, ip?: string): Promise<Command> {
    const cmd = await this.one(u, id);
    const done = await this.sql`UPDATE commands SET status = 'cancelled', error = 'Hủy bởi người dùng' WHERE id = ${cmd.id} AND status = 'queued' RETURNING id`;
    if (!done.length) throw new ApiError(409, 'not_cancellable', 'Lệnh đã được gửi xuống tủ, không hủy được');
    await this.log(u, 'Hủy lệnh', { id: cmd.cabinetId, label: cmd.cabinetName }, describeCommand(cmd.type, cmd.params), ip);
    const updated = (await commandById(this.sql, cmd.id))!;
    await this.announce(updated);
    return updated;
  }

  /** Stores the cabinet's own schedule and sends it (SET_SCHEDULE); appliedAt is set when the cabinet acks. */
  async setSchedule(u: SessionUser, cabinetId: string, body: unknown, idemKey: string | undefined, ip?: string): Promise<Command> {
    const s = ScheduleBody.parse(body);
    // an astronomical schedule goes to the device as tonight's computed times (cabinet position)
    const cid = await this.cabinets.assertCabinet(u.scope, cabinetId);
    const pos = (await this.sql<{ lat: number; lng: number }[]>`SELECT ST_Y(location) AS lat, ST_X(location) AS lng FROM cabinets WHERE id = ${cid}`)[0]!;
    const w = desiredSchedule({ ...s, appliedAt: null, inheritedFromZone: false } as Schedule, null, { lat: Number(pos.lat), lng: Number(pos.lng) }).window;
    const cmd = await this.enqueue(u, cid, 'SET_SCHEDULE', { ...s, on1: w.on1, off1: w.off1 }, idemKey, ip);
    await this.sql`
      INSERT INTO schedules (cabinet_id, mode, source, on1, off1, on2, off2, branch1_enabled, branch2_enabled, offset_on_min, offset_off_min, updated_at)
      VALUES (${cmd.cabinetId}, ${s.mode}, ${s.source}, ${s.on1}, ${s.off1}, ${s.on2}, ${s.off2}, ${s.branch1Enabled}, ${s.branch2Enabled},
              ${s.offsetOnMin}, ${s.offsetOffMin}, now())
      ON CONFLICT (cabinet_id) DO UPDATE SET mode = excluded.mode, source = excluded.source, on1 = excluded.on1, off1 = excluded.off1,
        on2 = excluded.on2, off2 = excluded.off2, branch1_enabled = excluded.branch1_enabled, branch2_enabled = excluded.branch2_enabled,
        offset_on_min = excluded.offset_on_min, offset_off_min = excluded.offset_off_min, updated_at = now()`;
    await this.redis.publish(SCHEDULES_CHANNEL, JSON.stringify({ cabinetId: cid })).catch(() => undefined);
    return cmd;
  }
}

@Controller()
export class CommandsController {
  constructor(@Inject(CommandsService) private readonly svc: CommandsService) {}

  @Post('cabinets/:id/commands')
  @HttpCode(202)
  @RequirePerm('cabinet.control')
  send(@Req() r: AuthedRequest, @Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    const b = SendBody.parse(body);
    return this.svc.enqueue(r.user!, id, b.type, b.params, key, r.ip);
  }

  @Put('cabinets/:id/schedule')
  @HttpCode(202)
  @RequirePerm('schedule.manage')
  schedule(@Req() r: AuthedRequest, @Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    return this.svc.setSchedule(r.user!, id, body, key, r.ip);
  }

  @Get('cabinets/:id/commands')
  forCabinet(@Req() r: AuthedRequest, @Param('id') id: string, @Query('limit') limit = '50') {
    return this.svc.forCabinet(r.user!, id, Math.min(200, Math.max(1, Number(limit) || 50)));
  }

  @Get('commands')
  @RequirePerm('log.view')
  list(@Req() r: AuthedRequest, @Query('page') page = '1', @Query('size') size = '20') {
    return this.svc.list(r.user!, Math.max(1, Number(page) || 1), Math.min(200, Math.max(1, Number(size) || 20)));
  }

  @Get('commands/:id')
  one(@Req() r: AuthedRequest, @Param('id') id: string) {
    return this.svc.one(r.user!, id);
  }

  @Post('commands/:id/cancel')
  @HttpCode(200)
  @RequirePerm('cabinet.control')
  cancel(@Req() r: AuthedRequest, @Param('id') id: string) {
    return this.svc.cancel(r.user!, id, r.ip);
  }
}

@Module({ imports: [CabinetsModule], controllers: [CommandsController], providers: [CommandsService] })
export class CommandsModule {}
