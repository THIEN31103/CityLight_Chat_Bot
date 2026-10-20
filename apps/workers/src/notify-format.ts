// Text of one notification message (Telegram plain text): a few alarms one by one, a burst as a summary.
// S49: every message is written in the recipient's language (users.lang); Vietnamese is the default.
// Data stays as stored (alarm messages, cabinet / area names, incident content, security event details).
import {
  LABELS, SECURITY_KIND_LABELS_I18N, SECURITY_SELF_KINDS, alarmTypeLabels, defineDict, directionsUrl, incidentCategoryLabel, plural, shortUserAgent,
  type AlarmSeverity, type AlarmType, type GeoPoint, type Lang, type SecurityEvent, type SecurityKind,
} from '@citylight/shared';

export interface AlarmEvent {
  id: string; code: string; type: AlarmType; severity: AlarmSeverity; cabinetId: string; cabinetCode: string; cabinetName: string;
  message: string; startedAt: string; endedAt: string | null;
}
export interface Item { kind: 'raised' | 'cleared'; a: AlarmEvent }

export interface IncidentEvent {
  id: string; code: string; cabinetName: string; districtName: string; category: string; content: string; deadline: string; assigneeId: string; by?: string;
}

const T = defineDict(
  {
    view: 'Xem',
    directions: 'Chỉ đường',
    cleared: 'Hết',
    summary: (raised: number, cabs: number, cleared: number) => `${raised} cảnh báo mới trên ${cabs} tủ${cleared ? `, ${cleared} cảnh báo đã hết` : ''}`,
    byType: 'Theo loại',
    byArea: 'Theo khu vực',
    noArea: 'Chưa phân khu vực',
    moreAreas: (n: number) => `… và ${n} khu vực khác`,
    security: 'Bảo mật',
    account: 'Tài khoản',
    by: 'Bởi',
    notYou: 'Không phải chủ tài khoản đăng nhập? Đổi mật khẩu và báo quản trị ngay.',
    assigned: (code: string, by: string | undefined) => `📋 Sự cố ${code} giao cho bạn${by ? ` (bởi ${by})` : ''}`,
    overdue: (code: string) => `⏰ Sự cố ${code} đã quá hạn xử lý`,
    deadline: 'Hạn',
    badLink: 'Mã liên kết không đúng hoặc đã hết hạn. Tạo mã mới ở trang Tài khoản → Thông báo.',
    linked: (email: string, levels: string) =>
      `Đã liên kết CityLight với tài khoản ${email}. Bạn sẽ nhận cảnh báo mức ${levels} trong khu vực được phân quyền; đổi mức ở trang Tài khoản.`,
    and: 'và',
    stopped: 'Đã tắt thông báo CityLight. Bật lại ở trang Tài khoản.',
    howTo: 'Để nhận cảnh báo CityLight: vào trang Tài khoản → Thông báo → "Liên kết Telegram".',
  },
  {
    view: 'View',
    directions: 'Directions',
    cleared: 'Cleared',
    summary: (raised: number, cabs: number, cleared: number) =>
      `${plural(raised, 'new alarm', 'new alarms')} on ${plural(cabs, 'cabinet', 'cabinets')}${cleared ? `, ${plural(cleared, 'alarm', 'alarms')} cleared` : ''}`,
    byType: 'By type',
    byArea: 'By area',
    noArea: 'No area',
    moreAreas: (n: number) => `… and ${plural(n, 'more area', 'more areas')}`,
    security: 'Security',
    account: 'Account',
    by: 'By',
    notYou: 'Not you signing in? Change your password and tell an administrator now.',
    assigned: (code: string, by: string | undefined) => `📋 Incident ${code} assigned to you${by ? ` (by ${by})` : ''}`,
    overdue: (code: string) => `⏰ Incident ${code} is overdue`,
    deadline: 'Deadline',
    badLink: 'The link code is wrong or has expired. Create a new one on My account → Alarm notifications.',
    linked: (email: string, levels: string) =>
      `CityLight is linked to the account ${email}. You will get ${levels} alarms in your areas; change the level on the My account page.`,
    and: 'and',
    stopped: 'CityLight notifications are off. Turn them on again on the My account page.',
    howTo: 'To get CityLight alarms: open My account → Alarm notifications → "Link Telegram".',
  },
);

const ICON: Record<AlarmSeverity, string> = { critical: '🔴', major: '🟠', minor: '🟡' };
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Ho_Chi_Minh' });

/** "Chỉ đường" line for a message to a technician; empty when the point is unset. */
export const directionsLine = (p: GeoPoint | null | undefined, lang: Lang = 'vi') => {
  const url = directionsUrl(p);
  return url ? `\n   ${T[lang].directions}: ${url}` : '';
};

const viewLink = (webUrl: string, path: string, lang: Lang) => (webUrl ? `\n${T[lang].view}: ${webUrl.replace(/\/$/, '')}${path}` : '');

