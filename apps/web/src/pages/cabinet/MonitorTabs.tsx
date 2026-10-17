import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import type { CabinetDetail } from '@citylight/shared';
import { api } from '@/lib/api';
import { fmtNum } from '@/lib/utils';
import { EChart } from '@/components/EChart';
import { Badge, Card, CardHeader, Checkbox, Select, Spinner, Unsupported } from '@/components/ui';

function Metric({ label, value, unit, hint }: { label: string; value: number | null; unit?: string; hint?: string }) {
  return (
    <div className="rounded-md border p-3" title={hint}>
      <div className="text-xs text-subtle">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">
        {fmtNum(value, unit === '' ? 2 : 1)}
        {value !== null && unit ? <span className="ml-1 text-xs font-normal text-subtle">{unit}</span> : null}
      </div>
      {value === null && hint && <div className="text-[10px] text-subtle">{hint}</div>}
    </div>
  );
}

const FW = 'Chờ firmware';

export function MonitorTab({ detail }: { detail: CabinetDetail }) {
  const s = detail.state;
  return (
    <div className="space-y-4">
      {!s.online && <div className="rounded-md bg-st-offline/10 px-3 py-2 text-sm text-st-offline">Tủ đang mất kết nối — số liệu dưới đây là giá trị cuối cùng nhận được.</div>}
      <Card>
        <CardHeader title="Tổng" subtitle={`Đồng hồ điện: ${s.pmOnline ? 'đang kết nối' : 'mất kết nối'}`} />
        <div className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-4">
          <Metric label="cos φ tổng" value={s.pfTotal} unit="" />
          <Metric label="Công suất thực 3 pha" value={s.pTotalKw} unit="kW" />
          <Metric label="Công suất biểu kiến 3 pha" value={s.sTotalKva} unit="kVA" hint={FW} />
          <Metric label="Công suất phản kháng 3 pha" value={s.qTotalKvar} unit="kVAr" hint={FW} />
          <Metric label="Tổng điện năng" value={s.energyKwh} unit="kWh" hint={FW} />
          <Metric label="Năng lượng biểu kiến" value={null} unit="kVAh" hint={FW} />
          <Metric label="Năng lượng phản kháng" value={null} unit="kVArh" hint={FW} />
          <Metric label="Tần số" value={s.freqHz} unit="Hz" hint={FW} />
        </div>
      </Card>
      <Card>
        <CardHeader title="Theo pha" />
        <div className="overflow-x-auto p-4">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-subtle">
              <tr>
                <th className="py-1">Pha</th>
                <th>Điện áp (V)</th>
                <th>Dòng (A)</th>
                <th>cos φ</th>
                <th>P (kW)</th>
                <th>S (kVA)</th>
                <th>Q (kVAr)</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {[1, 2, 3].map((p) => (
                <tr key={p} className="border-t">
                  <td className="py-1.5 font-medium">L{p}</td>
                  <td>{fmtNum(s[`vL${p}` as 'vL1'])}</td>
                  <td>{fmtNum(s[`iL${p}` as 'iL1'])}</td>
                  <td>{fmtNum(s[`pfL${p}` as 'pfL1'], 2)}</td>
                  <td className="text-subtle">—</td>
                  <td className="text-subtle">—</td>
                  <td className="text-subtle">—</td>
                </tr>
              ))}
              <tr className="border-t text-subtle">
                <td className="py-1.5">I trung bình</td>
                <td />
                <td className="text-fg">{fmtNum(s.iL1 !== null && s.iL2 !== null && s.iL3 !== null ? (s.iL1 + s.iL2 + s.iL3) / 3 : null)}</td>
                <td colSpan={4} />
              </tr>
            </tbody>
          </table>
          <div className="mt-2">
            <Unsupported>P / S / Q từng pha cần firmware gửi thêm (đồng hồ DH đã có số liệu)</Unsupported>
          </div>
        </div>
      </Card>
    </div>
  );
}

const RANGES = [
  { v: '6h', label: '6 giờ', ms: 6 * 3600e3 },
  { v: '24h', label: '24 giờ', ms: 24 * 3600e3 },
  { v: '7d', label: '7 ngày', ms: 7 * 86400e3 },
  { v: '30d', label: '30 ngày', ms: 30 * 86400e3 },
];

