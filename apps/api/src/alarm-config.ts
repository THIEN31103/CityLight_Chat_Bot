// M5 alarm configuration: per-cabinet thresholds (read by the ingest worker), the alarm rule list,
// and each user's notification settings + Telegram linking (sent by the notify-worker).
import { Body, Controller, Delete, Get, HttpCode, Inject, Module, Param, Post, Put, Req } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { z } from 'zod';
import type { AlarmSeverity, Thresholds } from '@citylight/shared';
import { RAISED_ALARM_TYPES, defaultThresholds, errorCatalog } from '@citylight/shared';
import { CONFIG_CHANNEL, NOTIFY_CHANGED_CHANNEL, TG_BOT_KEY, TG_LINK_PREFIX, TG_LINK_TTL_S } from '@citylight/db/notify';
import { RequirePerm, type AuthedRequest } from './auth';
import { CabinetsModule, CabinetsService } from './cabinets';
import { ApiError } from './errors';
import { REDIS, SQL, type Sql } from './infra';

const TV = (max: number) => z.object({ enabled: z.boolean(), value: z.number().min(0).max(max) });
export const ThresholdsBody = z.object({
  voltageHigh: TV(500),
  voltageLow: TV(500),
  voltageSwing: TV(200),
  currentHigh: TV(1000),
  currentLow: TV(1000),
  currentSwing: TV(1000),
  currentNoLoad: TV(1000),
  leakMa: TV(5000),
  tempC: TV(150),
  batteryLowMv: TV(10_000),
}).refine((t) => !(t.voltageHigh.enabled && t.voltageLow.enabled) || t.voltageLow.value < t.voltageHigh.value, {
  message: 'Ngưỡng thấp áp phải nhỏ hơn ngưỡng quá áp',
  path: ['voltageLow'],
});

@Controller()
export class AlarmConfigController {
  constructor(
    @Inject(SQL) private readonly sql: Sql,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CabinetsService) private readonly cabinets: CabinetsService,
  ) {}

  /** Cabinet override; the ingest worker reloads at once (Redis cl:config). */
  @Put('cabinets/:id/thresholds')
  @RequirePerm('cabinet.configure')
  async setThresholds(@Req() r: AuthedRequest, @Param('id') id: string, @Body() body: unknown): Promise<Thresholds> {
    const cid = await this.cabinets.assertCabinet(r.user!.scope, id);
    const t = ThresholdsBody.parse(body) as Thresholds;
    await this.sql`
      INSERT INTO thresholds (cabinet_id, values, updated_at) VALUES (${cid}, ${this.sql.json(t as never)}, now())
      ON CONFLICT (cabinet_id) DO UPDATE SET values = excluded.values, updated_at = now()`;
    const c = (await this.sql<{ code: string; name: string }[]>`SELECT code, name FROM cabinets WHERE id = ${cid}`)[0]!;
    await this.sql`INSERT INTO activity_logs (user_id, user_email, action, target_type, target_id, target_name, new_value, ip)
                   VALUES (${r.user!.id}, ${r.user!.email}, 'Cài đặt ngưỡng', 'cabinet', ${cid}, ${`${c.code} - ${c.name}`}, ${JSON.stringify(t)}, ${r.ip ?? null})`;
    await this.redis.publish(CONFIG_CHANNEL, JSON.stringify({ type: 'thresholds', cabinetId: cid })).catch(() => undefined);
    return t;
  }

  /** Read-only rule list (admin page); "enabled" = the server raises this type today. */
  @Get('alarm-rules')
  @RequirePerm('alarm.view')
  rules(@Req() r: AuthedRequest) {
    const d = defaultThresholds();
    return errorCatalog(r.user!.lang).map((e) => ({
      type: e.type, code: e.code, title: e.title, severity: e.severity, condition: e.source,
      enabled: RAISED_ALARM_TYPES.includes(e.type),
      thresholdDefault:
        e.type === 'over_voltage' ? d.voltageHigh : e.type === 'under_voltage' ? d.voltageLow : e.type === 'over_current' ? d.currentHigh
        : e.type === 'leak_current' ? d.leakMa : e.type === 'over_temp' ? d.tempC : e.type === 'battery_low' ? d.batteryLowMv : null,
    }));
  }
}

const SEVERITIES = ['critical', 'major', 'minor'] as const;
const NotifyBody = z.object({
  minSeverity: z.enum(SEVERITIES),
  telegram: z.boolean(),
});

@Controller('me/notifications')
export class NotificationsController {
  constructor(@Inject(SQL) private readonly sql: Sql, @Inject(REDIS) private readonly redis: Redis) {}

  private async bot(): Promise<string | null> {
    const raw = await this.redis.get(TG_BOT_KEY);
    return raw ? ((JSON.parse(raw) as { username?: string }).username ?? null) : null;
  }

  @Get()
  async get(@Req() r: AuthedRequest) {
    const rows = await this.sql<{ channel: string; address: string; min_severity: AlarmSeverity; enabled: boolean }[]>`
      SELECT channel, address, min_severity, enabled FROM notification_subscriptions WHERE user_id = ${r.user!.id}`;
    const tg = rows.find((x) => x.channel === 'telegram');
    const bot = await this.bot();
    return {
      minSeverity: tg?.min_severity ?? 'major',
      telegram: { available: !!bot, botUsername: bot, linked: !!tg, enabled: !!tg?.enabled },
      // need an approved Zalo OA / an SMTP server first (decision M5-E)
      zalo: { available: false },
      email: { available: false },
    };
  }

  @Put()
  async put(@Req() r: AuthedRequest, @Body() body: unknown) {
    const b = NotifyBody.parse(body);
    const done = await this.sql`
      UPDATE notification_subscriptions SET enabled = ${b.telegram}, min_severity = ${b.minSeverity}
      WHERE user_id = ${r.user!.id} AND channel = 'telegram' RETURNING id`;
    if (!done.length && b.telegram) throw new ApiError(409, 'telegram_not_linked', 'Chưa liên kết Telegram: bấm "Liên kết Telegram" trước');
    await this.changed();
    return this.get(r);
  }

  /** One-time code: the user sends "/start <code>" to the bot, the notify-worker stores the chat id. */
  @Post('telegram/link')
  async link(@Req() r: AuthedRequest) {
    const bot = await this.bot();
    if (!bot) throw new ApiError(409, 'telegram_unavailable', 'Máy chủ chưa cấu hình bot Telegram');
    const code = randomBytes(6).toString('base64url');
    await this.redis.set(`${TG_LINK_PREFIX}${code}`, r.user!.id, 'EX', TG_LINK_TTL_S);
    return { code, botUsername: bot, url: `https://t.me/${bot}?start=${code}`, expiresAt: new Date(Date.now() + TG_LINK_TTL_S * 1000).toISOString() };
  }

  @Delete('telegram')
  @HttpCode(204)
  async unlink(@Req() r: AuthedRequest) {
    await this.sql`DELETE FROM notification_subscriptions WHERE user_id = ${r.user!.id} AND channel = 'telegram'`;
    await this.changed();
  }

  private async changed() {
    await this.redis.publish(NOTIFY_CHANGED_CHANNEL, '1').catch(() => undefined);
  }
}

@Module({ imports: [CabinetsModule], controllers: [AlarmConfigController, NotificationsController] })
export class AlarmConfigModule {}
