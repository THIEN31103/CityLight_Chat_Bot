// Incidents (spec S7–S9, M7). Workflow enforced here (shared/incidents.ts), area scope on every
// call, assignee = a real user who can resolve and sees the cabinet, photos on disk behind the API,
// Excel export by filter, monthly report. Assignment / overdue notices go out via the notify-worker.
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Module, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { PendingQuery, Row as PgRow } from 'postgres';
import type { FastifyReply } from 'fastify';
import { Redis } from 'ioredis';
import { z } from 'zod';
import type { AlarmType, Incident, IncidentPhoto, IncidentStatus, Page, RoleKey } from '@citylight/shared';
import {
  INCIDENT_CATEGORIES, INCIDENT_STATUS_LABELS, LABELS, OPEN_INCIDENT_STATUSES, ROLE_PERMISSIONS, categoryForAlarm, findTransition, hasPermission,
  incidentCategoryLabel, incidentOverdue,
  scrubLtid,
} from '@citylight/shared';
import { EVENTS_CHANNEL } from '@citylight/db/commands';
import { RequirePerm, type AuthedRequest, type SessionUser } from './auth';
import { CabinetsModule, CabinetsService } from './cabinets';
import { ApiError } from './errors';
import { REDIS, SQL, type Sql } from './infra';
import { scopeWhere } from './scope';
import { DATE_TIME, EXPORT_MAX_ROWS, XLSX_TEXT, sendXlsx, vnTime } from './xlsx';

const UPLOAD_DIR = resolve(process.env.UPLOAD_DIR ?? './data/uploads');
const MAX_PHOTOS = 10;
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const uuid = z.string().uuid();

const ListQuery = z.object({
  /** all | mine | overdue | statuses joined by "_" (new_assigned…) */
  q: z.string().max(60).default('all'),
  district: z.string().max(100).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(200).default(20),
});
const CreateBody = z.object({
  cabinetId: uuid.optional(),
  alarmId: uuid.optional(),
  category: z.string().trim().min(1).max(60).optional(),
  content: z.string().trim().min(1).max(4000).optional(),
}).refine((b) => b.cabinetId || b.alarmId, { message: 'Cần cabinetId hoặc alarmId' });
const TransitionBody = z.object({
  to: z.enum(['new', 'assigned', 'deferred', 'resolved', 'closed']),
  note: z.string().trim().max(4000).optional(),
  assigneeId: uuid.optional(),
  deadline: z.coerce.date().optional(),
  resolution: z.string().trim().max(4000).optional(),
});

const RESOLVER_ROLES = (Object.keys(ROLE_PERMISSIONS) as RoleKey[]).filter((r) => hasPermission(r, 'incident.resolve'));

interface Row {
  id: string; code: string; cabinet_id: string; cabinet_name: string; district: string | null; ward: string | null; alarm_id: string | null;
  source: 'alarm' | 'manual'; category: string; content: string; lat: number | null; lng: number | null; reported_by: string; reported_at: Date;
  status: IncidentStatus; assignee: string | null; assignee_id: string | null; deadline: Date | null; resolution: string | null; resolved_at: Date | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function dto(r: Row): Incident {
  const deadline = iso(r.deadline);
  return {
    id: r.id, code: r.code, cabinetId: r.cabinet_id, cabinetName: r.cabinet_name, districtName: r.district ?? 'Chưa phân khu vực', wardName: r.ward ?? '—',
    source: r.source, category: r.category, content: r.content, location: { lat: Number(r.lat ?? 0), lng: Number(r.lng ?? 0) }, reportedBy: r.reported_by,
    reportedAt: r.reported_at.toISOString(), status: r.status, assignee: r.assignee, assigneeId: r.assignee_id, deadline, resolution: r.resolution,
    resolvedAt: iso(r.resolved_at), photos: [], events: [], alarmId: r.alarm_id, overdue: incidentOverdue({ status: r.status, deadline }),
  };
}

/** Image type from the first bytes; the file name and the client's content type are not trusted. */
export function sniffImage(b: Buffer): { mime: string; ext: string } | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}

