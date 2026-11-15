// From a parsed order to a pending action, and from a command outcome to the sentence Jarvis says. Fixed sentences
// built in code: the model is not involved in any step of an action (it could word a "đã bật" before it is true).
// Wording checked against CityLight's own labels (packages/shared/src/labels.ts) and the device rules in
// packages/coreif/src/commands.ts: PULSE_ON = "bật tạm cả 2 nhánh 15 phút (xung I2)", DIAG = "tự kiểm tra RS485";
// both end at "acked" (the cabinet reports nothing that proves them), the others at "confirmed".
import type { RoleKey } from '@citylight/shared';
import { resolveCabinet } from '../tools/read';
import type { ToolContext } from '../tools/registry';
import { describeCommand, type Order } from './orders';
import type { Outcome, PendingAction } from './pending';
import { cabinetRefused, controlUnavailable, tierFor, type ActionCommand, type GuardState, type Tier } from './policy';
import { expectedNow, scheduleNote, type ScheduleLike } from './schedule-note';

export type Proposal =
  | { kind: 'pending'; draft: Omit<PendingAction, 'id' | 'createdAt' | 'expiresAt'>; say: string }
  | { kind: 'refused'; say: string };

const HOW: Record<Tier, string> = {
  T1: 'Nói hoặc gõ "xác nhận" (hoặc bấm nút trên thẻ bên dưới) để gửi, "hủy lệnh" để bỏ. Thẻ hết hạn sau 60 giây.',
  T2: 'Lệnh tắt chỉ gửi khi bạn bấm nút "Xác nhận" trên thẻ bên dưới, không nhận xác nhận bằng giọng hay chữ. Thẻ hết hạn sau 60 giây.',
};

/** "Tắt tay nhánh 1 của tủ TL01.0016 (Điện Biên Phủ 7)": the card's title and the first sentence */
export function summaryOf(cmd: ActionCommand, c: { code: string; name: string }): string {
  const cab = `tủ ${c.code} (${c.name})`;
  const verb = cmd.params.on ? 'Bật' : 'Tắt';
  switch (cmd.type) {
    case 'MANUAL_ALL':
      return `${verb} tay cả hai nhánh đèn ${cab}`;
    case 'MANUAL_BRANCH':
      return `${verb} tay nhánh ${cmd.params.branch} của ${cab}`;
    case 'AUTO':
      return `Trả ${cab} về chạy theo lịch`;
    case 'PULSE_ON':
      return `Bật tạm cả hai nhánh 15 phút (xung) ở ${cab}`;
    case 'DIAG':
      return `Gửi lệnh tự kiểm tra RS485 tới ${cab}`;
  }
}

export async function propose(order: Order, ctx: ToolContext, guard: GuardState, role: RoleKey, idleMs = 0, now = Date.now()): Promise<Proposal> {
  const off = controlUnavailable(guard, role);
  if (off) return { kind: 'refused', say: off };
  if (order.kind === 'many')
    return { kind: 'refused', say: 'Lệnh cho nhiều tủ cùng lúc phải làm trên web CityLight (cần mã OTP). Jarvis chỉ điều khiển từng tủ một.' };
  if (order.kind === 'which_cabinet') return { kind: 'refused', say: `Bạn muốn ${describeCommand(order.command).toLowerCase()} ở tủ nào? Nói mã tủ giúp tôi.` };

  const r = await resolveCabinet(ctx, order.cabinet);
  if (r.kind === 'none') return { kind: 'refused', say: 'Tôi không tìm thấy tủ đó trong phạm vi của bạn.' };
  if (r.kind === 'many') return { kind: 'refused', say: `Có nhiều tủ khớp: ${r.choices.map((c) => c.code).join(', ')}. Bạn muốn tủ nào?` };
  const c = r.cabinet;
  ctx.focus.cabinet = { id: c.id, code: c.code, name: c.name };
  const refused = cabinetRefused(guard, c.code);
  if (refused) return { kind: 'refused', say: refused };

  // the state now: an offline cabinet is refused by the API anyway, say it before asking to confirm
  const detail = await ctx.reads.cabinet(c.id, { signal: ctx.signal }).catch(() => null);
  const st = (detail?.state ?? {}) as Record<string, unknown>;
  if (detail && st.online === false) return { kind: 'refused', say: `Tủ ${c.code} đang mất kết nối, không gửi lệnh được.` };
  const cmd = order.command;
  const sched = detail?.schedule as ScheduleLike | undefined;
  const tier = tierFor(cmd, idleMs);
  const what = summaryOf(cmd, c);
  let note = scheduleNote(cmd, sched, now);
  // back to the schedule: say whether the lights will change
  if (cmd.type === 'AUTO' && note && st.online === true) {
    const want = expectedNow(sched, now);
    if (want) note += want[0] === (st.branch1On === true) && want[1] === (st.branch2On === true) ? ' Đèn sẽ giữ nguyên.' : ' Sau lệnh, đèn sẽ đổi theo lịch.';
  }
  const state = st.online === true ? stateNow(cmd, st) : '';
  return {
    kind: 'pending',
    draft: { command: cmd, cabinet: { id: c.id, code: c.code, name: c.name }, summary: what, tier, note },
    say: [`${what}.`, state, note, HOW[tier]].filter(Boolean).join(' '),
  };
}