export function ChartTab({ cabinetId, metrics, names, unit, title }: { cabinetId: string; metrics: string[]; names: string[]; unit: string; title: string }) {
  const [range, setRange] = useState('24h');
  const [paused, setPaused] = useState(false);
  const ms = RANGES.find((r) => r.v === range)!.ms;
  const { data, isLoading } = useQuery({
    queryKey: ['telemetry', cabinetId, metrics.join(','), range],
    queryFn: () => {
      const to = new Date();
      return api.telemetry(cabinetId, metrics, new Date(to.getTime() - ms).toISOString(), to.toISOString());
    },
    refetchInterval: paused ? false : 10000,
  });
  const option = useMemo(
    () => ({
      tooltip: { trigger: 'axis' },
      legend: { top: 0 },
      grid: { left: 48, right: 16, top: 32, bottom: 56 },
      dataZoom: [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 8 }],
      xAxis: { type: 'time' },
      yAxis: { type: 'value', name: unit, scale: true },
      series: metrics.map((m, i) => ({ name: names[i], type: 'line', showSymbol: false, data: (data ?? []).map((p) => [p.ts, p[m]]) })),
    }),
    [data, metrics, names, unit],
  );
  return (
    <Card>
      <CardHeader
        title={title}
        actions={
          <>
            <Checkbox label="Tạm dừng" checked={paused} onChange={setPaused} />
            <Select value={range} onChange={(e) => setRange(e.target.value)}>
              {RANGES.map((r) => (
                <option key={r.v} value={r.v}>
                  {r.label}
                </option>
              ))}
            </Select>
          </>
        }
      />
      <div className="p-2">{isLoading ? <div className="flex h-72 items-center justify-center"><Spinner /></div> : <EChart option={option} height={320} />}</div>
    </Card>
  );
}

export function EnergyTab({ cabinetId }: { cabinetId: string }) {
  const day = useQuery({ queryKey: ['energy', cabinetId, 'day'], queryFn: () => api.energy(cabinetId, 'day') });
  const month = useQuery({ queryKey: ['energy', cabinetId, '30d'], queryFn: () => api.energy(cabinetId, '30d') });
  const bar = (pts: { label: string; kwh: number }[] | undefined, color: string) => ({
    tooltip: { trigger: 'axis' },
    grid: { left: 48, right: 16, top: 16, bottom: 32 },
    xAxis: { type: 'category', data: (pts ?? []).map((p) => p.label) },
    yAxis: { type: 'value', name: 'kWh' },
    series: [{ type: 'bar', data: (pts ?? []).map((p) => p.kwh), itemStyle: { color } }],
  });
  return (
    <div className="space-y-4">
      {day.data?.estimated && <Unsupported>Giá trị ước lượng từ công suất (tích phân MPOW). Số chính xác khi firmware gửi bộ đếm kWh.</Unsupported>}
      <Card>
        <CardHeader title={`Điện năng theo giờ — hôm nay ${dayjs().format('DD/MM')}`} actions={<Badge tone="amber">Ước lượng</Badge>} />
        <div className="p-2">
          <EChart option={bar(day.data?.points, '#3b82f6')} height={240} />
        </div>
      </Card>
      <Card>
        <CardHeader title="Điện năng theo ngày — 30 ngày gần nhất" actions={<Badge tone="amber">Ước lượng</Badge>} />
        <div className="p-2">
          <EChart option={bar(month.data?.points, '#16a34a')} height={240} />
        </div>
      </Card>
    </div>
  );
}

export function LeakTempTab({ detail }: { detail: CabinetDetail }) {
  const s = detail.state;
  const t = detail.thresholds;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2">
        <Card className="p-4">
          <div className="text-xs text-subtle">Dòng rò (CT)</div>
          <div className={`text-2xl font-semibold ${s.leakMa !== null && s.leakMa > t.leakMa.value ? 'text-st-offline' : ''}`}>{fmtNum(s.leakMa, 0, 'mA')}</div>
          <div className="text-xs text-subtle">Ngưỡng cảnh báo {t.leakMa.value} mA</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-subtle">Nhiệt độ tủ (DS18B20)</div>
          <div className={`text-2xl font-semibold ${s.tempC !== null && s.tempC > t.tempC.value ? 'text-st-offline' : ''}`}>{fmtNum(s.tempC, 0, '°C')}</div>
          <div className="text-xs text-subtle">Ngưỡng cảnh báo {t.tempC.value} °C</div>
        </Card>
      </div>
      <ChartTab cabinetId={detail.cabinet.id} metrics={['leakMa']} names={['Dòng rò']} unit="mA" title="Dòng rò theo thời gian" />
      <ChartTab cabinetId={detail.cabinet.id} metrics={['tempC']} names={['Nhiệt độ']} unit="°C" title="Nhiệt độ tủ theo thời gian" />
    </div>
  );
}