export function formatBatch(
  items: Item[], area: (cabinetId: string) => string | null, summaryOver = 5, webUrl = '',
  loc: (cabinetId: string) => GeoPoint | null = () => null, lang: Lang = 'vi',
): string {
  const t = T[lang];
  const types = alarmTypeLabels(lang);
  const title = (a: AlarmEvent) => `${a.code} ${types[a.type] ?? a.type}`;
  const link = viewLink(webUrl, '/alarms', lang);
  if (items.length <= summaryOver) {
    const lines = items.map(({ kind, a }) => {
      const where = area(a.cabinetId);
      const head = kind === 'raised' ? `${ICON[a.severity]} ${title(a)}` : `✅ ${t.cleared}: ${title(a)}`;
      const body = kind === 'raised' ? `${a.message ? `\n   ${a.message}` : ''}${directionsLine(loc(a.cabinetId), lang)}` : '';
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
  const byType = count((i) => `${ICON[i.a.severity]} ${title(i.a)}`);
  const byArea = count((i) => area(i.a.cabinetId) ?? t.noArea);
  const cabs = new Set(raised.map((i) => i.a.cabinetId)).size;
  let text = `CityLight: ${t.summary(raised.length, cabs, cleared)}`;
  if (byType.length) text += `\n\n${t.byType}:\n${byType.slice(0, 8).map(([k, n]) => `${k}: ${n}`).join('\n')}`;
  if (byArea.length) text += `\n\n${t.byArea}:\n${byArea.slice(0, 5).map(([k, n]) => `${k}: ${n}`).join('\n')}${byArea.length > 5 ? `\n${t.moreAreas(byArea.length - 5)}` : ''}`;
  return text + link;
}

const SECURITY_ICON: Record<SecurityKind, string> = {
  new_ip: '🔐', locked: '🔒', recovery_login: '🆘', user_created: '👤', role_changed: '👤', user_disabled: '⛔', password_reset: '🔑', totp_reset: '🔑',
};
/** "16:05 20/10" in Vietnam time (Intl gives "20-10" for vi-VN); the same in both languages. */
export function vnDateTime(iso: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.hour}:${p.minute} ${p.day}/${p.month}`;
}

/** One security alert (A6): what, which account, from where, when; who did it for user administration. */
export function formatSecurity(e: SecurityEvent, webUrl = '', lang: Lang = 'vi'): string {
  const t = T[lang];
  const lines = [`CityLight · ${t.security}`, `${SECURITY_ICON[e.kind]} ${SECURITY_KIND_LABELS_I18N[lang][e.kind]}`, `   ${t.account}: ${e.email}`];
  if (e.detail) lines.push(`   ${e.detail}`);
  if (e.by) lines.push(`   ${t.by}: ${e.by}`);
  const where = [e.ip && `IP ${e.ip}`, (e.ua || !e.by) && shortUserAgent(e.ua, lang)].filter(Boolean).join(' · ');
  lines.push(`   ${where ? `${where} · ` : ''}${vnDateTime(e.at)}`);
  if (SECURITY_SELF_KINDS.includes(e.kind)) lines.push(`   ${t.notYou}`);
  if (webUrl) lines.push(`${t.view}: ${webUrl.replace(/\/$/, '')}/logs/activity`);
  return lines.join('\n');
}

/** Incident assigned to / overdue for the assignee (M7), with the route to the incident's point. */
export function formatIncident(kind: 'assigned' | 'overdue', i: IncidentEvent, at: GeoPoint | null | undefined, webUrl = '', lang: Lang = 'vi'): string {
  const t = T[lang];
  const head = kind === 'assigned' ? t.assigned(i.code, i.by) : t.overdue(i.code);
  const link = viewLink(webUrl, `/incidents/${i.id}`, lang);
  // the API / scheduler send the Vietnamese "no district" fallback (T.vi.noArea): show it in the reader's language
  const district = i.districtName === T.vi.noArea ? t.noArea : i.districtName;
  return `CityLight\n${head}\n   ${i.cabinetName} (${district})\n   ${incidentCategoryLabel(i.category, lang)}: ${i.content}\n   ${t.deadline}: ${vnDateTime(i.deadline)}${directionsLine(at, lang)}${link}`;
}

/** Bot replies (Telegram linking). */
export function botText(key: 'badLink' | 'stopped' | 'howTo', lang: Lang = 'vi'): string {
  return T[lang][key];
}
/** Reply to a chat whose user is not known (bad link code, plain /start, /stop of an unlinked chat): both languages. */
export const botTextBoth = (key: 'badLink' | 'stopped' | 'howTo') => `${T.vi[key]}\n\n${T.en[key]}`;

/** Reply to a successful "/start <code>": which alarms the user gets (new subscriptions start at major and above). */
export function formatLinked(email: string, lang: Lang = 'vi'): string {
  const s = LABELS[lang].severity;
  return T[lang].linked(email, `"${s.major}" ${T[lang].and} "${s.critical}"`);
}
