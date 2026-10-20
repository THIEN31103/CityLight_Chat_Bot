// Text of one notification message (Telegram plain text): a few alarms one by one, a burst as a summary.
import {
  ALARM_TYPE_LABELS, SECURITY_KIND_LABELS, SECURITY_SELF_KINDS, directionsUrl, shortUserAgent,
  type AlarmSeverity, type AlarmType, type GeoPoint, type SecurityEvent, type SecurityKind,
} from '@citylight/shared';

export interface AlarmEvent {
  id: string; code: string; type: AlarmType; severity: AlarmSeverity; cabinetId: string; cabinetCode: string; cabinetName: string;
  message: string; startedAt: string; endedAt: string | null;
}
export interface Item { kind: 'raised' | 'cleared'; a: AlarmEvent }

const ICON: Record<AlarmSeverity, string> = { critical: '🔴', major: '🟠', minor: '🟡' };
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Ho_Chi_Minh' });

/** "Chỉ đường" line for a message to a technician; empty when the point is unset. */
export const directionsLine = (p: GeoPoint | null | undefined) => {
  const url = directionsUrl(p);
  return url ? `\n   Chỉ đường: ${url}` : '';
};

export function formatBatch(
  items: Item[], area: (cabinetId: string) => string | null, summaryOver = 5, webUrl = '',
  loc: (cabinetId: string) => GeoPoint | null = () => null,
): string {
  const link = webUrl ? `\nXem: ${webUrl.replace(/\/$/, '')}/alarms` : '';
  if (items.length <= summaryOver) {
    const lines = items.map(({ kind, a }) => {
      const where = area(a.cabinetId);
      const head = kind === 'raised' ? `${ICON[a.severity]} ${a.code} ${ALARM_TYPE_LABELS[a.type] ?? a.type}` : `✅ Hết: ${a.code} ${ALARM_TYPE_LABELS[a.type] ?? a.type}`;
      const body = kind === 'raised' ? `${a.message ? `\n   ${a.message}` : ''}${directionsLine(loc(a.cabinetId))}` : '';
      return `${head}\n   ${a.cabinetCode} - ${a.cabinetName}${where ? ` (${where})` : ''} · ${hhmm(kind === 'raised' ? a.startedAt : a.endedAt ?? a.startedAt)}${body}`;
    });
    return `CityLight\n${lines.join('\n')}${link}`;
  }
  const raised = items.filter((i) => i.kind === 'raised');
  const cleared = items.length - raised.length;
  const count = (keyOf: (i: Item) => string) => {
    const m = new Map<string, number>();
    for (const i of raised) m.set(keyOf(i), (m.get(keyOf(i)) ?? 0) + 1);
    return [...m.entries()].sort((x, y) => y[1] - x[1]);
  };
  const byType = count((i) => `${ICON[i.a.severity]} ${i.a.code} ${ALARM_TYPE_LABELS[i.a.type] ?? i.a.type}`);
  const byArea = count((i) => area(i.a.cabinetId) ?? 'Chưa phân khu vực');
  const cabs = new Set(raised.map((i) => i.a.cabinetId)).size;
  let text = `CityLight: ${raised.length} cảnh báo mới trên ${cabs} tủ${cleared ? `, ${cleared} cảnh báo đã hết` : ''}`;
  if (byType.length) text += `\n\nTheo loại:\n${byType.slice(0, 8).map(([k, n]) => `${k}: ${n}`).join('\n')}`;
  if (byArea.length) text += `\n\nTheo khu vực:\n${byArea.slice(0, 5).map(([k, n]) => `${k}: ${n}`).join('\n')}${byArea.length > 5 ? `\n… và ${byArea.length - 5} khu vực khác` : ''}`;
  return text + link;
}

const SECURITY_ICON: Record<SecurityKind, string> = {
  new_ip: '🔐', locked: '🔒', recovery_login: '🆘', user_created: '👤', role_changed: '👤', user_disabled: '⛔', password_reset: '🔑', totp_reset: '🔑',
};
/** "16:05 20/10" in Vietnam time (Intl gives "20-10" for vi-VN). */
export function vnDateTime(iso: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.hour}:${p.minute} ${p.day}/${p.month}`;
}

/** One security alert (A6): what, which account, from where, when; who did it for user administration. */
export function formatSecurity(e: SecurityEvent, webUrl = ''): string {
  const lines = [`CityLight · Bảo mật`, `${SECURITY_ICON[e.kind]} ${SECURITY_KIND_LABELS[e.kind]}`, `   Tài khoản: ${e.email}`];
  if (e.detail) lines.push(`   ${e.detail}`);
  if (e.by) lines.push(`   Bởi: ${e.by}`);
  const where = [e.ip && `IP ${e.ip}`, (e.ua || !e.by) && shortUserAgent(e.ua)].filter(Boolean).join(' · ');
  lines.push(`   ${where ? `${where} · ` : ''}${vnDateTime(e.at)}`);
  if (SECURITY_SELF_KINDS.includes(e.kind)) lines.push('   Không phải chủ tài khoản đăng nhập? Đổi mật khẩu và báo quản trị ngay.');
  if (webUrl) lines.push(`Xem: ${webUrl.replace(/\/$/, '')}/logs/activity`);
  return lines.join('\n');
}
