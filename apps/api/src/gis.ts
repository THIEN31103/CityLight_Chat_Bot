// GIS assets (spec S2/S4/S5, M8): routes / poles / lamps on the map, pole detail, the map editor's
// batched save (one transaction, optimistic locks), pole generation along a route, Excel/CSV import.
import { Body, Controller, Get, HttpCode, Inject, Injectable, Module, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import ExcelJS from 'exceljs';
import type { PendingQuery, Row as PgRow, TransactionSql } from 'postgres';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { IMPORT_COLUMNS_I18N, inRegion, parseImportRows, poleCode, pointsAlong, routeCode, type ImportPole, type Lang, type LngLat } from '@citylight/shared';
import { CONFIG_CHANNEL } from '@citylight/db/notify';
import { RequirePerm, type AuthedRequest, type SessionUser } from './auth';
import { CabinetsModule, CabinetsService } from './cabinets';
import { ApiError } from './errors';
import { REGION, assertInRegion } from './region';
import { XLSX_TEXT } from './xlsx';
import { REDIS, SQL, type Sql } from './infra';
import { inScope, scopeWhere } from './scope';

const MAX_ASSETS = 5000;
const ROUTES_MIN_ZOOM = 13;
const POLES_MIN_ZOOM = 15;
const MAX_IMPORT_ROWS = 100_000;

const uuid = z.string().uuid();
const Lat = z.number().min(-90).max(90);
const Lng = z.number().min(-180).max(180);
const Path = z.array(z.tuple([Lng, Lat])).min(2).max(2000);
const Stamp = z.string().datetime({ offset: true }).optional();

const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('moveCabinet'), cabinetId: uuid, lat: Lat, lng: Lng, expectedUpdatedAt: Stamp }),
  z.object({ op: z.literal('upsertRoute'), cabinetId: uuid, branch: z.union([z.literal(1), z.literal(2)]), path: Path, expectedUpdatedAt: Stamp }),
  z.object({ op: z.literal('deleteRoute'), routeId: uuid, expectedUpdatedAt: Stamp }),
  z.object({
    op: z.literal('addPole'), cabinetId: uuid, branch: z.union([z.literal(1), z.literal(2)]), lat: Lat, lng: Lng,
    seq: z.number().int().min(1).optional(), lampCount: z.number().int().min(0).max(20).default(1),
    ratedPowerW: z.number().int().min(0).max(2000).nullable().default(null), lampGroup: z.number().int().min(0).max(3).default(0),
  }),
  z.object({ op: z.literal('movePole'), poleId: uuid, lat: Lat, lng: Lng, expectedUpdatedAt: Stamp }),
  z.object({ op: z.literal('deletePole'), poleId: uuid, expectedUpdatedAt: Stamp }),
  z.object({
    op: z.literal('setPoleLamps'), poleId: uuid, lampCount: z.number().int().min(0).max(20),
    ratedPowerW: z.number().int().min(0).max(2000).nullable(), lampGroup: z.number().int().min(0).max(3),
  }),
]);
type EditOp = z.infer<typeof Op>;
const EditsBody = z.union([
  z.object({ ops: z.array(Op).min(1).max(5000) }),
  // M1-UI shape: cabinet moves only
  z.object({ moves: z.array(z.object({ cabinetId: uuid, lat: Lat, lng: Lng })).min(1).max(5000) }),
]);

type Tx = TransactionSql;

export interface PoleAsset {
  id: string; code: string; routeId: string; routeCode: string; cabinetId: string; cabinetName: string; branch: 'N1' | 'N2';
  seq: number; location: { lat: number; lng: number }; lampCount: number; updatedAt: string;
}

