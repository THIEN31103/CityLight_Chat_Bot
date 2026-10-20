import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import type { CabinetDetail } from '@citylight/shared';
import { api } from '@/lib/api';
import { fmtNum } from '@/lib/utils';
import { EChart } from '@/components/EChart';
import { Badge, Card, CardHeader, Checkbox, Select, Spinner, Unsupported } from '@/components/ui';
import { fill, useDict } from '@/i18n';
import { CABINET } from '@/i18n/dict/cabinet';

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

export function MonitorTab({ detail }: { detail: CabinetDetail }) {
  const t = useDict(CABINET).monitor;
  const FW = t.waitFw;
  const s = detail.state;
  return (
    <div className="space-y-4">
      {!s.online && <div className="rounded-md bg-st-offline/10 px-3 py-2 text-sm text-st-offline">{t.offline}</div>}
      <Card>
        <CardHeader title={t.totalTitle} subtitle={fill(t.meter, { state: s.pmOnline ? t.meterOn : t.meterOff })} />
        <div className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-4">
          <Metric label={t.pfTotal} value={s.pfTotal} unit="" />
          <Metric label={t.pTotal} value={s.pTotalKw} unit="kW" />
          <Metric label={t.sTotal} value={s.sTotalKva} unit="kVA" hint={FW} />
          <Metric label={t.qTotal} value={s.qTotalKvar} unit="kVAr" hint={FW} />
          <Metric label={t.energy} value={s.energyKwh} unit="kWh" hint={FW} />
          <Metric label={t.apparentEnergy} value={null} unit="kVAh" hint={FW} />
          <Metric label={t.reactiveEnergy} value={null} unit="kVArh" hint={FW} />
          <Metric label={t.freq} value={s.freqHz} unit="Hz" hint={FW} />
        </div>
      </Card>
      <Card>
        <CardHeader title={t.perPhase} />
        <div className="overflow-x-auto p-4">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-subtle">
              <tr>
                <th className="py-1">{t.colPhase}</th>
                <th>{t.colVoltage}</th>
                <th>{t.colCurrent}</th>
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
                <td className="py-1.5">{t.avgCurrent}</td>
                <td />
                <td className="text-fg">{fmtNum(s.iL1 !== null && s.iL2 !== null && s.iL3 !== null ? (s.iL1 + s.iL2 + s.iL3) / 3 : null)}</td>
                <td colSpan={4} />
              </tr>
            </tbody>
          </table>
          <div className="mt-2">
            <Unsupported>{t.perPhaseUnsupported}</Unsupported>
          </div>
        </div>
      </Card>
    </div>
  );
}

// label: CABINET.chart.ranges[v]
const RANGES = [
  { v: '6h', ms: 6 * 3600e3 },
  { v: '24h', ms: 24 * 3600e3 },
  { v: '7d', ms: 7 * 86400e3 },
  { v: '30d', ms: 30 * 86400e3 },
] as const;

export function ChartTab({ cabinetId, metrics, names, unit, title }: { cabinetId: string; metrics: string[]; names: string[]; unit: string; title: string }) {
  const t = useDict(CABINET).chart;
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
            <Checkbox label={t.pause} checked={paused} onChange={setPaused} />
            <Select value={range} onChange={(e) => setRange(e.target.value)}>
              {RANGES.map((r) => (
                <option key={r.v} value={r.v}>
                  {t.ranges[r.v]}
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
  const t = useDict(CABINET).energy;
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
      {day.data?.estimated && <Unsupported>{t.estimatedNote}</Unsupported>}
      <Card>
        <CardHeader title={fill(t.hourly, { date: dayjs().format('DD/MM') })} actions={<Badge tone="amber">{t.estimated}</Badge>} />
        <div className="p-2">
          <EChart option={bar(day.data?.points, '#3b82f6')} height={240} />
        </div>
      </Card>
      <Card>
        <CardHeader title={t.daily} actions={<Badge tone="amber">{t.estimated}</Badge>} />
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
  const d = useDict(CABINET).leak;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2">
        <Card className="p-4">
          <div className="text-xs text-subtle">{d.leak}</div>
          <div className={`text-2xl font-semibold ${s.leakMa !== null && s.leakMa > t.leakMa.value ? 'text-st-offline' : ''}`}>{fmtNum(s.leakMa, 0, 'mA')}</div>
          <div className="text-xs text-subtle">{d.threshold} {t.leakMa.value} mA</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-subtle">{d.temp}</div>
          <div className={`text-2xl font-semibold ${s.tempC !== null && s.tempC > t.tempC.value ? 'text-st-offline' : ''}`}>{fmtNum(s.tempC, 0, '°C')}</div>
          <div className="text-xs text-subtle">{d.threshold} {t.tempC.value} °C</div>
        </Card>
      </div>
      <ChartTab cabinetId={detail.cabinet.id} metrics={['leakMa']} names={[d.leakSeries]} unit="mA" title={d.leakTitle} />
      <ChartTab cabinetId={detail.cabinet.id} metrics={['tempC']} names={[d.tempSeries]} unit="°C" title={d.tempTitle} />
    </div>
  );
}
