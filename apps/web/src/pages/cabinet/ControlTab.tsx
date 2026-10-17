import { useEffect, useState } from 'react';
import { Clock, Lightbulb, LightbulbOff, Power, RotateCcw, Send } from 'lucide-react';
import type { CabinetDetail, Schedule } from '@citylight/shared';
import { COMMAND_STATUS_LABELS, describeCommand } from '@citylight/shared';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/stores/session';
import { cn, fmtTime } from '@/lib/utils';
import { Badge, Button, Card, CardHeader, Checkbox, Input, StatusBadge, Unsupported, confirm, toast } from '@/components/ui';
import { useCommand } from './useCommand';
import { CabinetDiagram } from './CabinetDiagram';

type Detail = CabinetDetail & { cabinet: { districtName: string; wardName: string } };

function BranchBulb({ label, on }: { label: string; on: boolean | null }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div
        className={cn(
          'flex h-14 w-14 items-center justify-center rounded-full border-2',
          on === null && 'border-dashed border-border text-subtle',
          on === true && 'border-st-on bg-st-on/15 text-st-on shadow-[0_0_24px_rgb(var(--st-on)/0.45)]',
          on === false && 'border-border text-st-off',
        )}
      >
        {on ? <Lightbulb className="h-7 w-7" /> : <LightbulbOff className="h-7 w-7" />}
      </div>
      <div className="text-sm font-medium">{label}</div>
      <div className="text-xs text-subtle">{on === null ? 'Không rõ' : on ? 'Đang sáng' : 'Tắt'}</div>
    </div>
  );
}

const STATUS_TONE: Record<string, 'blue' | 'green' | 'red' | 'amber' | 'muted'> = {
  queued: 'muted',
  sent: 'blue',
  acked: 'blue',
  confirmed: 'green',
  acked_unconfirmed: 'amber',
  failed: 'red',
  timeout: 'red',
  cancelled: 'muted',
};

export function ControlTab({ detail }: { detail: Detail }) {
  const { cabinet, state, capabilities } = detail;
  const can = useSession((s) => s.can);
  const label = `${cabinet.code} - ${cabinet.name}`;
  const { active, send } = useCommand(cabinet.id, label);
  const canControl = can('cabinet.control') && capabilities.includes('manual_control');
  const offline = !state.online;
  const disabled = !canControl || offline;
  const disabledReason = !can('cabinet.control')
    ? 'Tài khoản không có quyền điều khiển'
    : !capabilities.includes('manual_control')
      ? 'Firmware cũ: chặn điều khiển (không lọc LTID)'
      : offline
        ? 'Tủ đang mất kết nối'
        : null;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Sơ đồ tủ" subtitle="Sơ đồ một sợi, cập nhật theo thời gian thực" actions={<StatusBadge status={state.status} />} />
        <div className="p-3">
          <CabinetDiagram state={state} code={cabinet.code} />
        </div>
      </Card>

      <Card>
        <CardHeader title="Điều khiển bằng tay" subtitle={disabledReason ?? 'Mọi lệnh đều có hộp xác nhận và được ghi nhật ký'} />
        <div className="grid gap-2 p-4 sm:grid-cols-3">
          <Button disabled={disabled} onClick={() => send('MANUAL_ALL', { on: true }, 'Bật toàn tủ (chế độ thủ công)')}>
            <Lightbulb className="h-4 w-4" /> Bật toàn tủ
          </Button>
          <Button variant="danger" disabled={disabled} onClick={() => send('MANUAL_ALL', { on: false }, 'Tắt toàn tủ (chế độ thủ công)', true)}>
            <LightbulbOff className="h-4 w-4" /> Tắt toàn tủ
          </Button>
          <Button variant="outline" disabled={disabled} onClick={() => send('AUTO', {}, 'Về chế độ tự động theo lịch')}>
            <RotateCcw className="h-4 w-4" /> Về tự động
          </Button>
          {[1, 2].map((b) => (
            <div key={b} className="flex gap-2 sm:col-span-3 md:col-span-1">
              <Button variant="outline" className="flex-1" disabled={disabled} onClick={() => send('MANUAL_BRANCH', { branch: b, on: true }, `Bật nhánh ${b}`)}>
                Bật N{b}
              </Button>
              <Button variant="outline" className="flex-1" disabled={disabled} onClick={() => send('MANUAL_BRANCH', { branch: b, on: false }, `Tắt nhánh ${b}`, true)}>
                Tắt N{b}
              </Button>
            </div>
          ))}
        </div>
        {active && (
          <div className="mx-4 mb-4 flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2 text-sm">
            <span className="truncate">{describeCommand(active.type, active.params)}</span>
            <Badge tone={STATUS_TONE[active.status]}>{COMMAND_STATUS_LABELS[active.status]}</Badge>
          </div>
        )}
      </Card>

      <ScheduleCard detail={detail} />

      <Card>
        <CardHeader title="Thời gian TĐK" />
        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="flex items-center gap-2 text-sm">
            <Clock className="h-4 w-4 text-subtle" />
            <span className="font-mono">{fmtTime(state.deviceTime, 'DD/MM/YYYY HH:mm')}</span>
            {!state.deviceTime && <span className="text-xs text-subtle">(PLC không phản hồi)</span>}
          </div>
          <Button variant="outline" size="sm" disabled={!can('cabinet.control') || offline} onClick={() => send('SET_TIME', {}, 'Đồng bộ thời gian với máy chủ')}>
            Đồng bộ thời gian với máy chủ
          </Button>
        </div>
      </Card>
    </div>
  );
}