@Injectable()
export class IncidentsService {
  constructor(
    @Inject(SQL) private readonly sql: Sql,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CabinetsService) private readonly cabinets: CabinetsService,
  ) {}

  private select(where: PendingQuery<PgRow[]>, tail: PendingQuery<PgRow[]>) {
    return this.sql<Row[]>`
      SELECT i.id, i.code, i.cabinet_id, c.code || ' - ' || c.name AS cabinet_name, d.name AS district, w.name AS ward, i.alarm_id, i.source, i.category,
             i.content, ST_Y(i.location) AS lat, ST_X(i.location) AS lng, i.reported_by, i.reported_at, i.status, i.assignee, i.assignee_id, i.deadline,
             i.resolution, i.resolved_at
      FROM incidents i JOIN cabinets c ON c.id = i.cabinet_id LEFT JOIN areas d ON d.id = c.district_id LEFT JOIN areas w ON w.id = c.ward_id
      ${where} ${tail}`;
  }

  private where(u: SessionUser, p: z.infer<typeof ListQuery>) {
    const statuses = p.q === 'all' || p.q === 'mine' || p.q === 'overdue' ? null : p.q.split('_').filter((s) => ['new', 'assigned', 'deferred', 'resolved', 'closed'].includes(s));
    return this.sql`
      WHERE ${scopeWhere(this.sql, u.scope)}
        AND (${statuses}::text[] IS NULL OR i.status::text = ANY(${statuses}::text[]))
        AND (${p.q === 'mine'}::boolean = false OR i.assignee_id = ${u.id})
        AND (${p.q === 'overdue'}::boolean = false OR (i.status = 'assigned' AND i.deadline < now()))
        AND (${p.district ?? null}::text IS NULL OR coalesce(d.name, 'Chưa phân khu vực') = ${p.district ?? null})
        AND (${p.from ?? null}::timestamptz IS NULL OR i.reported_at >= ${p.from ?? null})
        AND (${p.to ?? null}::timestamptz IS NULL OR i.reported_at <= ${p.to ?? null})`;
  }

  async list(u: SessionUser, query: unknown): Promise<Page<Incident>> {
    const p = ListQuery.parse(query);
    const where = this.where(u, p);
    const rows = await this.select(where, this.sql`ORDER BY i.reported_at DESC LIMIT ${p.size} OFFSET ${(p.page - 1) * p.size}`);
    const total = await this.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM incidents i JOIN cabinets c ON c.id = i.cabinet_id LEFT JOIN areas d ON d.id = c.district_id ${where}`;
    return { items: rows.map(dto), total: total[0]?.n ?? 0, page: p.page, size: p.size };
  }

  async exportRows(u: SessionUser, query: unknown) {
    const p = ListQuery.parse({ ...(query as object), page: 1, size: 1 });
    return (await this.select(this.where(u, p), this.sql`ORDER BY i.reported_at DESC LIMIT ${EXPORT_MAX_ROWS}`)).map(dto);
  }

  /** Incident + scope check (404 when missing, 403 out of scope). */
  async load(u: SessionUser, id: string): Promise<Incident> {
    const rows = await this.select(this.sql`WHERE i.id = ${uuid.parse(id)}`, this.sql``);
    if (!rows[0]) throw new ApiError(404, 'not_found', 'Không tìm thấy sự cố');
    await this.cabinets.assertCabinet(u.scope, rows[0].cabinet_id);
    return dto(rows[0]);
  }

  async one(u: SessionUser, id: string): Promise<Incident> {
    const inc = await this.load(u, id);
    inc.events = (await this.sql<{ at: Date; by: string; action: string; note: string | null }[]>`
      SELECT at, "by", action, note FROM incident_events WHERE incident_id = ${inc.id} ORDER BY at, id`).map((e) => ({ ...e, at: e.at.toISOString() }));
    inc.photoList = await this.photos(inc.id);
    return inc;
  }

  private async photos(incidentId: string): Promise<IncidentPhoto[]> {
    const rows = await this.sql<{ id: string; kind: 'report' | 'resolution'; uploaded_by: string; created_at: Date }[]>`
      SELECT id, kind, uploaded_by, created_at FROM incident_photos WHERE incident_id = ${incidentId} ORDER BY created_at`;
    return rows.map((r) => ({ id: r.id, kind: r.kind, url: `/api/v1/incidents/${incidentId}/photos/${r.id}`, uploadedBy: r.uploaded_by, createdAt: r.created_at.toISOString() }));
  }

  private async event(incidentId: string, u: SessionUser, action: string, note: string | null) {
    await this.sql`INSERT INTO incident_events (incident_id, "by", action, note) VALUES (${incidentId}, ${u.fullName}, ${action}, ${note})`;
  }

  private async log(u: SessionUser, action: string, inc: { id: string; code: string }, value: string | null, ip?: string) {
    await this.sql`INSERT INTO activity_logs (user_id, user_email, action, target_type, target_id, target_name, new_value, ip)
                   VALUES (${u.id}, ${u.email}, ${action}, 'incident', ${inc.id}, ${inc.code}, ${value}, ${ip ?? null})`;
  }

  /** Field staff (incident.resolve) may report too; viewers may not. */
  private assertCanReport(u: SessionUser) {
    if (!hasPermission(u.role, 'incident.manage') && !hasPermission(u.role, 'incident.resolve')) throw new ApiError(403, 'forbidden', 'Không đủ quyền');
  }

  async create(u: SessionUser, body: unknown, ip?: string): Promise<Incident> {
    this.assertCanReport(u);
    const b = CreateBody.parse(body);
    let cabinetId = b.cabinetId ?? null;
    let category = b.category;
    let content = b.content;
    if (b.alarmId) {
      const a = (await this.sql<{ cabinet_id: string; type: AlarmType; code: string; message: string }[]>`
        SELECT cabinet_id, type, code, message FROM alarms WHERE id = ${b.alarmId}`)[0];
      if (!a) throw new ApiError(404, 'not_found', 'Không tìm thấy cảnh báo');
      if (cabinetId && cabinetId !== a.cabinet_id) throw new ApiError(422, 'alarm_other_cabinet', 'Cảnh báo thuộc tủ khác');
      cabinetId = a.cabinet_id;
      category ??= categoryForAlarm(a.type);
      content ??= `${a.code}: ${scrubLtid(a.message)}`;
      const open = (await this.sql<{ id: string; code: string }[]>`
        SELECT id, code FROM incidents WHERE alarm_id = ${b.alarmId} AND status::text = ANY(${[...OPEN_INCIDENT_STATUSES]}::text[])`)[0];
      if (open) throw new ApiError(409, 'incident_exists', `Cảnh báo này đã có sự cố ${open.code} đang mở`, { code: open.code });
    }
    if (!category || !content) throw new ApiError(422, 'incident_fields_required', 'Cần phân loại và nội dung');
    const cid = await this.cabinets.assertCabinet(u.scope, cabinetId!);
    const rows = await this.sql<{ id: string; code: string }[]>`
      INSERT INTO incidents (code, cabinet_id, alarm_id, source, category, content, location, reported_by)
      SELECT 'SC' || lpad(nextval('incident_code_seq')::text, 5, '0'), c.id, ${b.alarmId ?? null}, ${b.alarmId ? 'alarm' : 'manual'}, ${category}, ${content},
             c.location, ${u.fullName}
      FROM cabinets c WHERE c.id = ${cid}
      ON CONFLICT DO NOTHING
      RETURNING id, code`;
    if (!rows[0]) throw new ApiError(409, 'incident_exists_concurrent', 'Cảnh báo này đã có sự cố đang mở');
    await this.event(rows[0].id, u, b.alarmId ? 'Tạo từ cảnh báo' : 'Tạo sự cố', content);
    await this.log(u, 'Tạo sự cố', rows[0], `${category}: ${content}`, ip);
    return this.one(u, rows[0].id);
  }

  /** Users who can resolve and whose scope covers the cabinet (same organisation). */
  async assignees(u: SessionUser, cabinetId: string) {
    const cid = await this.cabinets.assertCabinet(u.scope, cabinetId);
    return this.sql<{ id: string; fullName: string; email: string; role: RoleKey }[]>`
      WITH RECURSIVE t AS (
        SELECT s.user_id, a.id FROM user_scopes s JOIN areas a ON a.id = s.area_id
        UNION SELECT t.user_id, a.id FROM areas a JOIN t ON a.parent_id = t.id
      ), c AS (SELECT organization_id, district_id, ward_id FROM cabinets WHERE id = ${cid})
      SELECT u.id, u.full_name AS "fullName", u.email, u.role FROM users u, c
      WHERE u.active AND u.organization_id = c.organization_id AND u.role::text = ANY(${RESOLVER_ROLES}::text[])
        AND (u.role IN ('admin', 'manager') OR u.scope_all OR EXISTS (SELECT 1 FROM t WHERE t.user_id = u.id AND (t.id = c.district_id OR t.id = c.ward_id)))
      ORDER BY u.full_name`;
  }

  async transition(u: SessionUser, id: string, body: unknown, ip?: string): Promise<Incident> {
    const b = TransitionBody.parse(body);
    const inc = await this.load(u, id);
    const t = findTransition(inc.status, b.to);
    if (!t)
      throw new ApiError(409, 'invalid_transition', `Không chuyển được từ "${INCIDENT_STATUS_LABELS[inc.status]}" sang "${INCIDENT_STATUS_LABELS[b.to]}"`, {
        from: INCIDENT_STATUS_LABELS[inc.status],
        to: INCIDENT_STATUS_LABELS[b.to],
        fromEn: LABELS.en.incidentStatus[inc.status],
        toEn: LABELS.en.incidentStatus[b.to],
      });
    if (!hasPermission(u.role, t.perm)) throw new ApiError(403, 'forbidden', 'Không đủ quyền');
    let assignee: { id: string; fullName: string } | null = null;
    if (t.needs === 'assign') {
      if (!b.assigneeId) throw new ApiError(422, 'assignee_required', 'Chọn người xử lý');
      if (!b.deadline || b.deadline.getTime() < Date.now()) throw new ApiError(422, 'deadline_not_future', 'Hạn xử lý phải ở tương lai');
      assignee = (await this.assignees(u, inc.cabinetId)).find((x) => x.id === b.assigneeId) ?? null;
      if (!assignee) throw new ApiError(422, 'invalid_assignee', 'Người này không xử lý được sự cố ở khu vực của tủ');
    }
    if (t.needs === 'resolve') {
      // field staff report only their own tasks; a manager may close it on their behalf
      if (inc.assigneeId !== u.id && !hasPermission(u.role, 'incident.manage')) throw new ApiError(403, 'not_assignee', 'Sự cố này không giao cho bạn');
      if (!(b.resolution ?? b.note)) throw new ApiError(422, 'resolution_required', 'Nhập nội dung xử lý');
    }
    const done = await this.sql`
      UPDATE incidents SET status = ${b.to},
        assignee = CASE WHEN ${!!assignee} THEN ${assignee?.fullName ?? null} ELSE assignee END,
        assignee_id = CASE WHEN ${!!assignee} THEN ${assignee?.id ?? null}::uuid ELSE assignee_id END,
        deadline = CASE WHEN ${!!assignee} THEN ${b.deadline ?? null}::timestamptz ELSE deadline END,
        overdue_notified_at = CASE WHEN ${!!assignee} THEN NULL ELSE overdue_notified_at END,
        resolution = CASE WHEN ${b.to === 'resolved'} THEN ${b.resolution ?? b.note ?? null} ELSE resolution END,
        resolved_at = CASE WHEN ${b.to === 'resolved'} THEN now() WHEN ${b.to === 'new'} THEN NULL ELSE resolved_at END
      WHERE id = ${inc.id} AND status = ${inc.status} RETURNING id`;
    if (!done.length) throw new ApiError(409, 'conflict', 'Sự cố vừa được người khác cập nhật, tải lại trang');
    const note = [assignee ? `Giao cho ${assignee.fullName}, hạn ${b.deadline!.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false })}` : null, b.resolution ?? b.note ?? null]
      .filter(Boolean).join(' — ') || null;
    await this.event(inc.id, u, t.label, note);
    await this.log(u, t.label, inc, note, ip);
    if (assignee) {
      await this.redis.publish(EVENTS_CHANNEL, JSON.stringify({
        type: 'incident.assigned',
        incident: { id: inc.id, code: inc.code, cabinetName: inc.cabinetName, districtName: inc.districtName, category: inc.category, content: inc.content,
          deadline: b.deadline!.toISOString(), assigneeId: assignee.id, by: u.fullName },
      })).catch(() => undefined);
    }
    return this.one(u, inc.id);
  }

  // ---------------- photos ----------------

  async addPhoto(u: SessionUser, id: string, kind: string, file: Buffer, ip?: string): Promise<IncidentPhoto> {
    this.assertCanReport(u);
    const inc = await this.load(u, id);
    if (kind !== 'report' && kind !== 'resolution') throw new ApiError(422, 'invalid_request', 'kind = report | resolution');
    const type = sniffImage(file);
    if (!type) throw new ApiError(415, 'unsupported_image_type', 'Chỉ nhận ảnh JPG, PNG hoặc WebP');
    const n = (await this.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM incident_photos WHERE incident_id = ${inc.id}`)[0]!.n;
    if (n >= MAX_PHOTOS) throw new ApiError(409, 'too_many_photos', `Tối đa ${MAX_PHOTOS} ảnh mỗi sự cố`, { max: MAX_PHOTOS });
    const row = (await this.sql<{ id: string }[]>`
      INSERT INTO incident_photos (incident_id, kind, mime, size, path, uploaded_by) VALUES (${inc.id}, ${kind}, ${type.mime}, ${file.length}, '', ${u.fullName})
      RETURNING id`)[0]!;
    const rel = join('incidents', inc.id, `${row.id}.${type.ext}`);
    try {
      await mkdir(join(UPLOAD_DIR, 'incidents', inc.id), { recursive: true });
      await writeFile(join(UPLOAD_DIR, rel), file);
    } catch (e) {
      await this.sql`DELETE FROM incident_photos WHERE id = ${row.id}`;
      throw e;
    }
    await this.sql`UPDATE incident_photos SET path = ${rel} WHERE id = ${row.id}`;
    await this.event(inc.id, u, kind === 'report' ? 'Thêm ảnh hiện trường' : 'Thêm ảnh sau xử lý', null);
    await this.log(u, 'Thêm ảnh sự cố', inc, `${type.mime}, ${Math.round(file.length / 1024)} KB`, ip);
    return (await this.photos(inc.id)).find((p) => p.id === row.id)!;
  }

  async photoFile(u: SessionUser, id: string, photoId: string) {
    const inc = await this.load(u, id);
    const p = (await this.sql<{ path: string; mime: string; size: number }[]>`
      SELECT path, mime, size FROM incident_photos WHERE id = ${uuid.parse(photoId)} AND incident_id = ${inc.id}`)[0];
    if (!p?.path) throw new ApiError(404, 'not_found', 'Không tìm thấy ảnh');
    const full = resolve(UPLOAD_DIR, p.path);
    if (!full.startsWith(UPLOAD_DIR)) throw new ApiError(404, 'not_found', 'Không tìm thấy ảnh');
    await stat(full).catch(() => {
      throw new ApiError(404, 'not_found', 'File ảnh không còn trên máy chủ');
    });
    return { full, mime: p.mime, size: p.size };
  }

  async deletePhoto(u: SessionUser, id: string, photoId: string, ip?: string) {
    if (!hasPermission(u.role, 'incident.manage')) throw new ApiError(403, 'forbidden', 'Không đủ quyền');
    const f = await this.photoFile(u, id, photoId);
    await this.sql`DELETE FROM incident_photos WHERE id = ${photoId}`;
    await rm(f.full, { force: true });
    await this.log(u, 'Xóa ảnh sự cố', { id, code: (await this.load(u, id)).code }, null, ip);
  }

  // ---------------- report ----------------

  async report(u: SessionUser, month: string) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new ApiError(422, 'invalid_request', 'month = YYYY-MM');
    const from = new Date(`${month}-01T00:00:00+07:00`);
    const to = new Date(from);
    to.setUTCMonth(to.getUTCMonth() + 1);
    const rows = await this.sql<{ day: number; status: IncidentStatus; district: string; category: string; hours: number | null; overdue: boolean; late: boolean }[]>`
      SELECT extract(day FROM i.reported_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::int AS day, i.status, coalesce(d.name, 'Chưa phân khu vực') AS district, i.category,
             CASE WHEN i.resolved_at IS NOT NULL THEN extract(epoch FROM i.resolved_at - i.reported_at) / 3600 END AS hours,
             (i.status = 'assigned' AND i.deadline < now()) AS overdue,
             (i.deadline IS NOT NULL AND coalesce(i.resolved_at, now()) > i.deadline) AS late
      FROM incidents i JOIN cabinets c ON c.id = i.cabinet_id LEFT JOIN areas d ON d.id = c.district_id
      WHERE i.reported_at >= ${from} AND i.reported_at < ${to} AND ${scopeWhere(this.sql, u.scope)}`;
    const days = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
    const byDay = Array.from({ length: days }, (_, i) => ({ day: i + 1, new: 0, assigned: 0, done: 0, deferred: 0 }));
    const byDistrict: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    for (const r of rows) {
      const d = byDay[r.day - 1]!;
      if (r.status === 'resolved' || r.status === 'closed') d.done++;
      else d[r.status]++;
      byDistrict[r.district] = (byDistrict[r.district] ?? 0) + 1;
      byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
    }
    const resolved = rows.filter((r) => r.hours !== null);
    const withDeadline = rows.filter((r) => r.late || r.overdue || r.status !== 'new');
    return {
      month, total: rows.length, byDay, byDistrict, byCategory,
      avgResolveHours: resolved.length ? Math.round((resolved.reduce((s, r) => s + Number(r.hours), 0) / resolved.length) * 10) / 10 : 0,
      overdue: rows.filter((r) => r.overdue).length,
      /** share of incidents with a deadline that were (or still are) past it */
      lateRate: withDeadline.length ? Math.round((rows.filter((r) => r.late).length / withDeadline.length) * 1000) / 10 : 0,
    };
  }
}