@Injectable()
export class GisService {
  constructor(
    @Inject(SQL) private readonly sql: Sql,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CabinetsService) private readonly cabinets: CabinetsService,
  ) {}

  // ---------------- read ----------------

  async assets(u: SessionUser, q: { bbox?: string; zoom?: string; layers?: string }) {
    const b = (q.bbox ?? '').split(',').map(Number);
    if (b.length !== 4 || b.some((x) => !Number.isFinite(x))) throw new ApiError(422, 'invalid_request', 'bbox = west,south,east,north');
    const [w, s, e, n] = b as [number, number, number, number];
    const zoom = q.zoom === undefined ? POLES_MIN_ZOOM : Number(q.zoom);
    const layers = new Set((q.layers ?? 'poles').split(','));
    const env = this.sql`ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326)`;
    const out: { routes: unknown[]; poles: PoleAsset[]; truncated: boolean } = { routes: [], poles: [], truncated: false };
    if (layers.has('routes') && zoom >= ROUTES_MIN_ZOOM) {
      const rows = await this.sql<{ id: string; cabinet_id: string; code: string; branch: number; geojson: string; updated_at: Date }[]>`
        SELECT r.id, r.cabinet_id, r.code, r.branch, ST_AsGeoJSON(r.path, 6) AS geojson, r.updated_at
        FROM routes r JOIN cabinets c ON c.id = r.cabinet_id
        WHERE r.path && ${env} AND ${scopeWhere(this.sql, u.scope)} LIMIT ${MAX_ASSETS + 1}`;
      out.truncated ||= rows.length > MAX_ASSETS;
      out.routes = rows.slice(0, MAX_ASSETS).map((r) => ({
        id: r.id, cabinetId: r.cabinet_id, code: r.code, branch: `N${r.branch}`, path: (JSON.parse(r.geojson) as { coordinates: LngLat[] }).coordinates,
        updatedAt: r.updated_at.toISOString(),
      }));
    }
    if (layers.has('poles') && zoom >= POLES_MIN_ZOOM) {
      const rows = await this.poleRows(this.sql`p.location && ${env} AND ${scopeWhere(this.sql, u.scope)}`, MAX_ASSETS + 1);
      out.truncated ||= rows.length > MAX_ASSETS;
      out.poles = rows.slice(0, MAX_ASSETS);
    }
    return out;
  }

  private async poleRows(where: PendingQuery<PgRow[]>, limit: number): Promise<PoleAsset[]> {
    const rows = await this.sql<{ id: string; code: string; route_id: string; route_code: string; cabinet_id: string; cabinet_name: string; branch: number; seq: number; lat: number; lng: number; lamp_count: number; updated_at: Date }[]>`
      SELECT p.id, p.code, p.route_id, r.code AS route_code, c.id AS cabinet_id, c.code || ' - ' || c.name AS cabinet_name, r.branch, p.seq,
             ST_Y(p.location) AS lat, ST_X(p.location) AS lng, p.lamp_count, p.updated_at
      FROM poles p JOIN routes r ON r.id = p.route_id JOIN cabinets c ON c.id = r.cabinet_id
      WHERE ${where} ORDER BY r.code, p.seq LIMIT ${limit}`;
    return rows.map((r) => ({
      id: r.id, code: r.code, routeId: r.route_id, routeCode: r.route_code, cabinetId: r.cabinet_id, cabinetName: r.cabinet_name,
      branch: `N${r.branch}` as 'N1' | 'N2', seq: r.seq, location: { lat: Number(r.lat), lng: Number(r.lng) }, lampCount: r.lamp_count, updatedAt: r.updated_at.toISOString(),
    }));
  }

  async pole(u: SessionUser, id: string) {
    const p = (await this.poleRows(this.sql`p.id = ${uuid.parse(id)}`, 1))[0];
    if (!p) throw new ApiError(404, 'not_found', 'Không tìm thấy trụ');
    await this.cabinets.assertCabinet(u.scope, p.cabinetId);
    const lamps = await this.sql`
      SELECT id, code, lamp_group AS "lampGroup", rated_power_w AS "ratedPowerW", is_smart AS "isSmart" FROM lamps WHERE pole_id = ${p.id} ORDER BY code`;
    return { ...p, lamps };
  }

  async cabinetLamps(u: SessionUser, cabinetId: string) {
    const cid = await this.cabinets.assertCabinet(u.scope, cabinetId);
    const rows = await this.sql<{ id: string; code: string; pole_code: string; route_code: string; branch: number; lamp_group: number; rated_power_w: number | null; is_smart: boolean; lat: number; lng: number }[]>`
      SELECT l.id, l.code, p.code AS pole_code, r.code AS route_code, r.branch, l.lamp_group, l.rated_power_w, l.is_smart, ST_Y(p.location) AS lat, ST_X(p.location) AS lng
      FROM lamps l JOIN poles p ON p.id = l.pole_id JOIN routes r ON r.id = p.route_id WHERE r.cabinet_id = ${cid}
      ORDER BY r.branch, p.seq, l.code LIMIT 5000`;
    return rows.map((r) => ({
      id: r.id, code: r.code, poleCode: r.pole_code, routeCode: r.route_code, branch: `N${r.branch}`, lampGroup: r.lamp_group,
      ratedPowerW: r.rated_power_w ?? 0, isSmart: r.is_smart, location: { lat: Number(r.lat), lng: Number(r.lng) },
    }));
  }

  // ---------------- write ----------------

  private log(u: SessionUser, action: string, type: string, id: string | null, name: string, value: string, ip?: string) {
    return this.sql`INSERT INTO activity_logs (user_id, user_email, action, target_type, target_id, target_name, new_value, ip)
                    VALUES (${u.id}, ${u.email}, ${action}, ${type}, ${id}, ${name}, ${value}, ${ip ?? null})`;
  }

  /** Cabinet of an op, scope-checked: (cabinetId | routeId | poleId) -> {id, code}. */
  private async cabinetOf(tx: Tx, u: SessionUser, op: EditOp, i: number): Promise<{ id: string; code: string }> {
    const row = 'cabinetId' in op
      ? (await tx<{ id: string; code: string; district_id: string | null; ward_id: string | null; active: boolean }[]>`SELECT id, code, district_id, ward_id, active FROM cabinets WHERE id = ${op.cabinetId}`)[0]
      : 'routeId' in op
        ? (await tx<{ id: string; code: string; district_id: string | null; ward_id: string | null; active: boolean }[]>`
            SELECT c.id, c.code, c.district_id, c.ward_id, c.active FROM routes r JOIN cabinets c ON c.id = r.cabinet_id WHERE r.id = ${op.routeId}`)[0]
        : (await tx<{ id: string; code: string; district_id: string | null; ward_id: string | null; active: boolean }[]>`
            SELECT c.id, c.code, c.district_id, c.ward_id, c.active FROM poles p JOIN routes r ON r.id = p.route_id JOIN cabinets c ON c.id = r.cabinet_id
            WHERE p.id = ${(op as { poleId: string }).poleId}`)[0];
    if (!row) throw new ApiError(404, 'op_target_not_found', `Thao tác ${i + 1}: không tìm thấy đối tượng`, { op: i + 1 });
    if (!row.active || !inScope(u.scope, row.district_id, row.ward_id)) throw new ApiError(403, 'op_out_of_scope', `Thao tác ${i + 1}: tủ ${row.code} ngoài khu vực của bạn`, { op: i + 1, code: row.code });
    return { id: row.id, code: row.code };
  }

  /** Someone saved the same object since the editor loaded it: refuse instead of overwriting. */
  private stale(i: number, expected: string | undefined, actual: Date | undefined, what: string) {
    if (expected && actual && Math.abs(actual.getTime() - Date.parse(expected)) > 1)
      throw new ApiError(409, 'edit_conflict', `Thao tác ${i + 1}: ${what} vừa được người khác sửa, tải lại bản đồ rồi làm lại`, { op: i + 1, what });
  }

  /** Every op of the draft in one transaction: all saved or nothing. */
  async saveEdits(u: SessionUser, body: unknown, ip?: string) {
    const b = EditsBody.parse(body);
    const ops: EditOp[] = 'ops' in b ? b.ops : b.moves.map((m) => ({ op: 'moveCabinet' as const, ...m }));
    const counts: Record<string, number> = {};
    let movedCabinets = false;
    await this.sql.begin(async (tx) => {
      for (const [i, op] of ops.entries()) {
        const cab = await this.cabinetOf(tx, u, op, i);
        counts[op.op] = (counts[op.op] ?? 0) + 1;
        // S62: every position this op writes must lie in the service region
        if ('lat' in op && 'lng' in op) assertInRegion({ lat: op.lat, lng: op.lng });
        if (op.op === 'upsertRoute') for (const [lng, lat] of op.path) assertInRegion({ lat, lng });
        switch (op.op) {
          case 'moveCabinet': {
            const cur = (await tx<{ updated_at: Date }[]>`SELECT updated_at FROM cabinets WHERE id = ${op.cabinetId} FOR UPDATE`)[0];
            this.stale(i, op.expectedUpdatedAt, cur?.updated_at, `tủ ${cab.code}`);
            await tx`UPDATE cabinets SET location = ST_SetSRID(ST_MakePoint(${op.lng}, ${op.lat}), 4326), updated_at = now() WHERE id = ${op.cabinetId}`;
            movedCabinets = true;
            break;
          }
          case 'upsertRoute': {
            const cur = (await tx<{ updated_at: Date }[]>`SELECT updated_at FROM routes WHERE cabinet_id = ${op.cabinetId} AND branch = ${op.branch} FOR UPDATE`)[0];
            this.stale(i, op.expectedUpdatedAt, cur?.updated_at, `tuyến ${routeCode(cab.code, op.branch)}`);
            const wkt = `LINESTRING(${op.path.map(([x, y]) => `${x} ${y}`).join(',')})`;
            await tx`
              INSERT INTO routes (cabinet_id, code, branch, path) VALUES (${op.cabinetId}, ${routeCode(cab.code, op.branch)}, ${op.branch}, ST_GeomFromText(${wkt}, 4326))
              ON CONFLICT (cabinet_id, branch) DO UPDATE SET path = excluded.path, updated_at = now()`;
            break;
          }
          case 'deleteRoute': {
            const cur = (await tx<{ updated_at: Date }[]>`SELECT updated_at FROM routes WHERE id = ${op.routeId} FOR UPDATE`)[0];
            this.stale(i, op.expectedUpdatedAt, cur?.updated_at, 'tuyến');
            await tx`DELETE FROM routes WHERE id = ${op.routeId}`; // poles + lamps cascade
            break;
          }
          case 'addPole': {
            const route = (await tx<{ id: string }[]>`SELECT id FROM routes WHERE cabinet_id = ${op.cabinetId} AND branch = ${op.branch} FOR UPDATE`)[0];
            if (!route) throw new ApiError(422, 'op_route_missing', `Thao tác ${i + 1}: tủ ${cab.code} chưa có tuyến N${op.branch}, vẽ tuyến trước`, {
                op: i + 1,
                code: cab.code,
                branch: op.branch,
              });
            const seq = op.seq ?? ((await tx<{ m: number }[]>`SELECT coalesce(max(seq), 0)::int AS m FROM poles WHERE route_id = ${route.id}`)[0]!.m + 1);
            const code = poleCode(cab.code, op.branch, seq);
            const p = (await tx<{ id: string }[]>`
              INSERT INTO poles (route_id, code, location, lamp_count, seq) VALUES (${route.id}, ${code}, ST_SetSRID(ST_MakePoint(${op.lng}, ${op.lat}), 4326), ${op.lampCount}, ${seq})
              ON CONFLICT (code) DO NOTHING RETURNING id`)[0];
            if (!p) throw new ApiError(409, 'pole_code_taken', `Thao tác ${i + 1}: trụ ${code} đã tồn tại`, { op: i + 1, code });
            await this.writeLamps(tx, p.id, code, op.lampCount, op.ratedPowerW, op.lampGroup);
            break;
          }
          case 'movePole': {
            const cur = (await tx<{ updated_at: Date }[]>`SELECT updated_at FROM poles WHERE id = ${op.poleId} FOR UPDATE`)[0];
            this.stale(i, op.expectedUpdatedAt, cur?.updated_at, 'trụ');
            await tx`UPDATE poles SET location = ST_SetSRID(ST_MakePoint(${op.lng}, ${op.lat}), 4326), updated_at = now() WHERE id = ${op.poleId}`;
            break;
          }
          case 'deletePole': {
            const cur = (await tx<{ updated_at: Date }[]>`SELECT updated_at FROM poles WHERE id = ${op.poleId} FOR UPDATE`)[0];
            this.stale(i, op.expectedUpdatedAt, cur?.updated_at, 'trụ');
            await tx`DELETE FROM poles WHERE id = ${op.poleId}`;
            break;
          }
          case 'setPoleLamps': {
            const p = (await tx<{ code: string }[]>`UPDATE poles SET lamp_count = ${op.lampCount}, updated_at = now() WHERE id = ${op.poleId} RETURNING code`)[0]!;
            await tx`DELETE FROM lamps WHERE pole_id = ${op.poleId}`;
            await this.writeLamps(tx, op.poleId, p.code, op.lampCount, op.ratedPowerW, op.lampGroup);
            break;
          }
        }
      }
    });
    const summary = Object.entries(counts).map(([k, v]) => `${k} ×${v}`).join(', ');
    await this.log(u, 'Chỉnh sửa bản đồ', 'map', null, `${ops.length} thao tác`, summary, ip);
    // the ingest worker compares GPS with the registered position (gps_drift): reload it
    if (movedCabinets) {
      this.cabinets.invalidateMap();
      await this.redis.publish(CONFIG_CHANNEL, JSON.stringify({ type: 'registry' })).catch(() => undefined);
    }
    return { saved: ops.length, counts };
  }

  private async writeLamps(tx: Tx, poleId: string, code: string, n: number, power: number | null, group: number) {
    if (!n) return;
    const rows = Array.from({ length: n }, (_, k) => ({ pole_id: poleId, code: `${code}_D${k + 1}`, lamp_group: group, rated_power_w: power }));
    await tx`INSERT INTO lamps ${tx(rows)}`;
  }

  /** Poles every `spacingM` metres along a route (replaces its poles); codes 1..n from the cabinet. */
  async generatePoles(u: SessionUser, routeId: string, body: unknown, ip?: string) {
    const b = z.object({
      spacingM: z.number().min(5).max(200), lampCount: z.number().int().min(0).max(20).default(1),
      ratedPowerW: z.number().int().min(0).max(2000).nullable().default(null), lampGroup: z.number().int().min(0).max(3).default(0),
    }).parse(body);
    const rid = uuid.parse(routeId);
    let made = 0;
    let code = '';
    await this.sql.begin(async (tx) => {
      const cab = await this.cabinetOf(tx, u, { op: 'deleteRoute', routeId: rid }, 0);
      const r = (await tx<{ branch: 1 | 2; geojson: string }[]>`SELECT branch, ST_AsGeoJSON(path) AS geojson FROM routes WHERE id = ${rid} FOR UPDATE`)[0]!;
      const pts = pointsAlong((JSON.parse(r.geojson) as { coordinates: LngLat[] }).coordinates, b.spacingM);
      if (pts.length > 2000) throw new ApiError(422, 'too_many_poles', `Sinh ${pts.length} trụ là quá nhiều, tăng khoảng cách`, { count: pts.length });
      await tx`DELETE FROM poles WHERE route_id = ${rid}`;
      code = routeCode(cab.code, r.branch);
      for (const [k, [lng, lat]] of pts.entries()) {
        const pc = poleCode(cab.code, r.branch, k + 1);
        const p = (await tx<{ id: string }[]>`
          INSERT INTO poles (route_id, code, location, lamp_count, seq) VALUES (${rid}, ${pc}, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326), ${b.lampCount}, ${k + 1}) RETURNING id`)[0]!;
        await this.writeLamps(tx, p.id, pc, b.lampCount, b.ratedPowerW, b.lampGroup);
      }
      made = pts.length;
    });
    await this.log(u, 'Sinh trụ hàng loạt', 'route', rid, code, `${made} trụ, cách ${b.spacingM} m`, ip);
    return { poles: made };
  }

  // ---------------- import ----------------

  /** Import template in the user's language (S49); the import accepts both header sets. */
  async template(reply: FastifyReply, lang: Lang = 'vi') {
    const T = XLSX_TEXT[lang].poleTemplate;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(T.sheet);
    ws.columns = IMPORT_COLUMNS_I18N[lang].map((h) => ({ header: h, width: Math.max(12, h.length + 4) }));
    ws.getRow(1).font = { bold: true };
    ws.addRow(['TL01.0001', T.branch1, 1, 10.776901, 106.700981, 1, 150, 0, '']);
    ws.addRow(['TL01.0001', T.branch1, 2, 10.777150, 106.701200, 2, 150, 0, 'T-OLD-12']);
    ws.addRow(['TL01.0001', T.branch2, 1, 10.776700, 106.700700, 1, 100, 1, '']);
    const note = wb.addWorksheet(T.notesSheet);
    for (const line of T.notes.split('\n')) note.addRow([line]);
    note.getColumn(1).width = 110;
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', `attachment; filename="${T.file}.xlsx"`);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  /** Rows from an .xlsx (first sheet) or a .csv (comma or semicolon). */
  private async readRows(buf: Buffer): Promise<Record<string, unknown>[]> {
    const isZip = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b; // xlsx = zip
    if (isZip) {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf as unknown as ArrayBuffer);
      const ws = wb.worksheets[0];
      if (!ws) return [];
      const header = (ws.getRow(1).values as unknown[]).slice(1).map((v) => String(v ?? ''));
      const out: Record<string, unknown>[] = [];
      ws.eachRow((row, n) => {
        if (n === 1) return;
        const vals = (row.values as unknown[]).slice(1);
        out[n - 2] = Object.fromEntries(header.map((h, k) => {
          const v = vals[k] as unknown;
          return [h, v && typeof v === 'object' && 'result' in (v as object) ? (v as { result: unknown }).result : v];
        }));
      });
      return Array.from(out, (r) => r ?? {});
    }
    const text = buf.toString('utf8').replace(/^﻿/, '');
    const lines = text.split(/\r?\n/).filter((l, k, a) => l.trim() || k < a.length - 1);
    const sep = (lines[0] ?? '').split(';').length > (lines[0] ?? '').split(',').length ? ';' : ',';
    const split = (l: string) => {
      const cells: string[] = [];
      let cur = '';
      let q = false;
      for (let k = 0; k < l.length; k++) {
        const ch = l[k]!;
        if (q) {
          if (ch === '"' && l[k + 1] === '"') { cur += '"'; k++; } else if (ch === '"') q = false; else cur += ch;
        } else if (ch === '"') q = true;
        else if (ch === sep) { cells.push(cur); cur = ''; } else cur += ch;
      }
      cells.push(cur);
      return cells;
    };
    const header = split(lines[0] ?? '');
    return lines.slice(1).map((l) => Object.fromEntries(split(l).map((v, k) => [header[k] ?? `c${k}`, v])));
  }

  async importPoles(u: SessionUser, file: Buffer, dryRun: boolean, ip?: string) {
    const rows = await this.readRows(file);
    if (rows.length > MAX_IMPORT_ROWS) throw new ApiError(413, 'too_many_rows', `Tối đa ${MAX_IMPORT_ROWS} dòng mỗi lần nhập`, { max: MAX_IMPORT_ROWS });
    const { poles, errors } = parseImportRows(rows, u.lang);
    const codes = [...new Set(poles.map((p) => p.cabinetCode))];
    const cabs = await this.sql<{ id: string; code: string; lat: number; lng: number; district_id: string | null; ward_id: string | null; active: boolean }[]>`
      SELECT id, code, ST_Y(location) AS lat, ST_X(location) AS lng, district_id, ward_id, active FROM cabinets WHERE code = ANY(${codes})`;
    const byCode = new Map(cabs.map((c) => [c.code, c]));
    const ok: ImportPole[] = [];
    for (const p of poles) {
      const c = byCode.get(p.cabinetCode);
      if (!c || !c.active) errors.push({ row: p.row, message: `Không có tủ ${p.cabinetCode}` });
      else if (!inScope(u.scope, c.district_id, c.ward_id)) errors.push({ row: p.row, message: `Tủ ${p.cabinetCode} ngoài khu vực của bạn` });
      else if (REGION && !inRegion(REGION, p)) errors.push({ row: p.row, message: `Trụ ${p.lat}, ${p.lng} ngoài phạm vi hoạt động (${REGION.name})` });
      else ok.push(p);
    }
    errors.sort((a, b) => a.row - b.row);
    const groups = new Map<string, ImportPole[]>();
    for (const p of ok) {
      const k = `${p.cabinetCode}|${p.branch}`;
      groups.set(k, [...(groups.get(k) ?? []), p]);
    }
    const summary = {
      rows: rows.length, poles: ok.length, lamps: ok.reduce((s, p) => s + p.lampCount, 0), routes: groups.size,
      cabinets: new Set(ok.map((p) => p.cabinetCode)).size, errors: errors.slice(0, 500), errorCount: errors.length, dryRun,
    };
    // all or nothing: a file with errors is not written (fix the rows, import again)
    if (dryRun || errors.length || !ok.length) return summary;
    await this.sql.begin(async (tx) => {
      for (const [k, list] of groups) {
        const [code, branch] = k.split('|') as [string, string];
        const c = byCode.get(code)!;
        list.sort((a, b) => a.seq - b.seq);
        // route: cabinet -> poles in order
        const wkt = `LINESTRING(${[[c.lng, c.lat], ...list.map((p) => [p.lng, p.lat])].map(([x, y]) => `${x} ${y}`).join(',')})`;
        const r = (await tx<{ id: string }[]>`
          INSERT INTO routes (cabinet_id, code, branch, path) VALUES (${c.id}, ${routeCode(code, Number(branch) as 1 | 2)}, ${Number(branch)}, ST_GeomFromText(${wkt}, 4326))
          ON CONFLICT (cabinet_id, branch) DO UPDATE SET path = excluded.path, updated_at = now() RETURNING id`)[0]!;
        await tx`DELETE FROM poles WHERE route_id = ${r.id}`;
        const prow = list.map((p) => ({
          route_id: r.id, code: poleCode(code, p.branch, p.seq), legacy_code: p.legacyCode, location: `SRID=4326;POINT(${p.lng} ${p.lat})`, lamp_count: p.lampCount, seq: p.seq,
        }));
        const ids = await tx<{ id: string; code: string }[]>`INSERT INTO poles ${tx(prow)} RETURNING id, code`;
        const pid = new Map(ids.map((x) => [x.code, x.id]));
        const lrows = list.flatMap((p) => {
          const pc = poleCode(code, p.branch, p.seq);
          return Array.from({ length: p.lampCount }, (_, n) => ({ pole_id: pid.get(pc)!, code: `${pc}_D${n + 1}`, lamp_group: p.lampGroup, rated_power_w: p.ratedPowerW }));
        });
        for (let n = 0; n < lrows.length; n += 5000) await tx`INSERT INTO lamps ${tx(lrows.slice(n, n + 5000))}`;
      }
    });
    await this.log(u, 'Nhập dữ liệu trụ', 'gis', null, `${summary.cabinets} tủ`, `${summary.routes} tuyến, ${summary.poles} trụ, ${summary.lamps} đèn`, ip);
    return summary;
  }
}

