import type { CabinetState } from '@citylight/shared';
import { fmtNum } from '@/lib/utils';
import { cn } from '@/lib/utils';

/**
 * Single-line diagram of the cabinet: 3-phase supply → main breaker → power meter + leakage CT on the bus
 * → contactors K1/K2 → branch 1 / branch 2 lamps. Controller block (4G / PLC / mode) drives the contactors.
 * Everything is drawn from live state; values the firmware does not send yet show "—".
 */

type Tri = boolean | null;

const PHASES = [
  { key: 'L1', v: 'vL1', i: 'iL1', cls: 'stroke-[#ef4444]', txt: 'fill-[#ef4444]' },
  { key: 'L2', v: 'vL2', i: 'iL2', cls: 'stroke-[#eab308]', txt: 'fill-[#eab308]' },
  { key: 'L3', v: 'vL3', i: 'iL3', cls: 'stroke-[#3b82f6]', txt: 'fill-[#3b82f6]' },
] as const;

function wire(on: Tri) {
  return on === null ? 'stroke-st-unknown' : on ? 'stroke-st-on' : 'stroke-subtle/60';
}

/** Contactor: two terminals and a blade; closed = straight, open = lifted. */
function Contactor({ x, y, label, closed }: { x: number; y: number; label: string; closed: Tri }) {
  const cls = wire(closed);
  return (
    <g>
      <circle cx={x} cy={y} r={3.5} className={cn('fill-panel', cls)} strokeWidth={2} />
      <circle cx={x + 40} cy={y} r={3.5} className={cn('fill-panel', cls)} strokeWidth={2} />
      {closed === null ? (
        <line x1={x + 3} y1={y} x2={x + 37} y2={y} className={cls} strokeWidth={2.5} strokeDasharray="4 4" />
      ) : closed ? (
        <line x1={x + 3} y1={y} x2={x + 37} y2={y} className={cls} strokeWidth={3} strokeLinecap="round" />
      ) : (
        <line x1={x + 3} y1={y} x2={x + 35} y2={y - 16} className={cls} strokeWidth={3} strokeLinecap="round" />
      )}
      <rect x={x + 8} y={y + 14} width={24} height={14} rx={2} className="fill-muted stroke-border" strokeWidth={1.5} />
      <text x={x + 20} y={y + 24.5} textAnchor="middle" className="fill-fg text-[9px] font-semibold">
        {label}
      </text>
    </g>
  );
}

function Lamp({ x, y, on }: { x: number; y: number; on: Tri }) {
  return (
    <g>
      {on && <circle cx={x + 9} cy={y - 26} r={13} className="fill-[#fde047]" opacity={0.35} />}
      <path d={`M${x} ${y} V${y - 28} q0 -6 6 -6 h7`} className="fill-none stroke-subtle" strokeWidth={2.5} strokeLinecap="round" />
      <path d={`M${x + 4} ${y - 35} h12 l-2 5 h-8 z`} className="fill-fg/80" />
      <ellipse cx={x + 10} cy={y - 28.5} rx={4.5} ry={2.4} className={on ? 'fill-[#facc15]' : on === null ? 'fill-st-unknown/60' : 'fill-subtle/40'} />
      <rect x={x - 5} y={y} width={10} height={3} rx={1} className="fill-subtle" />
    </g>
  );
}

function Badge({ x, y, w, label, value, ok }: { x: number; y: number; w: number; label: string; value: string; ok: Tri }) {
  const dot = ok === null ? 'fill-st-unknown' : ok ? 'fill-st-on' : 'fill-st-offline';
  return (
    <g>
      <rect x={x} y={y} width={w} height={34} rx={6} className="fill-muted stroke-border" strokeWidth={1} />
      <circle cx={x + 12} cy={y + 17} r={4.5} className={dot} />
      <text x={x + 23} y={y + 14} className="fill-subtle text-[9px]">
        {label}
      </text>
      <text x={x + 23} y={y + 27} className="fill-fg text-[11px] font-semibold">
        {value}
      </text>
    </g>
  );
}