function ScheduleCard({ detail }: { detail: Detail }) {
  const { cabinet, schedule } = detail;
  const can = useSession((s) => s.can);
  const [s, setS] = useState<Schedule>(schedule);
  const [saving, setSaving] = useState(false);
  useEffect(() => setS(schedule), [schedule]);
  const editable = can('schedule.manage');
  const set = <K extends keyof Schedule>(k: K, v: Schedule[K]) => setS((p) => ({ ...p, [k]: v }));

  async function save() {
    if (s.mode === 2 && !s.branch1Enabled && !s.branch2Enabled) {
      const ok = await confirm({ title: 'Cả hai nhánh bị tắt', body: 'Ở Chế độ 2, tắt cả hai nhánh làm LOGO quay về Chế độ 1. Vẫn gửi?', danger: true });
      if (!ok) return;
    }
    const ok = await confirm({
      title: 'Gửi lịch xuống tủ',
      body: (
        <div>
          Tủ <b>{cabinet.code} - {cabinet.name}</b>: Chế độ {s.mode}, nhánh 1 {s.on1} → {s.off1}
          {s.mode === 2 && `, nhánh 2 ${s.on2} → ${s.off2}`}
        </div>
      ),
      confirmLabel: 'Gửi lịch',
    });
    if (!ok) return;
    setSaving(true);
    try {
      await api.setSchedule(cabinet.id, s);
      toast('Đã gửi lịch, đang chờ tủ xác nhận', 'success');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Gửi lịch thất bại', 'error');
    } finally {
      setSaving(false);
    }
  }

  const timeRange = (label: string, on: keyof Schedule, off: keyof Schedule, check?: keyof Schedule) => (
    <div className="flex flex-wrap items-center gap-2">
      {check ? <Checkbox label={label} checked={!!s[check]} onChange={(v) => set(check, v as never)} disabled={!editable} /> : <span className="w-40 text-sm">{label}</span>}
      <Input type="time" value={s[on] as string} onChange={(e) => set(on, e.target.value as never)} className="w-28" disabled={!editable} />
      <span className="text-subtle">→</span>
      <Input type="time" value={s[off] as string} onChange={(e) => set(off, e.target.value as never)} className="w-28" disabled={!editable} />
    </div>
  );

  return (
    <Card>
      <CardHeader
        title="Lịch bật/tắt"
        subtitle={`${s.inheritedFromZone ? 'Kế thừa từ vùng' : 'Riêng cho tủ'} · gửi lần cuối ${fmtTime(s.appliedAt)} · tủ chưa báo lại lịch đang chạy (chờ firmware)`}
        actions={
          editable && (
            <Button size="sm" onClick={save} loading={saving} disabled={!detail.state.online}>
              <Send className="h-4 w-4" /> Lưu & gửi xuống tủ
            </Button>
          )
        }
      />
      <div className="space-y-4 p-4">
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="radio" checked={s.mode === 1} onChange={() => set('mode', 1)} disabled={!editable} /> Chế độ 1 (chung 2 nhánh)
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={s.mode === 2} onChange={() => set('mode', 2)} disabled={!editable} /> Chế độ 2 (lịch riêng từng nhánh)
          </label>
        </div>
        {s.mode === 1 ? (
          <div className="space-y-2">
            {timeRange('Thời gian mở đèn', 'on1', 'off1')}
            <div className="flex items-center gap-2">
              <span className="w-40 text-sm text-subtle">Thời gian tiết giảm</span>
              <Unsupported>Chưa hỗ trợ trên thiết bị (T12 đang tắt)</Unsupported>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {timeRange('Mở nhánh 1', 'on1', 'off1', 'branch1Enabled')}
            {timeRange('Mở nhánh 2', 'on2', 'off2', 'branch2Enabled')}
            <div className="flex items-center gap-2">
              <span className="w-40 text-sm text-subtle">Thời gian tiết giảm</span>
              <Unsupported>Chưa hỗ trợ trên thiết bị</Unsupported>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
