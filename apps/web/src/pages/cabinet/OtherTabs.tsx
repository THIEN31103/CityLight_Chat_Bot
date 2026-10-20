import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, MapPin, Upload } from 'lucide-react';
import type { CabinetDetail, Command, DimmingProfile, GeoPoint, LampGroup, Thresholds } from '@citylight/shared';
import { ALARM_TYPE_LABELS, COMMAND_STATUS_LABELS, LAMP_GROUP_LABELS, SEVERITY_LABELS, describeCommand } from '@citylight/shared';
import { api, ApiError } from '@/lib/api';
import { subscribe } from '@/lib/realtime';
import { useSession } from '@/stores/session';
import { fmtDuration, fmtNum, fmtTime } from '@/lib/utils';
import { Badge, Button, Card, CardHeader, Checkbox, Empty, Input, KV, Select, Spinner, Unsupported, toast } from '@/components/ui';
import { DimmingEditor } from '@/components/DimmingEditor';
import { DIMMING_SOURCE } from '@/pages/DimmingPage';
import { ErrorCodeBadge } from '@/components/ErrorHelp';
import { RelocateGpsButton } from './RelocateGps';
import { ImeiButton } from './ImeiDecision';

type Detail = CabinetDetail & { cabinet: { districtName: string; wardName: string } };

// ---------- Cài đặt ngưỡng ----------

const THRESHOLD_ROWS: { key: keyof Thresholds; label: string; unit: string; current?: (d: Detail) => string }[] = [
  { key: 'voltageHigh', label: 'Điện áp pha — ngưỡng cao', unit: 'V', current: (d) => `L1 ${fmtNum(d.state.vL1)} · L2 ${fmtNum(d.state.vL2)} · L3 ${fmtNum(d.state.vL3)}` },
  { key: 'voltageLow', label: 'Điện áp pha — ngưỡng thấp', unit: 'V' },
  { key: 'voltageSwing', label: 'Điện áp pha — độ dao động', unit: 'V' },
  { key: 'currentHigh', label: 'Dòng pha — ngưỡng cao', unit: 'A', current: (d) => `I1 ${fmtNum(d.state.iL1)} · I2 ${fmtNum(d.state.iL2)} · I3 ${fmtNum(d.state.iL3)}` },
  { key: 'currentLow', label: 'Dòng pha — ngưỡng thấp', unit: 'A' },
  { key: 'currentSwing', label: 'Dòng pha — độ dao động', unit: 'A' },
  { key: 'currentNoLoad', label: 'Ngưỡng không tải', unit: 'A' },
  { key: 'leakMa', label: 'Dòng rò', unit: 'mA', current: (d) => fmtNum(d.state.leakMa, 0, 'mA') },
  { key: 'tempC', label: 'Nhiệt độ tủ', unit: '°C', current: (d) => fmtNum(d.state.tempC, 0, '°C') },
  { key: 'batteryLowMv', label: 'Pin yếu', unit: 'mV', current: (d) => fmtNum(d.state.batteryMv, 0, 'mV') },
];

export function ThresholdsTab({ detail }: { detail: Detail }) {
  const qc = useQueryClient();
  const can = useSession((s) => s.can('cabinet.configure'));
  const [t, setT] = useState<Thresholds>(detail.thresholds);
  useEffect(() => setT(detail.thresholds), [detail.thresholds]);
  const save = useMutation({
    mutationFn: () => api.setThresholds(detail.cabinet.id, t),
    onSuccess: () => {
      toast('Đã lưu ngưỡng cảnh báo', 'success');
      qc.invalidateQueries({ queryKey: ['cabinet', detail.cabinet.id] });
    },
  });
  return (
    <Card>
      <CardHeader
        title="Thông số cảnh báo lỗi"
        subtitle="Ngưỡng được xét ở máy chủ (rule engine), không cần gửi xuống tủ"
        actions={can && <Button size="sm" onClick={() => save.mutate()} loading={save.isPending}>Lưu</Button>}
      />
      <div className="divide-y">
        {THRESHOLD_ROWS.map((r) => (
          <div key={r.key} className="grid items-center gap-2 px-4 py-2 sm:grid-cols-[1fr_140px_1fr]">
            <Checkbox label={r.label} checked={t[r.key].enabled} onChange={(v) => setT({ ...t, [r.key]: { ...t[r.key], enabled: v } })} disabled={!can} />
            <div className="flex items-center gap-1">
              <Input type="number" value={t[r.key].value} onChange={(e) => setT({ ...t, [r.key]: { ...t[r.key], value: Number(e.target.value) } })} disabled={!can || !t[r.key].enabled} className="h-8" />
              <span className="w-8 text-xs text-subtle">{r.unit}</span>
            </div>
            <div className="text-xs text-subtle">{r.current ? `Hiện tại: ${r.current(detail)}` : ''}</div>
          </div>
        ))}
      </div>
      <div className="p-4 pt-2">
        <Unsupported>Dòng theo nhánh N1/N2 (thay vì theo pha) cần cấu hình ánh xạ pha ↔ nhánh cho từng tủ</Unsupported>
      </div>
    </Card>
  );
}

