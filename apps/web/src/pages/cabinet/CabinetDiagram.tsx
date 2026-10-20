import type { CabinetState } from '@citylight/shared';
import { cn } from '@/lib/utils';
import { fill, useDict } from '@/i18n';
import { CABINET } from '@/i18n/dict/cabinet';

/**
 * Pictorial view of the cabinet: the cabinet front (door, handle, indicator window) and its two
 * lighting branches as street-light lines. Indicator LEDs: supply, 4G, PLC, branch 1, branch 2, fault.
 */

type Tri = boolean | null;

const W = 1000;
const LINES = [
  { n: 1, ground: 138, exitY: 138 },
  { n: 2, ground: 276, exitY: 240 },
];
const POLES = [400, 545, 690, 835, 965];

function Led({ x, y, on, color, label }: { x: number; y: number; on: Tri; color: string; label: string }) {
  const fill = on === null ? '#475569' : on ? color : '#1e293b';
  return (
    <g>
      {on && <circle cx={x} cy={y} r={11} fill={color} opacity={0.28} />}
      <circle cx={x} cy={y} r={6.5} fill={fill} stroke="#0b1220" strokeWidth={1.5} />
      {on && <circle cx={x - 2} cy={y - 2} r={1.8} fill="#fff" opacity={0.7} />}
      <text x={x} y={y + 18} textAnchor="middle" fill="#cbd5e1" style={{ fontSize: 8, fontWeight: 600, letterSpacing: 0.3 }}>
        {label}
      </text>
    </g>
  );
}

function StreetLight({ x, ground, on }: { x: number; ground: number; on: Tri }) {
  const top = ground - 86;
  const hx = x + 26;
  const hy = top + 4;
  return (
    <g>
      {on && <polygon points={`${hx - 7},${hy + 4} ${hx + 7},${hy + 4} ${hx + 40},${ground} ${hx - 40},${ground}`} fill="url(#beam)" />}
      <rect x={x - 7} y={ground - 4} width={14} height={4} rx={1.5} className="fill-subtle" />
      <path d={`M${x} ${ground - 4} V${top + 12} Q${x} ${top} ${x + 12} ${top} H${hx - 6}`} className="fill-none stroke-subtle" strokeWidth={3.5} strokeLinecap="round" />
      <path d={`M${hx - 12} ${top - 4} H${hx + 12} L${hx + 9} ${top + 4} H${hx - 9} Z`} className="fill-fg/80" />
      <ellipse cx={hx} cy={hy + 1} rx={8} ry={3} fill={on ? '#fde047' : on === null ? '#a78bfa' : '#64748b'} />
      {on && <circle cx={hx} cy={hy + 2} r={12} fill="#fde047" opacity={0.25} />}
    </g>
  );
}

function stateText(on: Tri, t: { unknown: string; on: string; off: string }) {
  return on === null ? t.unknown : on ? t.on : t.off;
}