async function fileOf(r: AuthedRequest, max: number): Promise<Buffer> {
  const req = r as unknown as { isMultipart?: () => boolean; file: (o?: object) => Promise<{ toBuffer: () => Promise<Buffer>; file: { truncated: boolean } } | undefined> };
  if (!req.isMultipart?.()) throw new ApiError(415, 'unsupported_media', 'Gửi file dạng multipart/form-data, trường "file"');
  const part = await req.file({ limits: { fileSize: max } });
  if (!part) throw new ApiError(422, 'file_missing', 'Thiếu file');
  const buf = await part.toBuffer().catch(() => {
    throw new ApiError(413, 'file_too_large', `File tối đa ${max / 1024 / 1024} MB`, { mb: max / 1024 / 1024 });
  });
  if (part.file.truncated) throw new ApiError(413, 'file_too_large', `File tối đa ${max / 1024 / 1024} MB`, { mb: max / 1024 / 1024 });
  return buf;
}

@Controller()
export class GisController {
  constructor(@Inject(GisService) private readonly svc: GisService) {}

  @Get('map/assets')
  @RequirePerm('map.view')
  assets(@Req() r: AuthedRequest, @Query() q: { bbox?: string; zoom?: string; layers?: string }) {
    return this.svc.assets(r.user!, q);
  }