// ---------- Tiết giảm ----------

export function DimmingTab({ detail }: { detail: Detail }) {
  const qc = useQueryClient();
  const can = useSession((s) => s.can('dimming.manage'));
  const [group, setGroup] = useState<LampGroup>(0);
  const { data } = useQuery({ queryKey: ['cabinet-dimming', detail.cabinet.id, group], queryFn: () => api.cabinetDimming(detail.cabinet.id, group) });
  const [profile, setProfile] = useState<DimmingProfile | null>(null);
  useEffect(() => setProfile(data ?? null), [data]);
  const fail = (e: unknown) => toast(e instanceof ApiError ? e.message : 'Lỗi', 'error');
  const save = useMutation({
    mutationFn: () => api.setCabinetDimming(detail.cabinet.id, profile!),
    onSuccess: () => {
      toast('Đã lưu hồ sơ tiết giảm cho tủ (chưa gửi được xuống thiết bị)', 'success');
      qc.invalidateQueries({ queryKey: ['cabinet-dimming', detail.cabinet.id] });
    },
    onError: fail,
  });
  const drop = useMutation({
    mutationFn: () => api.dropCabinetDimming(detail.cabinet.id, group),
    onSuccess: () => {
      toast('Tủ đã quay về hồ sơ vùng / hệ thống', 'success');
      qc.invalidateQueries({ queryKey: ['cabinet-dimming', detail.cabinet.id] });
    },
    onError: fail,
  });
  const supported = detail.capabilities.includes('dimming');
  return (
    <div className="space-y-3">
      {!supported && <Unsupported>Thiết bị chưa hỗ trợ tiết giảm. Hồ sơ vẫn lưu được ở máy chủ và sẽ gửi khi firmware/phần cứng hỗ trợ.</Unsupported>}
      <Card>
        <CardHeader
          title="Hồ sơ tiết giảm của tủ"
          subtitle={
            profile?.source
              ? profile.source === 'cabinet' ? 'Đang dùng hồ sơ riêng của tủ' : `Đang kế thừa ${DIMMING_SOURCE[profile.source]} — lưu để ghi đè riêng cho tủ`
              : profile?.inheritedFromZone ? 'Đang kế thừa cấu hình vùng — lưu để ghi đè riêng cho tủ' : 'Đang ghi đè riêng cho tủ'
          }
          actions={
            <>
              <Select value={group} onChange={(e) => setGroup(Number(e.target.value) as LampGroup)}>
                {([0, 1, 2, 3] as LampGroup[]).map((g) => (
                  <option key={g} value={g}>
                    {LAMP_GROUP_LABELS[g]}
                  </option>
                ))}
              </Select>
              {can && profile?.source === 'cabinet' && (
                <Button size="sm" variant="outline" onClick={() => drop.mutate()} loading={drop.isPending}>
                  Bỏ hồ sơ riêng
                </Button>
              )}
              {can && <Button size="sm" onClick={() => save.mutate()} loading={save.isPending} disabled={!profile}>Lưu</Button>}
            </>
          }
        />
        <div className="p-4">{profile ? <DimmingEditor segments={profile.segments} onChange={(segments) => setProfile({ ...profile, segments })} disabled={!can} estimate={profile.estimate} /> : <Spinner />}</div>
      </Card>
    </div>
  );
}

// ---------- Đèn ----------