export function CabinetDiagram({ state: s, code }: { state: CabinetState; code: string }) {
  const dict = useDict(CABINET);
  const t = dict.diagram;
  const online = s.online;
  const supply: Tri = !online ? null : s.pmOnline === false ? null : (s.vL1 ?? 0) > 50 || (s.vL2 ?? 0) > 50 || (s.vL3 ?? 0) > 50;
  const branches: Tri[] = [s.branch1On, s.branch2On];
  const fault = s.status === 'fault' || s.status === 'offline' || s.activeAlarmCount > 0;

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} 300`} className={cn('h-auto w-full select-none', !online && 'opacity-60 grayscale')} role="img" aria-label={fill(t.ariaLabel, { code })}>
        <defs>
          <linearGradient id="cab-body" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#94a3b8" />
            <stop offset="0.5" stopColor="#cbd5e1" />
            <stop offset="1" stopColor="#8b9bb0" />
          </linearGradient>
          <linearGradient id="cab-door" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#dbe2ea" />
            <stop offset="1" stopColor="#aab6c5" />
          </linearGradient>
          <linearGradient id="beam" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fde047" stopOpacity={0.55} />
            <stop offset="1" stopColor="#fde047" stopOpacity={0} />
          </linearGradient>
        </defs>

        {/* ---------- branch lines ---------- */}
        {LINES.map((l, i) => {
          const on = branches[i] ?? null;
          const cable = on === null ? 'stroke-st-unknown' : on ? 'stroke-[#f59e0b]' : 'stroke-subtle/70';
          const d =
            l.exitY === l.ground
              ? `M222 ${l.ground} H${W - 8}`
              : `M222 ${l.exitY} H250 Q262 ${l.exitY} 262 ${l.exitY + 12} V${l.ground - 12} Q262 ${l.ground} 274 ${l.ground} H${W - 8}`;
          return (
            <g key={l.n}>
              <rect x={262} y={l.ground} width={W - 270} height={7} rx={3} className="fill-muted" />
              <path d={d} className={cn('fill-none', cable, on && 'diagram-flow')} strokeWidth={4} strokeLinecap="round" strokeDasharray={on === null ? '6 6' : undefined} />
              <g transform={`translate(282 ${l.ground - 40})`}>
                <text x={0} y={0} className="fill-fg" style={{ fontSize: 15, fontWeight: 700 }}>
                  {t.branch(l.n)}
                </text>
                <rect x={0} y={8} width={78} height={20} rx={10} className={on === null ? 'fill-st-unknown/15' : on ? 'fill-st-on/15' : 'fill-muted'} />
                <circle cx={11} cy={18} r={4} className={on === null ? 'fill-st-unknown' : on ? 'fill-st-on' : 'fill-subtle'} />
                <text x={20} y={22} className={on === null ? 'fill-st-unknown' : on ? 'fill-st-on' : 'fill-subtle'} style={{ fontSize: 11, fontWeight: 600 }}>
                  {stateText(on, dict.branchState)}
                </text>
              </g>
              {POLES.map((x) => (
                <StreetLight key={x} x={x} ground={l.ground} on={on} />
              ))}
            </g>
          );
        })}

        {/* ---------- cabinet ---------- */}
        <ellipse cx={130} cy={290} rx={100} ry={7} className="fill-fg/10" />
        <rect x={48} y={266} width={164} height={18} rx={2} className="fill-fg/50" />
        <path d="M32 44 L44 26 H216 L228 44 Z" fill="#64748b" />
        <rect x={40} y={42} width={180} height={226} rx={6} fill="url(#cab-body)" stroke="#475569" strokeWidth={1.5} />
        <rect x={52} y={54} width={156} height={202} rx={4} fill="url(#cab-door)" stroke="#64748b" strokeWidth={1.2} />
        {/* hinge marks */}
        <rect x={49} y={80} width={5} height={16} rx={1.5} fill="#64748b" />
        <rect x={49} y={214} width={5} height={16} rx={1.5} fill="#64748b" />
        {/* handle + lock */}
        <rect x={190} y={138} width={9} height={38} rx={4} fill="#334155" />
        <circle cx={194.5} cy={186} r={3.2} fill="#1e293b" />
        {/* hazard sign */}
        <g transform="translate(130 64)">
          <path d="M0 0 L11 19 H-11 Z" fill="#facc15" stroke="#1e293b" strokeWidth={1.2} strokeLinejoin="round" />
          <path d="M1.5 5 L-2.5 12 H0.5 L-1 17 L3.5 9.5 H0.5 Z" fill="#1e293b" />
        </g>
        {/* indicator window */}
        <rect x={70} y={92} width={112} height={84} rx={6} fill="#0b1220" stroke="#334155" strokeWidth={2} />
        <Led x={92} y={110} on={supply} color="#22c55e" label={t.power} />
        <Led x={126} y={110} on={online} color="#3b82f6" label={t.lte} />
        <Led x={160} y={110} on={online ? s.plcOnline : null} color="#22c55e" label={t.plc} />
        <Led x={92} y={148} on={online ? branches[0] ?? null : null} color="#facc15" label={t.b1} />
        <Led x={126} y={148} on={online ? branches[1] ?? null : null} color="#facc15" label={t.b2} />
        <Led x={160} y={148} on={fault} color="#ef4444" label={t.fault} />
        {/* name plate */}
        <rect x={78} y={190} width={96} height={20} rx={3} fill="#f8fafc" stroke="#94a3b8" />
        <text x={126} y={204} textAnchor="middle" fill="#0f172a" style={{ fontSize: 10, fontWeight: 700 }}>
          {code}
        </text>
        <text x={126} y={224} textAnchor="middle" fill="#475569" style={{ fontSize: 8 }}>
          {s.manualMode === null ? '' : s.manualMode ? t.manualMode : t.autoMode}
        </text>
        {/* vents */}
        {[234, 240, 246].map((y) => (
          <line key={y} x1={84} y1={y} x2={168} y2={y} stroke="#7b8a9e" strokeWidth={2} strokeLinecap="round" />
        ))}
      </svg>
      {!online && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="rounded-md bg-st-offline px-3 py-1 text-sm font-medium text-white shadow">{t.offline}</span>
        </div>
      )}
    </div>
  );
}
