import { Controller, Get, HttpCode, Inject, Module, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { Alarm } from '@citylight/shared';
import { LABELS, alarmTypeLabels } from '@citylight/shared';
import { z } from 'zod';
import { AuthModule, AuthService, RequirePerm, type AuthedRequest } from './auth';
import { CabinetsModule, CabinetsService } from './cabinets';
import { ApiError } from './errors';
import { SQL, type Sql } from './infra';
import { scopeWhere } from './scope';
import { DATE_TIME, EXPORT_MAX_ROWS, XLSX_TEXT, sendXlsx, vnTime } from './xlsx';

const AlarmQuery = z.object({
  active: z.enum(['true', 'false']).optional(),
  type: z.string().max(40).optional(),
  severity: z.enum(['critical', 'major', 'minor']).optional(),
  district: z.string().max(100).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(200).default(20),
});

@Controller()
export class AlarmsController {
  constructor(
    @Inject(SQL) private readonly sql: Sql,
    @Inject(CabinetsService) private readonly cabinets: CabinetsService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  @Get('alarms')
  @RequirePerm('alarm.view')
  async list(@Query() q: unknown, @Req() req: AuthedRequest) {
    const p = AlarmQuery.parse(q);
    const where = this.where(req, p);
    const items = await this.cabinets.alarmRows(where, p.size, (p.page - 1) * p.size);
    const total = await this.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM alarms a JOIN cabinets c ON c.id = a.cabinet_id LEFT JOIN areas d ON d.id = c.district_id ${where}`;
    return { items, total: total[0]?.n ?? 0, page: p.page, size: p.size };
  }

  /** Same filters as the list, every row (up to 50,000), M7. */
  @Get('alarms/export.xlsx')
  @RequirePerm('alarm.view')
  async export(@Query() q: unknown, @Req() req: AuthedRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const p = AlarmQuery.parse(q);
    const rows = (await this.cabinets.alarmRows(this.where(req, p), EXPORT_MAX_ROWS, 0)) as unknown as Alarm[];
    // S49: headers and enum values in the user's language; the alarm message stays as stored
    const lang = req.user!.lang;
    const X = XLSX_TEXT[lang];
    const T = X.alarms;
    const types = alarmTypeLabels(lang);
    return sendXlsx(reply, `${T.file}-${new Date().toISOString().slice(0, 10)}.xlsx`, T.sheet, [
      { header: T.code, value: (a) => a.code, width: 8 },
      { header: T.type, value: (a) => types[a.type] ?? a.type, width: 26 },
      { header: T.severity, value: (a) => LABELS[lang].severity[a.severity], width: 12 },
      { header: T.cabinet, value: (a) => `${a.cabinetCode} - ${a.cabinetName}`, width: 30 },
      { header: T.district, value: (a) => a.districtName },
      { header: T.message, value: (a) => a.message, width: 50 },
      { header: T.start, value: (a) => vnTime(a.startedAt), numFmt: DATE_TIME, width: 18 },
      { header: T.end, value: (a) => vnTime(a.endedAt), numFmt: DATE_TIME, width: 18 },
      { header: T.active, value: (a) => (a.active ? X.yes : ''), width: 9 },
      { header: T.ackedBy, value: (a) => a.ackedBy, width: 20 },
      { header: T.ackedAt, value: (a) => vnTime(a.ackedAt), numFmt: DATE_TIME, width: 18 },
    ], rows);
  }

  private where(req: AuthedRequest, p: z.infer<typeof AlarmQuery>) {
    return this.sql`
      WHERE ${scopeWhere(this.sql, req.user!.scope)}
        AND (${p.active === 'true'}::boolean = false OR a.active)
        AND (${p.type ?? null}::text IS NULL OR a.type = ${p.type ?? null})
        AND (${p.severity ?? null}::text IS NULL OR a.severity::text = ${p.severity ?? null})
        AND (${p.district ?? null}::text IS NULL OR coalesce(d.name, 'Chưa phân khu vực') = ${p.district ?? null})
        AND (${p.from ?? null}::timestamptz IS NULL OR a.started_at >= ${p.from ?? null})
        AND (${p.to ?? null}::timestamptz IS NULL OR a.started_at <= ${p.to ?? null})`;
  }

  @Post('alarms/:id/ack')
  @HttpCode(200)
  @RequirePerm('alarm.ack')
  async ack(@Param('id') id: string, @Req() req: AuthedRequest) {
    const aid = z.string().uuid().parse(id);
    const owner = await this.sql<{ cabinet_id: string }[]>`SELECT cabinet_id FROM alarms WHERE id = ${aid}`;
    if (!owner[0]) throw new ApiError(404, 'not_found', 'Không tìm thấy cảnh báo');
    await this.cabinets.assertCabinet(req.user!.scope, owner[0].cabinet_id);
    const rows = await this.sql<{ code: string; message: string; cabinet_code: string }[]>`
      UPDATE alarms a SET acked_by = ${req.user!.id}, acked_at = now() FROM cabinets c
      WHERE a.id = ${aid} AND c.id = a.cabinet_id AND a.acked_at IS NULL
      RETURNING a.code, a.message, c.code AS cabinet_code`;
    if (!rows[0]) throw new ApiError(404, 'no_unacked_alarm', 'Không tìm thấy cảnh báo chưa xác nhận');
    await this.auth.log(req.user!, 'Xác nhận cảnh báo', req.ip, { type: 'alarm', id: aid, name: `${rows[0].cabinet_code} - ${rows[0].code}` }, rows[0].message);
    const items = await this.cabinets.alarmRows(this.sql`WHERE a.id = ${aid}`, 1, 0);
    return items[0];
  }

  @Get('devices/unknown')
  @RequirePerm('admin.devices')
  unknown() {
    // gps = last fix the device sent (pre-fills the register form), null when it never had one
    // otherImei = a second IMEI under the same LTID (S42): registering then requires choosing one
    return this.sql`SELECT ltid, imei, other_imei AS "otherImei", first_seen_at AS "firstSeenAt", last_seen_at AS "lastSeenAt", frames,
                           CASE WHEN gps IS NULL THEN NULL ELSE json_build_object('lat', ST_Y(gps), 'lng', ST_X(gps)) END AS gps
                    FROM unknown_devices u
                    -- a row re-inserted by a frame buffered while the cabinet was being registered
                    WHERE NOT EXISTS (SELECT 1 FROM cabinets c WHERE c.active AND upper(c.ltid) = upper(u.ltid))
                    ORDER BY last_seen_at DESC LIMIT 200`;
  }

  @Get('zones')
  zones() {
    return this.sql`
      SELECT z.id, z.name, json_build_object('lat', ST_Y(z.center), 'lng', ST_X(z.center)) AS center,
             (SELECT count(*)::int FROM cabinets c WHERE c.active AND (c.zone1_id = z.id OR c.zone2_id = z.id)) AS "cabinetCount"
      FROM zones z ORDER BY z.name`;
  }

  @Get('management-units')
  units() {
    return this.sql`SELECT id, name FROM management_units ORDER BY name`;
  }
}

@Module({ imports: [CabinetsModule, AuthModule], controllers: [AlarmsController] })
export class AlarmsModule {}