export function LampsTab({ detail, onLocate }: { detail: Detail; onLocate: (p: GeoPoint) => void }) {
  const { data, isLoading } = useQuery({ queryKey: ['cabinet-lamps', detail.cabinet.id], queryFn: () => api.cabinetLamps(detail.cabinet.id) });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const smart = detail.capabilities.includes('smart_lamps');
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Card className="p-3">
          <div className="text-xs text-subtle">Tổng số đèn</div>
          <div className="text-lg font-semibold">{data?.length ?? '…'}</div>
        </Card>
        <Card className="p-3">
          <div className="text-xs text-subtle">Đèn kết nối</div>
          <div className="text-lg font-semibold">—</div>
        </Card>
        <Card className="p-3">
          <div className="text-xs text-subtle">Mức công suất</div>
          <div className="text-lg font-semibold">—</div>
        </Card>
        <Card className="p-3">
          <div className="text-xs text-subtle">PAN ID</div>
          <div className="text-lg font-semibold">—</div>
        </Card>
      </div>
      {!smart && <Unsupported>Chưa có đèn thông minh: danh sách đèn là dữ liệu GIS, chưa điều khiển/giám sát từng bóng.</Unsupported>}
      <Card>
        <CardHeader
          title="Danh sách đèn"
          actions={
            <>
              <Button size="sm" variant="outline" disabled={!smart || !selected.size}>Bật</Button>
              <Button size="sm" variant="outline" disabled={!smart || !selected.size}>Tắt</Button>
              <Button size="sm" variant="outline" disabled={!smart || !selected.size}>Dim %</Button>
            </>
          }
        />
        {isLoading ? (
          <div className="p-6"><Spinner /></div>
        ) : (
          <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3 md:grid-cols-4">
            {data?.map((l) => (
              <div key={l.id} className="rounded-md border p-2 text-xs">
                <div className="flex items-center justify-between">
                  <Checkbox
                    label={<b>{l.poleCode.split('_').slice(-2).join('_')}·{l.code}</b>}
                    checked={selected.has(l.id)}
                    onChange={(v) =>
                      setSelected((s) => {
                        const n = new Set(s);
                        if (v) n.add(l.id);
                        else n.delete(l.id);
                        return n;
                      })
                    }
                  />
                  <button onClick={() => onLocate(l.location)} className="text-subtle hover:text-primary" aria-label="Định vị đèn">
                    <MapPin className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="mt-1 text-subtle">{l.ratedPowerW} W · nhánh {l.branch}</div>
                <Select className="mt-1 h-7 w-full text-xs" defaultValue={l.lampGroup} aria-label="Nhóm đèn">
                  {([0, 1, 2, 3] as LampGroup[]).map((g) => (
                    <option key={g} value={g}>
                      {LAMP_GROUP_LABELS[g]}
                    </option>
                  ))}
                </Select>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------- Thông tin ----------

export function InfoTab({ detail, onLocate }: { detail: Detail; onLocate: (p: GeoPoint) => void }) {
  const { cabinet: c, state: s } = detail;
  const can = useSession((x) => x.can('cabinet.configure'));
  const gpsDiff =
    s.gpsDevice &&
    Math.round(
      6371000 *
        2 *
        Math.asin(
          Math.sqrt(
            Math.sin(((s.gpsDevice.lat - c.location.lat) * Math.PI) / 360) ** 2 +
              Math.cos((c.location.lat * Math.PI) / 180) * Math.cos((s.gpsDevice.lat * Math.PI) / 180) * Math.sin(((s.gpsDevice.lng - c.location.lng) * Math.PI) / 360) ** 2,
          ),
        ),
    );
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader title="Thiết bị" />
        <div className="px-4 py-2">
          <KV label="Mã thiết bị (LTID)" value={c.ltid} />
          <KV label="IMEI" value={<span className="inline-flex items-center gap-2"><span className="font-mono">{c.imei || '(chưa có)'}</span><ImeiButton cabinetId={c.id} label={`${c.code} - ${c.name}`} text="IMEI…" /></span>} />
          <KV label="Firmware" value={<Badge tone={c.fwProfile === 'v2-1307ebc' ? 'orange' : 'blue'}>{c.fwProfile}</Badge>} />
          <KV label="Pin" value={fmtNum(s.batteryMv, 0, 'mV')} />
          <KV label="SIM seri / nhà mạng / sóng" value={<span className="text-subtle">Chờ firmware</span>} />
          <KV label="Lắp đặt" value={fmtTime(c.installedAt, 'DD/MM/YYYY')} />
        </div>
      </Card>
      <Card>
        <CardHeader title="Vị trí" actions={<Button size="sm" variant="outline" onClick={() => onLocate(s.gpsDevice ?? c.location)}><MapPin className="h-4 w-4" /> Định vị theo GPS</Button>} />
        <div className="px-4 py-2">
          <KV label="Tọa độ khai báo" value={`${c.location.lat.toFixed(6)}, ${c.location.lng.toFixed(6)}`} />
          <KV label="GPS thiết bị" value={s.gpsDevice ? `${s.gpsDevice.lat.toFixed(6)}, ${s.gpsDevice.lng.toFixed(6)}` : 'Chưa có fix GNSS'} />
          <KV label="Lệch" value={gpsDiff !== null && gpsDiff !== undefined ? <span className={gpsDiff > 200 ? 'text-st-offline' : ''}>{gpsDiff} m</span> : '—'} />
          <KV label="Zone 1 / Zone 2" value={`${c.zone1Id ?? '—'} / ${c.zone2Id ?? '—'}`} />
        </div>
        <div className="flex items-center justify-between gap-2 border-t px-4 py-2">
          <span className="text-xs text-subtle">Vị trí trên bản đồ là tọa độ khai báo, không tự đổi theo GPS.</span>
          <RelocateGpsButton cabinetId={c.id} label={`${c.code} - ${c.name}`} onLocate={onLocate} />
        </div>
      </Card>
      <Card>
        <CardHeader title="Hành chính" />
        <div className="px-4 py-2">
          <KV label="Địa chỉ" value={c.address} />
          <KV label="Đường" value={c.street} />
          <KV label="Phường" value={detail.cabinet.wardName} />
          <KV label="Quận" value={detail.cabinet.districtName} />
          <KV label="Khu quản lý" value={c.managementUnitId ?? '—'} />
        </div>
      </Card>
      <Card>
        <CardHeader title="Ảnh thực tế của tủ" actions={can && <Button size="sm" variant="outline" onClick={() => toast('Upload ảnh sẽ nối API ở M4 (mock)')}><Upload className="h-4 w-4" /> Tải ảnh</Button>} />
        <div className="flex h-40 items-center justify-center text-subtle">
          <div className="flex flex-col items-center gap-1 text-sm">
            <Camera className="h-8 w-8" />
            Chưa có ảnh
          </div>
        </div>
      </Card>
    </div>
  );
}

// ---------- Cảnh báo của tủ ----------

export function CabinetAlarmsTab({ cabinetId }: { cabinetId: string }) {
  const { data, isLoading } = useQuery({ queryKey: ['cabinet-alarms', cabinetId], queryFn: () => api.cabinetAlarms(cabinetId, 20) });
  if (isLoading) return <Spinner />;
  if (!data?.length) return <Empty>Tủ chưa có cảnh báo nào</Empty>;
  return (
    <Card>
      <CardHeader title="20 cảnh báo gần nhất" />
      <table className="w-full text-sm">
        <thead className="bg-muted/60 text-left text-xs text-subtle">
          <tr>
            <th className="px-3 py-2">Mã</th>
            <th className="px-3 py-2">Nội dung</th>
            <th className="px-3 py-2">Mức</th>
            <th className="px-3 py-2">Thời điểm</th>
            <th className="px-3 py-2">Kéo dài</th>
          </tr>
        </thead>
        <tbody>
          {data.map((a) => (
            <tr key={a.id} className="border-t">
              <td className="px-3 py-2">
                <ErrorCodeBadge type={a.type} code={a.code} />
              </td>
              <td className="px-3 py-2">
                <div className="font-medium">{ALARM_TYPE_LABELS[a.type]}</div>
                <div className="text-xs text-subtle">{a.message}</div>
              </td>
              <td className="px-3 py-2">
                <Badge tone={a.severity === 'critical' ? 'red' : a.severity === 'major' ? 'orange' : 'amber'}>{SEVERITY_LABELS[a.severity]}</Badge>
                {a.active && <Badge tone="red" className="ml-1">Đang diễn ra</Badge>}
              </td>
              <td className="px-3 py-2 text-xs">{fmtTime(a.startedAt)}</td>
              <td className="px-3 py-2 text-xs">{fmtDuration(a.startedAt, a.endedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

// ---------- Lịch sử lệnh ----------

export function CommandsTab({ cabinetId }: { cabinetId: string }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['cabinet-commands', cabinetId], queryFn: () => api.cabinetCommands(cabinetId) });
  useEffect(
    () =>
      subscribe<Command>('command.updated', (c) => {
        if (c.cabinetId !== cabinetId) return;
        qc.setQueryData<Command[]>(['cabinet-commands', cabinetId], (list = []) =>
          list.some((x) => x.id === c.id) ? list.map((x) => (x.id === c.id ? c : x)) : [c, ...list],
        );
      }),
    [cabinetId, qc],
  );
  const tone = (s: string) => (s === 'confirmed' ? 'green' : s === 'failed' || s === 'timeout' ? 'red' : s === 'acked_unconfirmed' ? 'amber' : 'blue');
  if (isLoading) return <Spinner />;
  if (!data?.length) return <Empty>Chưa có lệnh nào gửi tới tủ này. Thử gửi lệnh ở tab Điều khiển.</Empty>;
  return (
    <Card>
      <CardHeader title="Lịch sử lệnh" />
      <div className="divide-y">
        {data.map((c) => (
          <div key={c.id} className="px-4 py-2 text-sm">
            <div className="flex items-center justify-between gap-2">
              <b>{describeCommand(c.type, c.params)}</b>
              <Badge tone={tone(c.status) as 'green'}>{COMMAND_STATUS_LABELS[c.status]}</Badge>
            </div>
            <div className="text-xs text-subtle">
              {c.requestedBy} · gửi {fmtTime(c.queuedAt)}
              {c.confirmedAt && ` · xác nhận ${fmtTime(c.confirmedAt)}`}
              {c.error && <span className="text-st-offline"> · {c.error}</span>}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

export { ApiError };