/** "cả hai nhánh đang sáng" / "nhánh 1 đang sáng, nhánh 2 đang tắt", branch 1 first */
function lights(st: Record<string, unknown>): string {
  const b1 = st.branch1On === true;
  const b2 = st.branch2On === true;
  if (b1 === b2) return `cả hai nhánh đang ${b1 ? 'sáng' : 'tắt'}`;
  return `nhánh 1 đang ${b1 ? 'sáng' : 'tắt'}, nhánh 2 đang ${b2 ? 'sáng' : 'tắt'}`;
}

/** what the cabinet does now, for the branches the order is about; and when the order would change no light */
function stateNow(cmd: ActionCommand, st: Record<string, unknown>): string {
  const manual = st.manualMode === true;
  const mode = manual ? 'tủ đang chạy tay' : 'tủ đang chạy theo lịch';
  if (cmd.type === 'AUTO') return manual ? `Hiện ${lights(st)}, ${mode}.` : `Lưu ý: tủ đang chạy theo lịch sẵn rồi (${lights(st)}).`;
  if (cmd.type !== 'MANUAL_ALL' && cmd.type !== 'MANUAL_BRANCH') return `Hiện ${lights(st)}, ${mode}.`;
  const lit = [st.branch1On === true, st.branch2On === true];
  const branches = cmd.type === 'MANUAL_BRANCH' ? [cmd.params.branch!] : [1, 2];
  const target = cmd.type === 'MANUAL_BRANCH' ? `nhánh ${cmd.params.branch} đang ${lit[cmd.params.branch! - 1] ? 'sáng' : 'tắt'}` : lights(st);
  if (!branches.every((b) => lit[b - 1] === cmd.params.on)) return `Hiện ${target}, ${mode}.`;
  return manual
    ? `Lưu ý: ${target} sẵn rồi và tủ đang chạy tay, lệnh này không làm đèn thay đổi.`
    : `Lưu ý: ${target} sẵn rồi theo lịch, lệnh này không đổi đèn mà chỉ chuyển tủ sang chạy tay.`;
}

/** The sentence after the command: "đã xác nhận" only from the cabinet's own data (status confirmed). */
export function outcomeText(p: PendingAction, o: Outcome, after?: Record<string, unknown> | null): string {
  const code = p.cabinet.code;
  const cmd = p.command;
  const now = after ? ` Hiện ${lights(after)}.` : '';
  const note = p.note && (cmd.type === 'MANUAL_ALL' || cmd.type === 'MANUAL_BRANCH') ? ` ${p.note}` : '';
  switch (o.status) {
    case 'confirmed': {
      const verb = cmd.params.on ? 'bật' : 'tắt';
      const did =
        cmd.type === 'MANUAL_ALL' ? `đã ${verb} cả hai nhánh (chạy tay)`
        : cmd.type === 'MANUAL_BRANCH' ? `đã ${verb} nhánh ${cmd.params.branch} (chạy tay)`
        : 'đã trở về chạy theo lịch';
      return `Đã xác nhận: tủ ${code} ${did}.${now}${note}`;
    }
    case 'acked':
      // PULSE_ON / DIAG: the cabinet took it, nothing in its data can prove more
      return cmd.type === 'DIAG'
        ? `Tủ ${code} đã nhận lệnh tự kiểm tra RS485. Kết quả xem ở phần chẩn đoán của tủ trên web CityLight.`
        : `Tủ ${code} đã nhận lệnh bật tạm 15 phút. Tủ không báo xác nhận riêng cho lệnh này, hết 15 phút đèn về theo lịch.`;
    case 'acked_unconfirmed':
      return `Tủ ${code} đã nhận lệnh nhưng dữ liệu đo chưa đổi theo. Bạn kiểm tra lại trên web CityLight.`;
    case 'failed':
      return `Lệnh tới tủ ${code} thất bại${o.error ? `: ${o.error}` : ''}.`;
    case 'timeout':
      return `Sau 60 giây tủ ${code} vẫn chưa xác nhận lệnh. Bạn theo dõi thêm trên web CityLight.`;
    case 'cancelled':
      return `Lệnh tới tủ ${code} đã bị hủy.`;
    case 'not_sent':
      return o.code === 'reauth_required'
        ? 'Máy chủ yêu cầu xác thực lại 2 lớp: bạn đăng xuất rồi đăng nhập lại Jarvis, sau đó ra lệnh lại.'
        : `Không gửi được lệnh tới tủ ${code}${o.error ? `: ${o.error}` : ''}.`;
    default:
      return `Lệnh tới tủ ${code}: ${o.status}.`;
  }
}

/** what the console shows on the status line while the command travels */
export const STATUS_VI: Partial<Record<Outcome['status'], string>> = {
  queued: 'Lệnh đang chờ gửi…', sent: 'Đã gửi xuống tủ, chờ tủ nhận…', acked: 'Tủ đã nhận lệnh, chờ dữ liệu đo xác nhận…',
};
