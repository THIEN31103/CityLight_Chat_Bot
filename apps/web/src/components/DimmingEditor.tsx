import { useMemo } from 'react';
import type { DimmingSegment } from '@citylight/shared';
import { minutesToHhmm } from '@citylight/shared';
import { EChart } from './EChart';
import { Checkbox } from './ui';

const MIN = 1020; // 17:00
const MAX = 1800; // 06:00 next day

/** 5 chained dimming segments: segment k starts where k-1 ends; levels 0–100 %. Shows HH:MM, never raw minutes. */
export function DimmingEditor({ segments, onChange, disabled, ratedKw = 10 }: { segments: DimmingSegment[]; onChange: (s: DimmingSegment[]) => void; disabled?: boolean; ratedKw?: number }) {
  const setSeg = (i: number, patch: Partial<DimmingSegment>) => {
    const next = segments.map((s) => ({ ...s }));
    Object.assign(next[i]!, patch);
    // keep the chain contiguous
    if (patch.endMin !== undefined && next[i + 1]) next[i + 1]!.startMin = next[i]!.endMin;
    if (patch.startMin !== undefined && next[i - 1]) next[i - 1]!.endMin = next[i]!.startMin;
    for (const s of next) if (s.endMin < s.startMin) s.endMin = s.startMin;
    onChange(next);
  };

  const { option, savedPct } = useMemo(() => {
    const pts: [number, number][] = [];
    let full = 0;
    let used = 0;
    for (const s of segments) {
      const lvl = s.enabled ? s.levelPct : 100;
      pts.push([s.startMin, lvl], [s.endMin, lvl]);
      const h = (s.endMin - s.startMin) / 60;
      full += h;
      used += (h * lvl) / 100;
    }
    return {
      savedPct: full ? (1 - used / full) * 100 : 0,
      option: {
        grid: { left: 40, right: 16, top: 16, bottom: 28 },
        tooltip: { trigger: 'axis', valueFormatter: (v: number) => `${v}%` },
        xAxis: { type: 'value', min: MIN, max: MAX, interval: 60, axisLabel: { formatter: (v: number) => minutesToHhmm(v) } },
        yAxis: { type: 'value', min: 0, max: 100, axisLabel: { formatter: '{value}%' } },
        series: [{ type: 'line', step: false, areaStyle: { opacity: 0.2 }, data: pts, showSymbol: false, lineStyle: { color: '#d97706' }, itemStyle: { color: '#d97706' } }],
      },
    };
  }, [segments]);

  const totalHours = segments.reduce((s, x) => s + (x.endMin - x.startMin) / 60, 0);

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        {segments.map((s, i) => (
          <div key={i} className="grid items-center gap-3 rounded-md border p-3 md:grid-cols-[150px_1fr_220px]">
            <Checkbox label={`Thời đoạn ${i + 1}`} checked={s.enabled} onChange={(v) => setSeg(i, { enabled: v })} disabled={disabled} />
            <div className="space-y-1">
              <div className="flex justify-between text-xs text-subtle">
                <span>Bắt đầu {minutesToHhmm(s.startMin)}</span>
                <span>Kết thúc {minutesToHhmm(s.endMin)}</span>
              </div>
              <div className="flex gap-2">
                <input
                  type="range"
                  min={MIN}
                  max={MAX}
                  step={15}
                  value={s.startMin}
                  disabled={disabled || i === 0}
                  onChange={(e) => setSeg(i, { startMin: Number(e.target.value) })}
                  className="w-full accent-[rgb(var(--primary))]"
                  aria-label={`Bắt đầu thời đoạn ${i + 1}`}
                />
                <input
                  type="range"
                  min={MIN}
                  max={MAX}
                  step={15}
                  value={s.endMin}
                  disabled={disabled}
                  onChange={(e) => setSeg(i, { endMin: Number(e.target.value) })}
                  className="w-full accent-[rgb(var(--primary))]"
                  aria-label={`Kết thúc thời đoạn ${i + 1}`}
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={s.levelPct}
                disabled={disabled || !s.enabled}
                onChange={(e) => setSeg(i, { levelPct: Number(e.target.value) })}
                className="w-full accent-[rgb(var(--st-dimming))]"
                aria-label={`Mức năng lượng thời đoạn ${i + 1}`}
              />
              <span className="w-12 text-right font-semibold tabular-nums">{s.levelPct}%</span>
            </div>
          </div>
        ))}
      </div>
      <div className="rounded-md border p-2">
        <div className="px-2 pt-1 text-sm font-medium">Xem trước mức sáng trong đêm</div>
        <EChart option={option} height={200} />
        <div className="flex flex-wrap gap-4 px-2 pb-1 text-sm">
          <span>
            Tiết kiệm ước tính: <b className="text-st-on">{savedPct.toFixed(1)}%</b>
          </span>
          <span className="text-subtle">≈ {((savedPct / 100) * ratedKw * totalHours).toFixed(1)} kWh/đêm/tủ (giả định {ratedKw} kW)</span>
        </div>
      </div>
    </div>
  );
}
