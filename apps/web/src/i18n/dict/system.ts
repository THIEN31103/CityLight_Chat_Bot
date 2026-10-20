// System monitoring page and the 403 / 404 pages.
import { defineDict, plural } from '@citylight/shared';

export const SYSTEM = defineDict(
  {
    title: 'Giám sát hệ thống',
    subtitle: 'Số liệu vận hành của server (mock ở M1-UI; thật từ /metrics ở M1)',
    cabinetsOnline: 'Tủ online',
    brokerConnections: 'Kết nối broker',
    telemetry: 'Telemetry',
    ingestLag: 'Độ trễ ingest',
    commandQueue: 'Hàng đợi lệnh',
    commandErrors: 'Lệnh lỗi / timeout',
    dbSize: 'Dung lượng DB',
    uptime: 'Uptime',
    hours: (n: number) => `${n} giờ`,
  },
  {
    title: 'System monitoring',
    subtitle: 'Server operating figures (mock in M1-UI; real from /metrics in M1)',
    cabinetsOnline: 'Cabinets online',
    brokerConnections: 'Broker connections',
    telemetry: 'Telemetry',
    ingestLag: 'Ingest lag',
    commandQueue: 'Command queue',
    commandErrors: 'Failed / timed-out commands',
    dbSize: 'Database size',
    uptime: 'Uptime',
    hours: (n: number) => plural(n, 'hour', 'hours'),
  },
);

export const ERROR_PAGES = defineDict(
  {
    forbiddenTitle: '403 — Không đủ quyền',
    forbiddenBody: 'Tài khoản của bạn không có quyền truy cập trang này. Liên hệ quản trị viên nếu bạn cần quyền.',
    notFoundTitle: '404 — Không tìm thấy trang',
    home: 'Về trang chính',
  },
  {
    forbiddenTitle: '403 — Access denied',
    forbiddenBody: 'Your account cannot open this page. Contact an administrator if you need access.',
    notFoundTitle: '404 — Page not found',
    home: 'Go to home',
  },
);
