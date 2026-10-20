// Excel export (M7): one sheet, header row, frozen + filtered, times shown in Asia/Ho_Chi_Minh.
// S49: sheet names, column headers and enum values in the requesting user's language (data stays as stored).
import ExcelJS from 'exceljs';
import type { FastifyReply } from 'fastify';
import { defineDict } from '@citylight/shared';

export const EXPORT_MAX_ROWS = 50_000;

/** Fixed texts of the Excel files (alarms / incidents exports, pole import template). */
export const XLSX_TEXT = defineDict(
  {
    yes: 'Có',
    alarms: {
      file: 'canh-bao', sheet: 'Cảnh báo', code: 'Mã lỗi', type: 'Loại', severity: 'Mức độ', cabinet: 'Tủ', district: 'Quận/huyện', message: 'Nội dung',
      start: 'Bắt đầu', end: 'Kết thúc', active: 'Đang mở', ackedBy: 'Người xác nhận', ackedAt: 'Lúc xác nhận',
    },
    incidents: {
      file: 'su-co', sheet: 'Sự cố', code: 'Mã', cabinet: 'Tủ điều khiển', district: 'Quận/huyện', ward: 'Phường/xã', reportedAt: 'Thời điểm ghi nhận',
      reportedBy: 'Người báo', source: 'Nguồn', fromAlarm: 'Cảnh báo', manual: 'Thủ công', category: 'Phân loại', content: 'Nội dung', status: 'Trạng thái',
      assignee: 'Người xử lý', deadline: 'Hạn xử lý', overdue: 'Quá hạn', resolvedAt: 'Thời điểm xử lý', resolution: 'Nội dung xử lý',
    },
    poleTemplate: {
      file: 'mau-nhap-tru', sheet: 'Trụ đèn', notesSheet: 'Hướng dẫn', branch1: 'N1', branch2: 'N2',
      notes: [
        'Mỗi dòng là một trụ. Mã tủ phải là tủ đã đăng ký và nằm trong khu vực của bạn.',
        'Nhánh: 1, 2, N1 hoặc N2. Thứ tự trụ: 1 = gần tủ nhất; tuyến được vẽ nối tủ → trụ theo thứ tự.',
        'Vĩ độ / kinh độ: WGS84 (Google Maps), dấu chấm hoặc dấu phẩy thập phân.',
        'Số đèn mặc định 1; Nhóm đèn 0 = đèn chính, 1 = giao lộ, 2 = trên cầu, 3 = mở rộng.',
        'Nhập lại cùng tủ + nhánh sẽ THAY toàn bộ trụ của tuyến đó bằng dữ liệu trong file.',
      ].join('\n'),
    },
  },
  {
    yes: 'Yes',
    alarms: {
      file: 'alarms', sheet: 'Alarms', code: 'Error code', type: 'Type', severity: 'Severity', cabinet: 'Cabinet', district: 'District', message: 'Message',
      start: 'Started', end: 'Ended', active: 'Active', ackedBy: 'Acknowledged by', ackedAt: 'Acknowledged at',
    },
    incidents: {
      file: 'incidents', sheet: 'Incidents', code: 'Code', cabinet: 'Cabinet', district: 'District', ward: 'Ward', reportedAt: 'Reported at',
      reportedBy: 'Reported by', source: 'Source', fromAlarm: 'Alarm', manual: 'Manual', category: 'Category', content: 'Description', status: 'Status',
      assignee: 'Assignee', deadline: 'Deadline', overdue: 'Overdue', resolvedAt: 'Resolved at', resolution: 'Resolution',
    },
    poleTemplate: {
      file: 'pole-import-template', sheet: 'Poles', notesSheet: 'Instructions', branch1: 'B1', branch2: 'B2',
      notes: [
        'One row per pole. The cabinet code must be a registered cabinet in your areas.',
        'Branch: 1, 2, B1 or B2 (N1 / N2 also work). Pole no.: 1 = closest to the cabinet; the route is drawn cabinet → poles in that order.',
        'Latitude / longitude: WGS84 (Google Maps), decimal point or decimal comma.',
        'Lamps default to 1; lamp group 0 = main, 1 = intersection, 2 = bridge, 3 = extension.',
        'Importing the same cabinet + branch again REPLACES every pole of that route with the rows in the file.',
        'Vietnamese column headers are accepted too.',
      ].join('\n'),
    },
  },
);

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