@Controller('incidents')
export class IncidentsController {
  constructor(@Inject(IncidentsService) private readonly svc: IncidentsService) {}

  @Get()
  @RequirePerm('incident.view')
  list(@Req() r: AuthedRequest, @Query() q: unknown) {
    return this.svc.list(r.user!, q);
  }

  @Get('export.xlsx')
  @RequirePerm('incident.view')
  async export(@Req() r: AuthedRequest, @Query() q: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const rows = await this.svc.exportRows(r.user!, q);
    // S49: headers and enum values in the user's language; content / resolution stay as entered
    const lang = r.user!.lang;
    const X = XLSX_TEXT[lang];
    const T = X.incidents;
    return sendXlsx(reply, `${T.file}-${new Date().toISOString().slice(0, 10)}.xlsx`, T.sheet, [
      { header: T.code, value: (i) => i.code, width: 10 },
      { header: T.cabinet, value: (i) => i.cabinetName, width: 30 },
      { header: T.district, value: (i) => i.districtName },
      { header: T.ward, value: (i) => i.wardName },
      { header: T.reportedAt, value: (i) => vnTime(i.reportedAt), numFmt: DATE_TIME, width: 18 },
      { header: T.reportedBy, value: (i) => i.reportedBy, width: 20 },
      { header: T.source, value: (i) => (i.source === 'alarm' ? T.fromAlarm : T.manual), width: 10 },
      { header: T.category, value: (i) => incidentCategoryLabel(i.category, lang), width: 18 },
      { header: T.content, value: (i) => scrubLtid(i.content), width: 50 },
      { header: T.status, value: (i) => LABELS[lang].incidentStatus[i.status] },
      { header: T.assignee, value: (i) => i.assignee, width: 20 },
      { header: T.deadline, value: (i) => vnTime(i.deadline), numFmt: DATE_TIME, width: 18 },
      { header: T.overdue, value: (i) => (i.overdue ? X.yes : ''), width: 9 },
      { header: T.resolvedAt, value: (i) => vnTime(i.resolvedAt), numFmt: DATE_TIME, width: 18 },
      { header: T.resolution, value: (i) => i.resolution, width: 40 },
    ], rows);
  }

