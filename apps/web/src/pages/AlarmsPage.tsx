import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Download, Check } from 'lucide-react';
import type { Alarm } from '@citylight/shared';
import { ERROR_CATEGORY_LABELS, alarmTypeLabels, errorCatalog } from '@citylight/shared';
import { fill, useDict, useLabels, useLang } from '@/i18n';
import { ALARMS } from '@/i18n/dict/alarms';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/stores/session';
import { downloadCsv } from '@/lib/exportFile';
import { fmtDuration, fmtTime } from '@/lib/utils';
import { DataTable } from '@/components/DataTable';
import { Badge, Button, Input, KV, Modal, PageHeader, Select, Tabs, TabsList, TabsTrigger, toast } from '@/components/ui';
import { ErrorCodeBadge, ErrorGuide } from '@/components/ErrorHelp';
import { RelocateGpsButton } from './cabinet/RelocateGps';
import { ImeiButton } from './cabinet/ImeiDecision';

export function AlarmsPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const t = useDict(ALARMS);
  const L = useLabels();
  const lang = useLang((s) => s.lang);
  const typeLabels = useMemo(() => alarmTypeLabels(lang), [lang]);
  const catalog = useMemo(() => errorCatalog(lang), [lang]);
  const defOf = (type: Alarm['type']) => catalog.find((e) => e.type === type);
  const areaName = (n: string) => (n === ALARMS.vi.unassigned ? t.unassigned : n);
  const canAck = useSession((s) => s.can('alarm.ack'));
  const canReport = useSession((s) => s.can('incident.manage') || s.can('incident.resolve'));
  const [tab, setTab] = useState<'active' | 'all'>('active');
  const [type, setType] = useState('');
  const [severity, setSeverity] = useState('');
  const [district, setDistrict] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<Alarm | null>(null);
  const [size, setSize] = useState(20);
  const tree = useQuery({ queryKey: ['area-tree'], queryFn: api.areaTree });
  const districts = tree.data?.areas.filter((a) => a.kind === 'district') ?? [];

  const params = { active: tab === 'active' ? true : undefined, type, severity, district, from: from ? new Date(from).toISOString() : undefined, to: to ? new Date(to + 'T23:59:59').toISOString() : undefined, page, size };
  const { data, isLoading } = useQuery({ queryKey: ['alarms', params], queryFn: () => api.alarms(params) });
  const toIncident = useMutation({
    mutationFn: (alarmId: string) => api.createIncident({ alarmId }),
    onSuccess: (inc) => {
      toast(fill(t.incidentCreated, { code: inc.code }), 'success');
      nav(`/incidents/${inc.id}`);
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : t.incidentFailed, 'error'),
  });
  const ack = useMutation({
    mutationFn: api.ackAlarm,
    onSuccess: () => {
      toast(t.acked, 'success');
      qc.invalidateQueries({ queryKey: ['alarms'] });
    },
  });

  const columns = useMemo<ColumnDef<Alarm, unknown>[]>(
    () => [
      { header: t.col.code, cell: ({ row: r }) => <ErrorCodeBadge type={r.original.type} code={r.original.code} /> },
      { header: t.col.cabinet, cell: ({ row: r }) => <div><div className="font-medium">{r.original.cabinetCode}</div><div className="text-xs text-subtle">{r.original.cabinetName}</div></div> },
      { header: t.col.area, cell: ({ row: r }) => areaName(r.original.districtName) },
      { header: t.col.type, cell: ({ row: r }) => typeLabels[r.original.type] },
      { header: t.col.severity, cell: ({ row: r }) => <Badge tone={r.original.severity === 'critical' ? 'red' : r.original.severity === 'major' ? 'orange' : 'amber'}>{L.severity[r.original.severity]}</Badge> },
      { header: t.col.message, accessorKey: 'message' },
      { header: t.col.started, cell: ({ row: r }) => <span className="whitespace-nowrap text-xs">{fmtTime(r.original.startedAt)}</span> },
      { header: t.col.duration, cell: ({ row: r }) => <span className="whitespace-nowrap text-xs">{fmtDuration(r.original.startedAt, r.original.endedAt)}</span> },
      { header: t.col.status, cell: ({ row: r }) => (r.original.active ? <Badge tone="red">{t.active}</Badge> : <Badge>{t.ended}</Badge>) },
      {
        header: t.col.ack,
        cell: ({ row: r }) =>
          r.original.ackedBy ? (
            <span className="text-xs text-subtle">{r.original.ackedBy}<br />{fmtTime(r.original.ackedAt)}</span>
          ) : canAck ? (
            <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); ack.mutate(r.original.id); }}>
              <Check className="h-3.5 w-3.5" /> {t.ackShort}
            </Button>
          ) : (
            '—'
          ),
      },
    ],
    [ack, canAck, t, L, typeLabels],
  );

  return (
    <div className="p-4">
      <PageHeader
        title={t.title}
        subtitle={t.subtitle}
        actions={
          <Button
            variant="outline"
            onClick={async () => {
              const { page: _p, size: _s, ...filters } = params;
              if (await api.exportAlarms(filters).catch(() => false)) return;
              downloadCsv(t.csvFile, [t.csv.code, t.csv.cabinetCode, t.csv.cabinetName, t.csv.area, t.csv.type, t.csv.severity, t.csv.message, t.csv.started, t.csv.ended], (data?.items ?? []).map((a) => [a.code, a.cabinetCode, a.cabinetName, areaName(a.districtName), typeLabels[a.type], L.severity[a.severity], a.message, fmtTime(a.startedAt), fmtTime(a.endedAt)]));
            }}
          >
            <Download className="h-4 w-4" /> {t.export}
          </Button>
        }
      />
      <Tabs value={tab} onValueChange={(v) => { setTab(v as 'active' | 'all'); setPage(1); }}>
        <TabsList className="mb-3">
          <TabsTrigger value="active">{t.tabActive}</TabsTrigger>
          <TabsTrigger value="all">{t.tabAll}</TabsTrigger>
        </TabsList>
      </Tabs>
      <DataTable
        columns={columns}
        data={data?.items ?? []}
        total={data?.total}
        page={page}
        size={size}
        onPage={setPage}
        onSize={(s) => { setSize(s); setPage(1); }}
        loading={isLoading}
        onRowClick={(a) => setOpen(a)}
        toolbar={
          <>
            <Select value={district} onChange={(e) => { setDistrict(e.target.value); setPage(1); }}>
              <option value="">{t.allAreas}</option>
              {districts.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
              <option value={ALARMS.vi.unassigned}>{t.unassigned}</option>
            </Select>
            <Select value={type} onChange={(e) => { setType(e.target.value); setPage(1); }}>
              <option value="">{t.allTypes}</option>
              {[...new Set(catalog.map((e) => e.category))].map((cat) => (
                <optgroup key={cat} label={ERROR_CATEGORY_LABELS[lang][cat]}>
                  {catalog.filter((e) => e.category === cat).map((e) => (
                    <option key={e.type} value={e.type}>
                      {e.code} · {e.title}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
            <Select value={severity} onChange={(e) => { setSeverity(e.target.value); setPage(1); }}>
              <option value="">{t.allSeverities}</option>
              {Object.entries(L.severity).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" aria-label={t.from} />
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" aria-label={t.to} />
          </>
        }
      />
      <Modal
        open={!!open}
        onOpenChange={(v) => !v && setOpen(null)}
        title={open ? `${open.code} · ${typeLabels[open.type]}` : ''}
        className="w-[min(680px,calc(100vw-32px))]"
        footer={
          open && (
            <>
              {canAck && !open.ackedBy && (
                <Button variant="outline" onClick={() => { ack.mutate(open.id); setOpen(null); }}>
                  {t.ackLong}
                </Button>
              )}
              {canReport && (
                <Button variant="outline" loading={toIncident.isPending} onClick={() => toIncident.mutate(open.id)}>
                  {t.createIncident}
                </Button>
              )}
              <Button onClick={() => nav(`/?cabinet=${open.cabinetId}`)}>{t.openOnMap}</Button>
            </>
          )
        }
      >
        {open && (
          <div className="space-y-4">
            <div>
              <KV label={t.kv.cabinet} value={`${open.cabinetCode} · ${open.cabinetName}`} />
              <KV label={t.kv.area} value={areaName(open.districtName)} />
              <KV label={t.kv.detail} value={open.message} />
              <KV label={t.kv.started} value={fmtTime(open.startedAt)} />
              <KV label={t.kv.duration} value={`${fmtDuration(open.startedAt, open.endedAt)}${open.active ? t.ongoing : ''}`} />
              <KV label={t.kv.ack} value={open.ackedBy ? `${open.ackedBy} · ${fmtTime(open.ackedAt)}` : t.notAcked} />
            </div>
            {open.type === 'spoof_suspect' && open.active && (
              <div className="flex justify-end">
                <ImeiButton cabinetId={open.cabinetId} label={`${open.cabinetCode} · ${open.cabinetName}`} onDone={() => setOpen(null)} />
              </div>
            )}
            {open.type === 'gps_drift' && open.active && (
              <div className="flex justify-end">
                <RelocateGpsButton cabinetId={open.cabinetId} label={`${open.cabinetCode} · ${open.cabinetName}`} onDone={() => setOpen(null)} />
              </div>
            )}
            {defOf(open.type) && (
              <div className="rounded-md border bg-muted/40 p-3">
                <ErrorGuide def={defOf(open.type)!} />
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
