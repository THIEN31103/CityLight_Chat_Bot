import { useMemo } from 'react';
import type { DimmingProfile, DimmingSegment } from '@citylight/shared';
import { estimateDimming, minutesToHhmm } from '@citylight/shared';
import { EChart } from './EChart';
import { Checkbox } from './ui';
import { fill, locale, useDict } from '@/i18n';
import { DIMMING_EDITOR } from '@/i18n/dict/dimming-editor';

const MIN = 1020; // 17:00
const MAX = 1800; // 06:00 next day

/** 5 chained dimming segments: segment k starts where k-1 ends; levels 0–100 %. Shows HH:MM, never raw minutes.
 *  `estimate` (from the API) carries the real lamp power of the group; savings are recomputed here while dragging. */
export function DimmingEditor({ segments, onChange, disabled, estimate }: { segments: DimmingSegment[]; onChange: (s: DimmingSegment[]) => void; disabled?: boolean; estimate?: DimmingProfile['estimate'] }) {
  const t = useDict(DIMMING_EDITOR);
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
        tooltip: {
          trigger: 'axis',
          // header in HH:MM (not raw minutes); a step edge shows both levels
          formatter: (ps: { value: [number, number] }[]) => `${minutesToHhmm(ps[0]!.value[0])}: ${ps.map((p) => `${p.value[1]}%`).join(' → ')}`,
        },
        xAxis: { type: 'value', min: MIN, max: MAX, interval: 60, axisLabel: { formatter: (v: number) => minutesToHhmm(v) } },
        yAxis: { type: 'value', min: 0, max: 100, axisLabel: { formatter: '{value}%' } },
        series: [{ type: 'line', step: false, areaStyle: { opacity: 0.2 }, data: pts, showSymbol: false, lineStyle: { color: '#d97706' }, itemStyle: { color: '#d97706' } }],
      },
    };
  }, [segments]);

  const est = estimate ? estimateDimming(segments, estimate.lamps, estimate.ratedW, estimate.pricePerKwh) : null;
  const n = (v: number) => v.toLocaleString(locale());

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        {segments.map((s, i) => (
          <div key={i} className="grid items-center gap-3 rounded-md border p-3 md:grid-cols-[150px_1fr_220px]">
            <Checkbox label={t.segment(i + 1)} checked={s.enabled} onChange={(v) => setSeg(i, { enabled: v })} disabled={disabled} />
            <div className="space-y-1">
              <div className="flex justify-between text-xs text-subtle">
                <span>{fill(t.start, { time: minutesToHhmm(s.startMin) })}</span>
                <span>{fill(t.end, { time: minutesToHhmm(s.endMin) })}</span>
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
                  aria-label={t.startAria(i + 1)}
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
                  aria-label={t.endAria(i + 1)}
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
                aria-label={t.levelAria(i + 1)}
              />
              <span className="w-12 text-right font-semibold tabular-nums">{s.levelPct}%</span>
            </div>
          </div>
        ))}
      </div>
      <div className="rounded-md border p-2">
        <div className="px-2 pt-1 text-sm font-medium">{t.preview}</div>
        <EChart option={option} height={200} />
        <div className="flex flex-wrap gap-4 px-2 pb-1 text-sm">
          <span>
            {t.saving} <b className="text-st-on">{savedPct.toFixed(1)}%</b>
          </span>
          {est && estimate && (estimate.lamps === 0 ? (
            <span className="text-subtle">{t.noLamps}</span>
          ) : (
            <span className="text-subtle">
              {t.lamps(est.lamps, n(est.lamps))} · {n(est.ratedKw)} kW → ≈ <b className="text-fg">{fill(t.kwhPerNight, { v: n(est.kwhPerNight) })}</b> · {fill(t.kwhPerYear, { v: n(est.kwhPerYear) })}
              {est.vndPerYear !== null && <> · <b className="text-fg">{fill(t.moneyPerYear, { v: n(est.vndPerYear) })}</b> {fill(t.price, { v: n(estimate.pricePerKwh!) })}</>}
              {estimate.lampsWithoutPower > 0 && <> · {t.lampsWithoutPower(estimate.lampsWithoutPower, n(estimate.lampsWithoutPower))}</>}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