  @Get('report')
  @RequirePerm('incident.view')
  report(@Req() r: AuthedRequest, @Query('month') month?: string) {
    return this.svc.report(r.user!, month ?? new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7));
  }

  @Get('categories')
  @RequirePerm('incident.view')
  categories() {
    return INCIDENT_CATEGORIES;
  }

  @Get('assignees')
  @RequirePerm('incident.manage')
  assignees(@Req() r: AuthedRequest, @Query('cabinetId') cabinetId: string) {
    return this.svc.assignees(r.user!, cabinetId);
  }

  @Get(':id')
  @RequirePerm('incident.view')
  one(@Req() r: AuthedRequest, @Param('id') id: string) {
    return this.svc.one(r.user!, id);
  }

  @Post()
  @RequirePerm('incident.view')
  create(@Req() r: AuthedRequest, @Body() body: unknown) {
    return this.svc.create(r.user!, body, r.ip);
  }

  @Post(':id/transition')
  @HttpCode(200)
  @RequirePerm('incident.view')
  transition(@Req() r: AuthedRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.svc.transition(r.user!, id, body, r.ip);
  }

  @Post(':id/photos')
  @RequirePerm('incident.view')
  async upload(@Req() r: AuthedRequest, @Param('id') id: string, @Query('kind') kind = 'report') {
    const req = r as unknown as { isMultipart?: () => boolean; file: () => Promise<{ toBuffer: () => Promise<Buffer>; file: { truncated: boolean } } | undefined> };
    if (!req.isMultipart?.()) throw new ApiError(415, 'unsupported_media', 'Gửi ảnh dạng multipart/form-data, trường "file"');
    const part = await req.file();
    if (!part) throw new ApiError(422, 'file_missing', 'Thiếu file ảnh');
    const buf = await part.toBuffer().catch(() => {
      throw new ApiError(413, 'file_too_large', `Ảnh tối đa ${MAX_PHOTO_BYTES / 1024 / 1024} MB`, { mb: MAX_PHOTO_BYTES / 1024 / 1024 });
    });
    if (part.file.truncated) throw new ApiError(413, 'file_too_large', `Ảnh tối đa ${MAX_PHOTO_BYTES / 1024 / 1024} MB`, { mb: MAX_PHOTO_BYTES / 1024 / 1024 });
    return this.svc.addPhoto(r.user!, id, kind, buf, r.ip);
  }

  @Get(':id/photos/:photoId')
  @RequirePerm('incident.view')
  async photo(@Req() r: AuthedRequest, @Param('id') id: string, @Param('photoId') photoId: string, @Res() reply: FastifyReply) {
    const f = await this.svc.photoFile(r.user!, id, photoId);
    reply.header('content-type', f.mime).header('content-length', String(f.size)).header('cache-control', 'private, max-age=3600')
      .header('x-content-type-options', 'nosniff').header('content-security-policy', "default-src 'none'");
    return reply.send(createReadStream(f.full));
  }

  @Delete(':id/photos/:photoId')
  @HttpCode(204)
  @RequirePerm('incident.manage')
  async deletePhoto(@Req() r: AuthedRequest, @Param('id') id: string, @Param('photoId') photoId: string) {
    await this.svc.deletePhoto(r.user!, id, photoId, r.ip);
  }
}

@Module({ imports: [CabinetsModule], controllers: [IncidentsController], providers: [IncidentsService] })
export class IncidentsModule {}