  @Get('poles/:id')
  @RequirePerm('map.view')
  pole(@Req() r: AuthedRequest, @Param('id') id: string) {
    return this.svc.pole(r.user!, id);
  }

  @Get('cabinets/:id/lamps')
  @RequirePerm('map.view')
  lamps(@Req() r: AuthedRequest, @Param('id') id: string) {
    return this.svc.cabinetLamps(r.user!, id);
  }

  @Post('map/edits')
  @HttpCode(200)
  @RequirePerm('map.edit')
  edits(@Req() r: AuthedRequest, @Body() body: unknown) {
    return this.svc.saveEdits(r.user!, body, r.ip);
  }

  @Post('routes/:id/generate-poles')
  @HttpCode(200)
  @RequirePerm('map.edit')
  generate(@Req() r: AuthedRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.svc.generatePoles(r.user!, id, body, r.ip);
  }

  @Get('gis/import/template.xlsx')
  @RequirePerm('map.edit')
  template(@Req() r: AuthedRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.svc.template(reply, r.user!.lang);
  }

  /** ?dryRun=true checks the file and reports row errors without writing (default). */
  @Post('gis/import')
  @HttpCode(200)
  @RequirePerm('map.edit')
  async import(@Req() r: AuthedRequest, @Query('dryRun') dryRun = 'true') {
    return this.svc.importPoles(r.user!, await fileOf(r, 10 * 1024 * 1024), dryRun !== 'false', r.ip);
  }
}

@Module({ imports: [CabinetsModule], controllers: [GisController], providers: [GisService] })
export class GisModule {}