export function CabinetDiagram({ state: s, code }: { state: CabinetState; code: string }) {
  const online = s.online;
  const supply = online && s.pmOnline !== false && (s.vL1 ?? 0) > 50;
  const b1: Tri = s.branch1On;
  const b2: Tri = s.branch2On;
  const anyOn = !!(b1 || b2);
  const flow = (on: Tri) => (on ? 'diagram-flow' : '');
  const leakHigh = s.leakMa !== null && s.leakMa > 30;

  return (
    <div className="relative">
      <svg viewBox="0 0 1000 320" className={cn('h-auto w-full select-none', !online && 'opacity-60')} role="img" aria-label={`Sơ đồ tủ ${code}`}>
        {/* ---------- supply ---------- */}
        <text x={14} y={70} className="fill-subtle text-[10px] font-semibold uppercase tracking-wide">
          Lưới 3 pha
        </text>
        {PHASES.map((p, i) => {
          const y = 104 + i * 18;
          return (
            <g key={p.key}>
              <line x1={14} y1={y} x2={190} y2={y} className={cn(p.cls, supply ? '' : 'opacity-40')} strokeWidth={2.5} />
              <text x={14} y={y - 4} className={cn(p.txt, 'text-[10px] font-semibold')}>
                {p.key}
              </text>
              <text x={36} y={y - 4} className="fill-fg text-[10px] tabular-nums">
                {fmtNum(s[p.v], 1, 'V')}
              </text>
            </g>
          );
        })}

        {/* ---------- enclosure ---------- */}
        <rect x={150} y={30} width={660} height={276} rx={14} className="fill-muted/30 stroke-border" strokeWidth={2} />
        <rect x={150} y={30} width={660} height={28} rx={14} className="fill-muted" />
        <rect x={150} y={44} width={660} height={14} className="fill-muted" />
        <text x={168} y={49} className="fill-fg text-[12px] font-semibold">
          Tủ điều khiển chiếu sáng · {code}
        </text>
        {/* door */}
        <g transform="translate(700 36)">
          <rect x={0} y={0} width={14} height={18} rx={1.5} className="fill-none stroke-subtle" strokeWidth={1.5} />
          <circle cx={10.5} cy={9} r={1.3} className="fill-subtle" />
          <text x={20} y={13} className="fill-subtle text-[10px]">
            Cửa: {s.doorOpen === null ? 'chưa hỗ trợ' : s.doorOpen ? 'đang mở' : 'đóng'}
          </text>
        </g>

        {/* main breaker */}
        <rect x={190} y={92} width={44} height={60} rx={5} className={cn('fill-panel', supply ? 'stroke-st-on' : 'stroke-subtle')} strokeWidth={2} />
        <path d="M200 132 l12 -18 M212 114 l10 0" className={supply ? 'stroke-st-on' : 'stroke-subtle'} strokeWidth={2.2} strokeLinecap="round" fill="none" />
        <text x={212} y={168} textAnchor="middle" className="fill-fg text-[10px] font-medium">
          CB tổng
        </text>

        {/* bus from breaker to busbar */}
        <line x1={234} y1={122} x2={560} y2={122} className={cn(supply ? 'stroke-st-on' : 'stroke-subtle/60', flow(anyOn))} strokeWidth={5} strokeLinecap="round" />

        {/* power meter tap (above bus) */}
        <line x1={318} y1={122} x2={318} y2={112} className="stroke-subtle" strokeWidth={1.5} />
        <rect x={262} y={66} width={112} height={46} rx={7} className="fill-panel stroke-border" strokeWidth={1.5} />
        <circle cx={364} cy={76} r={4} className={s.pmOnline === false ? 'fill-st-offline' : s.pmOnline ? 'fill-st-on' : 'fill-st-unknown'} />
        <text x={272} y={80} className="fill-subtle text-[9px]">
          Đồng hồ điện
        </text>
        <text x={272} y={100} className="fill-fg text-[15px] font-bold tabular-nums">
          {fmtNum(s.pTotalKw, 1)}
          <tspan className="fill-subtle text-[10px] font-normal"> kW</tspan>
        </text>
        <text x={335} y={100} className="fill-subtle text-[10px] tabular-nums">
          cosφ {fmtNum(s.pfTotal, 2)}
        </text>

        {/* leakage CT ring (on bus) + box below */}
        <ellipse cx={440} cy={122} rx={9} ry={15} className={cn('fill-none', leakHigh ? 'stroke-st-offline' : 'stroke-primary')} strokeWidth={2.5} />
        <line x1={440} y1={137} x2={440} y2={150} className="stroke-subtle" strokeWidth={1.5} />
        <rect x={390} y={150} width={100} height={46} rx={7} className={cn('fill-panel', leakHigh ? 'stroke-st-offline' : 'stroke-border')} strokeWidth={1.5} />
        <text x={400} y={164} className="fill-subtle text-[9px]">
          Rò dòng · nhiệt độ
        </text>
        <text x={400} y={184} className={cn('text-[13px] font-bold tabular-nums', leakHigh ? 'fill-st-offline' : 'fill-fg')}>
          {fmtNum(s.leakMa, 0)}
          <tspan className="fill-subtle text-[9px] font-normal"> mA</tspan>
          <tspan dx={8} className="fill-fg text-[12px] font-semibold">
            {fmtNum(s.tempC, 0)}
          </tspan>
          <tspan className="fill-subtle text-[9px] font-normal"> °C</tspan>
        </text>

        {/* busbar */}
        <line x1={560} y1={90} x2={560} y2={200} className={supply ? 'stroke-st-on' : 'stroke-subtle/60'} strokeWidth={6} strokeLinecap="round" />

        {/* branch feeders */}
        {[
          { y: 96, on: b1, k: 'K1', n: 1 },
          { y: 192, on: b2, k: 'K2', n: 2 },
        ].map((b) => (
          <g key={b.k}>
            <line x1={560} y1={b.y} x2={600} y2={b.y} className={supply ? 'stroke-st-on' : 'stroke-subtle/60'} strokeWidth={3} />
            <Contactor x={600} y={b.y} label={b.k} closed={b.on} />
            <line x1={640} y1={b.y} x2={840} y2={b.y} className={cn(wire(b.on), flow(b.on))} strokeWidth={3} strokeLinecap="round" />
            <text x={660} y={b.y - 8} className="fill-fg text-[11px] font-semibold">
              Nhánh {b.n}
            </text>
            <text x={714} y={b.y - 8} className={cn('text-[10px]', b.on ? 'fill-st-on' : b.on === null ? 'fill-st-unknown' : 'fill-subtle')}>
              {b.on === null ? 'không rõ' : b.on ? 'đang sáng' : 'tắt'}
            </text>
            {[860, 905, 950].map((x) => (
              <g key={x}>
                <line x1={x - 20} y1={b.y} x2={x} y2={b.y} className={cn(wire(b.on), flow(b.on))} strokeWidth={3} />
                <g transform={`translate(${x} ${b.y}) scale(1.25) translate(${-x} ${-b.y})`}>
                  <Lamp x={x} y={b.y} on={b.on} />
                </g>
              </g>
            ))}
          </g>
        ))}

        {/* controller block + control lines to contactor coils */}
        <path d="M502 252 H585 V117 H608 M585 213 H608" className="fill-none stroke-primary/70" strokeWidth={1.5} strokeDasharray="4 3" />
        <rect x={168} y={218} width={334} height={74} rx={9} className="fill-panel stroke-primary/60" strokeWidth={1.5} />
        <text x={180} y={234} className="fill-subtle text-[9px] font-semibold uppercase tracking-wide">
          Bộ điều khiển
        </text>
        <Badge x={178} y={243} w={100} label="Kết nối 4G" value={online ? 'Online' : 'Mất kết nối'} ok={online} />
        <Badge x={284} y={243} w={100} label="PLC LOGO" value={s.plcOnline === null ? '—' : s.plcOnline ? 'Hoạt động' : 'Mất kết nối'} ok={s.plcOnline} />
        <Badge
          x={390}
          y={243}
          w={104}
          label="Chế độ"
          value={s.manualMode === null ? '—' : s.manualMode ? 'Thủ công' : 'Tự động'}
          ok={s.manualMode === null ? null : true}
        />

        {/* earth */}
        <g transform="translate(770 272)">
          <line x1={0} y1={-14} x2={0} y2={0} className="stroke-subtle" strokeWidth={1.5} />
          <line x1={-9} y1={0} x2={9} y2={0} className="stroke-subtle" strokeWidth={1.8} />
          <line x1={-6} y1={4} x2={6} y2={4} className="stroke-subtle" strokeWidth={1.8} />
          <line x1={-3} y1={8} x2={3} y2={8} className="stroke-subtle" strokeWidth={1.8} />
        </g>
      </svg>
      {!online && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="rounded-md bg-st-offline px-3 py-1 text-sm font-medium text-white shadow">Mất kết nối — hiển thị số liệu cuối cùng</span>
        </div>
      )}
    </div>
  );
}
