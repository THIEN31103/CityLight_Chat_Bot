import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ChevronDown, ChevronRight, Eye, EyeOff } from 'lucide-react';
import type { Area, CabinetStatus, CabinetSummary, GeoPoint } from '@citylight/shared';
import { api } from '@/lib/api';
import { fill, useDict, useLabels } from '@/i18n';
import { MAP } from '@/i18n/dict/map';
import { cn } from '@/lib/utils';
import { Button, STATUS_ICON, STATUS_TONE, Spinner, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';

const TONE_TEXT: Record<string, string> = {
  red: 'text-st-offline',
  orange: 'text-st-fault',
  amber: 'text-st-dimming',
  green: 'text-st-on',
  muted: 'text-st-off',
  purple: 'text-st-unknown',
};

function StatusDot({ status }: { status: CabinetStatus }) {
  const L = useLabels();
  const Icon = STATUS_ICON[status];
  return <Icon className={cn('h-4 w-4 shrink-0', TONE_TEXT[STATUS_TONE[status]])} aria-label={L.status[status]} />;
}

export function LeftPanel({
  center,
  cabinets,
  statusView,
  onCloseStatus,
  selectedId,
  onPick,
}: {
  center: GeoPoint;
  cabinets: CabinetSummary[];
  /** status picked on a KPI card: the panel shows every cabinet in that status instead of the tabs */
  statusView: CabinetStatus | null;
  onCloseStatus: () => void;
  selectedId: string | null;
  onPick: (id: string) => void;
}) {
  const t = useDict(MAP).left;
  // Tabs stay mounted (hidden) under the status list so the chosen tab survives opening/closing it.
  const [tab, setTab] = useState('near');
  return (
    <>
      {statusView && <StatusList status={statusView} cabinets={cabinets} selectedId={selectedId} onPick={onPick} onClose={onCloseStatus} />}
      <Tabs value={tab} onValueChange={setTab} className={cn('flex min-h-0 flex-1 flex-col', statusView && 'hidden')}>
        <TabsList>
          <TabsTrigger value="near">{t.near}</TabsTrigger>
          <TabsTrigger value="tree">{t.tree}</TabsTrigger>
        </TabsList>
        <TabsContent value="near" className="min-h-0 flex-1 overflow-auto">
          <NearbyList center={center} selectedId={selectedId} onPick={onPick} />
        </TabsContent>
        <TabsContent value="tree" className="min-h-0 flex-1 overflow-auto">
          <AreaTree cabinets={cabinets} selectedId={selectedId} onPick={onPick} />
        </TabsContent>
      </Tabs>
    </>
  );
}

function StatusList({
  status,
  cabinets,
  selectedId,
  onPick,
  onClose,
}: {
  status: CabinetStatus;
  cabinets: CabinetSummary[];
  selectedId: string | null;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const t = useDict(MAP).statusList;
  const L = useLabels();
  // same cached query as the area tree: only used to turn ward/district ids into names
  const { data: tree } = useQuery({ queryKey: ['area-tree'], queryFn: api.areaTree });
  const areaName = useMemo(() => new Map((tree?.areas ?? []).map((a) => [a.id, a.name])), [tree]);
  const list = useMemo(
    () => cabinets.filter((c) => c.status === status).sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true })),
    [cabinets, status],
  );
  const place = (c: CabinetSummary) => {
    const parts = [c.wardId && areaName.get(c.wardId), c.districtId && areaName.get(c.districtId)].filter(Boolean);
    if (parts.length) return parts.join(', ');
    return c.wardId || c.districtId ? null : t.noArea;
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b px-1 py-1">
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onClose} aria-label={t.back} title={t.back}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <StatusDot status={status} />
        <span className="truncate text-sm font-semibold">{fill(t.title, { status: L.status[status], n: list.length })}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {!list.length ? (
          <div className="p-6 text-center text-sm text-subtle">{t.empty}</div>
        ) : (
          <ul className="divide-y">
            {list.map((c) => {
              const where = place(c);
              return (
                <li key={c.id}>
                  <button
                    onClick={() => onPick(c.id)}
                    className={cn('flex w-full min-w-0 flex-col px-3 py-2 text-left hover:bg-muted/60', selectedId === c.id && 'bg-primary/10')}
                  >
                    <span className="truncate text-sm">
                      <b>{c.code}</b> · {c.name}
                    </span>
                    {where && <span className="truncate text-[11px] text-subtle">{where}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function NearbyList({ center, selectedId, onPick }: { center: GeoPoint; selectedId: string | null; onPick: (id: string) => void }) {
  const t = useDict(MAP).left;
  const key = [center.lat.toFixed(3), center.lng.toFixed(3)];
  const { data, isLoading } = useQuery({ queryKey: ['nearby', ...key], queryFn: () => api.nearby(center), placeholderData: (p) => p });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const list = data ?? [];
  if (isLoading)
    return (
      <div className="flex justify-center p-6">
        <Spinner />
      </div>
    );
  if (!list.length) return <div className="p-6 text-center text-sm text-subtle">{t.noneNear}</div>;
  return (
    <ul className="divide-y">
      {list.map((c) => (
        <li key={c.id}>
          <div className={cn('flex items-center gap-2 px-2 py-1.5 hover:bg-muted/60', selectedId === c.id && 'bg-primary/10')}>
            <button
              className="text-subtle"
              aria-label={hidden.has(c.id) ? t.showOnMap : t.hideOnMap}
              onClick={() =>
                setHidden((h) => {
                  const n = new Set(h);
                  if (n.has(c.id)) n.delete(c.id);
                  else n.add(c.id);
                  return n;
                })
              }
            >
              {hidden.has(c.id) ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
            <StatusDot status={c.status} />
            <button className="min-w-0 flex-1 text-left" onClick={() => onPick(c.id)}>
              <div className="truncate text-sm font-medium">{c.name}</div>
              <div className="text-[11px] text-subtle">
                {c.code} · {c.distanceM} m
              </div>
            </button>
            <button className="text-subtle" onClick={() => setExpanded(expanded === c.id ? null : c.id)} aria-label={t.showRoutes}>
              {expanded === c.id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </button>
          </div>
          {expanded === c.id && (
            <div className="bg-muted/40 px-9 py-1.5 text-xs text-subtle">
              <div>{fill(t.route, { code: `${c.code}_N1`, branch: 1, state: c.branch1On === null ? '—' : c.branch1On ? t.lit : t.off })}</div>
              <div>{fill(t.route, { code: `${c.code}_N2`, branch: 2, state: c.branch2On === null ? '—' : c.branch2On ? t.lit : t.off })}</div>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function AreaTree({ cabinets, selectedId, onPick }: { cabinets: CabinetSummary[]; selectedId: string | null; onPick: (id: string) => void }) {
  const t = useDict(MAP).left;
  const { data } = useQuery({ queryKey: ['area-tree'], queryFn: api.areaTree });
  const [open, setOpen] = useState<Set<string>>(new Set(['org']));
  const children = useMemo(() => {
    const m = new Map<string | null, Area[]>();
    data?.areas.forEach((a) => m.set(a.parentId, [...(m.get(a.parentId) ?? []), a]));
    return m;
  }, [data]);
  const byWard = useMemo(() => {
    const m = new Map<string, CabinetSummary[]>();
    cabinets.forEach((c) => {
      const k = c.wardId ?? 'unassigned';
      m.set(k, [...(m.get(k) ?? []), c]);
    });
    return m;
  }, [cabinets]);

  const toggle = (id: string) =>
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  if (!data)
    return (
      <div className="flex justify-center p-6">
        <Spinner />
      </div>
    );

  const renderCabinets = (key: string, depth: number) =>
    (byWard.get(key) ?? []).map((c) => (
      <button
        key={c.id}
        onClick={() => onPick(c.id)}
        className={cn('flex w-full items-center gap-2 py-1 pr-2 text-left text-sm hover:bg-muted/60', selectedId === c.id && 'bg-primary/10')}
        style={{ paddingLeft: depth * 14 + 8 }}
      >
        <StatusDot status={c.status} />
        <span className="truncate">{c.name}</span>
        <span className="ml-auto text-[11px] text-subtle">{c.code}</span>
      </button>
    ));

  const renderNode = (a: Area, depth: number): React.ReactNode => {
    const isOpen = open.has(a.id);
    return (
      <div key={a.id}>
        <button className="flex w-full items-center gap-1 py-1 pr-2 text-left text-sm hover:bg-muted/60" style={{ paddingLeft: depth * 14 + 4 }} onClick={() => toggle(a.id)}>
          {isOpen ? <ChevronDown className="h-4 w-4 text-subtle" /> : <ChevronRight className="h-4 w-4 text-subtle" />}
          <span className={cn(a.kind !== 'ward' && 'font-medium')}>{a.name}</span>
          <span className="ml-1 text-xs text-subtle">({a.cabinetCount})</span>
        </button>
        {isOpen && (a.kind === 'ward' ? renderCabinets(a.id, depth + 1) : (children.get(a.id) ?? []).map((c) => renderNode(c, depth + 1)))}
      </div>
    );
  };

  return (
    <div className="py-1">
      {(children.get(null) ?? []).map((a) => renderNode(a, 0))}
      <div>
        <button className="flex w-full items-center gap-1 py-1 pl-1 pr-2 text-left text-sm hover:bg-muted/60" onClick={() => toggle('unassigned')}>
          {open.has('unassigned') ? <ChevronDown className="h-4 w-4 text-subtle" /> : <ChevronRight className="h-4 w-4 text-subtle" />}
          <span className="font-medium text-st-fault">{t.unassigned}</span>
          <span className="ml-1 text-xs text-subtle">({data.unassigned})</span>
        </button>
        {open.has('unassigned') && renderCabinets('unassigned', 1)}
      </div>
    </div>
  );
}
