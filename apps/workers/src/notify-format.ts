// Text of one notification message (Telegram plain text): a few alarms one by one, a burst as a summary.
import { ALARM_TYPE_LABELS, type AlarmSeverity, type AlarmType } from '@citylight/shared';

export interface AlarmEvent {
  id: string; code: string; type: AlarmType; severity: AlarmSeverity; cabinetId: string; cabinetCode: string; cabinetName: string;
  message: string; startedAt: string; endedAt: string | null;
}
export interface Item { kind: 'raised' | 'cleared'; a: AlarmEvent }

const ICON: Record<AlarmSeverity, string> = { critical: '🔴', major: '🟠', minor: '🟡' };
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Ho_Chi_Minh' });

export function formatBatch(items: Item[], area: (cabinetId: string) => string | null, summaryOver = 5, webUrl = ''): string {
  const link = webUrl ? `\nXem: ${webUrl.replace(/\/$/, '')}/alarms` : '';
  if (items.length <= summaryOver) {
    const lines = items.map(({ kind, a }) => {
      const where = area(a.cabinetId);
      const head = kind === 'raised' ? `${ICON[a.severity]} ${a.code} ${ALARM_TYPE_LABELS[a.type] ?? a.type}` : `✅ Hết: ${a.code} ${ALARM_TYPE_LABELS[a.type] ?? a.type}`;
      const body = kind === 'raised' && a.message ? `\n   ${a.message}` : '';
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
