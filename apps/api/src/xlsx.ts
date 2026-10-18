// Excel export (M7): one sheet, header row, frozen + filtered, times shown in Asia/Ho_Chi_Minh.
import ExcelJS from 'exceljs';
import type { FastifyReply } from 'fastify';

export const EXPORT_MAX_ROWS = 50_000;

export interface XlsxColumn<T> {
  header: string;
  width?: number;
  value: (row: T) => string | number | Date | null | undefined;
  /** Excel number format, e.g. a date column */
  numFmt?: string;
}

/** Excel has no time zones: shift UTC instants to Hồ Chí Minh wall time so the sheet shows local time. */
export const vnTime = (iso: string | Date | null | undefined) => (iso ? new Date(new Date(iso).getTime() + 7 * 3600_000) : null);
export const DATE_TIME = 'dd/mm/yyyy hh:mm';

export async function sendXlsx<T>(reply: FastifyReply, filename: string, sheet: string, columns: XlsxColumn<T>[], rows: T[]) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CityLight';
  wb.created = new Date();
  const ws = wb.addWorksheet(sheet, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map((c, i) => ({ header: c.header, key: `c${i}`, width: c.width ?? 16, style: c.numFmt ? { numFmt: c.numFmt } : {} }));
  ws.getRow(1).font = { bold: true };
  for (const r of rows) ws.addRow(Object.fromEntries(columns.map((c, i) => [`c${i}`, c.value(r) ?? null])));
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  const buf = await wb.xlsx.writeBuffer();
  reply
    .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    .header('content-disposition', `attachment; filename="${filename.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`)
    .header('cache-control', 'no-store');
  return Buffer.from(buf);
}
