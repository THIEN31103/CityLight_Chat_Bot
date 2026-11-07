import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import dayjs from 'dayjs';
import { Download, Plus } from 'lucide-react';
import type { Incident } from '@citylight/shared';
import { INCIDENT_CATEGORIES, incidentCategoryLabel, incidentOverdue } from '@citylight/shared';
import { fill, useDict, useLabels, useLang } from '@/i18n';
import { COMMON } from '@/i18n/dict/common';
import { INCIDENTS } from '@/i18n/dict/incidents';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/stores/session';
import { downloadCsv } from '@/lib/exportFile';
import { fmtTime } from '@/lib/utils';
import { isMobileNow } from '@/lib/useIsMobile';
import { DataTable } from '@/components/DataTable';
import { Badge, Button, Checkbox, Field, Input, Modal, PageHeader, Select, Textarea, toast } from '@/components/ui';

const FILTERS = ['all', 'mine', 'overdue', 'new', 'assigned', 'deferred', 'resolved_closed', 'deferred_resolved'] as const;

/** Stored incident category / district name -> label in the current language (the data stays Vietnamese). */
export function useIncidentText() {
  const lang = useLang((s) => s.lang);
  return useMemo(
    () => ({
      category: (c: string) => incidentCategoryLabel(c, lang),
      area: (n: string) => (n === INCIDENTS.vi.unassigned ? INCIDENTS[lang].unassigned : n),
    }),
    [lang],
  );
}

export const INCIDENT_TONE: Record<Incident['status'], 'red' | 'orange' | 'muted' | 'green' | 'blue'> = {
  new: 'red',
  assigned: 'orange',
  deferred: 'muted',
  resolved: 'green',
  closed: 'blue',
};

export function IncidentsPage() {
  const nav = useNavigate();
  const t = useDict(INCIDENTS).list;
  const L = useLabels();
  const tx = useIncidentText();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? 'all';
  const district = params.get('district') ?? '';
  const [showTree, setShowTree] = useState(() => !isMobileNow());
  const [from, setFrom] = useState(dayjs().startOf('month').format('YYYY-MM-DD'));
  const [to, setTo] = useState(dayjs().format('YYYY-MM-DD'));
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);
  const [createOpen, setCreateOpen] = useState(false);
  // field staff (incident.resolve) may report an incident too
  const canManage = useSession((s) => s.can('incident.manage') || s.can('incident.resolve'));
  const tree = useQuery({ queryKey: ['area-tree'], queryFn: api.areaTree });
  const districts = tree.data?.areas.filter((a) => a.kind === 'district') ?? [];

  const setParam = (k: string, v: string) => {
    const n = new URLSearchParams(params);
    if (v) n.set(k, v);
    else n.delete(k);
    setParams(n, { replace: true });
    setPage(1);
  };

  const query = { q, district, from: new Date(from).toISOString(), to: new Date(to + 'T23:59:59').toISOString(), page, size };
  const { data, isLoading } = useQuery({ queryKey: ['incidents', query], queryFn: () => api.incidents(query) });

  const columns = useMemo<ColumnDef<Incident, unknown>[]>(
    () => [
      { id: 'code', header: t.col.code, accessorKey: 'code' },
      { id: 'cabinet', header: t.col.cabinet, accessorKey: 'cabinetName' },
      { id: 'district', header: t.col.district, cell: ({ row: r }) => tx.area(r.original.districtName) },
      { id: 'ward', header: t.col.ward, accessorKey: 'wardName' },
      { id: 'reportedAt', header: t.col.reportedAt, cell: ({ row: r }) => <span className="whitespace-nowrap text-xs">{fmtTime(r.original.reportedAt)}</span> },
      { id: 'reporter', header: t.col.reporter, accessorKey: 'reportedBy' },
      { id: 'source', header: t.col.source, cell: ({ row: r }) => (r.original.source === 'alarm' ? t.sourceAlarm : t.sourceManual) },
      { id: 'category', header: t.col.category, cell: ({ row: r }) => tx.category(r.original.category) },
      { id: 'content', header: t.col.content, cell: ({ row: r }) => <span className="line-clamp-2 max-w-xs">{r.original.content}</span> },
      { id: 'status', header: t.col.status, cell: ({ row: r }) => <Badge tone={INCIDENT_TONE[r.original.status]}>{L.incidentStatus[r.original.status]}</Badge> },
      { id: 'assignee', header: t.col.assignee, cell: ({ row: r }) => r.original.assignee ?? '—' },
      { id: 'deadline', header: t.col.deadline, cell: ({ row: r }) => <span className={incidentOverdue(r.original) ? 'text-st-offline' : ''}>{fmtTime(r.original.deadline, 'DD/MM/YYYY HH:mm')}</span> },
      { id: 'resolvedAt', header: t.col.resolvedAt, cell: ({ row: r }) => <span className="text-xs">{fmtTime(r.original.resolvedAt)}</span> },
      { id: 'resolution', header: t.col.resolution, cell: ({ row: r }) => r.original.resolution ?? '—' },
    ],
    [t, L, tx],
  );

  return (
    <div className="flex h-full max-md:flex-col">
      {showTree && (
        <aside className="w-60 shrink-0 overflow-auto border-r bg-panel p-2 max-md:max-h-48 max-md:w-full max-md:border-b max-md:border-r-0">
          <div className="mb-1 px-2 text-xs font-semibold uppercase text-subtle">{t.areas}</div>
          <button className={`block w-full rounded px-2 py-1 text-left text-sm hover:bg-muted ${!district ? 'bg-primary/10 font-medium' : ''}`} onClick={() => setParam('district', '')}>
            {t.allAreas}
          </button>
          {districts.map((d) => (
            <button key={d.id} className={`block w-full rounded px-2 py-1 text-left text-sm hover:bg-muted ${district === d.name ? 'bg-primary/10 font-medium' : ''}`} onClick={() => setParam('district', d.name)}>
              {d.name} <span className="text-xs text-subtle">({d.cabinetCount})</span>
            </button>
          ))}
        </aside>
      )}
      <div className="min-h-0 min-w-0 flex-1 overflow-auto p-4 max-md:p-3">
        <PageHeader
          title={t.title}
          actions={
            <>
              <Checkbox label={t.showTree} checked={showTree} onChange={setShowTree} />
              <Button
                variant="outline"
                onClick={async () => {
                  // every row matching the filters, as .xlsx from the server; CSV of this page on the mock demo
                  const { page: _p, size: _s, ...filters } = query;
                  const ok = await api.exportIncidents(filters).catch(() => false);
                  if (!ok)
                    downloadCsv(t.csvFile, [t.csv.code, t.csv.cabinet, t.csv.district, t.csv.ward, t.csv.reported, t.csv.reporter, t.csv.category, t.csv.content, t.csv.status, t.csv.assignee, t.csv.deadline], (data?.items ?? []).map((i) => [i.code, i.cabinetName, tx.area(i.districtName), i.wardName, fmtTime(i.reportedAt), i.reportedBy, tx.category(i.category), i.content, L.incidentStatus[i.status], i.assignee, fmtTime(i.deadline)]));
                }}
              >
                <Download className="h-4 w-4" /> {t.export}
              </Button>
              {canManage && (
                <Button onClick={() => setCreateOpen(true)}>
                  <Plus className="h-4 w-4" /> {t.create}
                </Button>
              )}
            </>
          }
        />
        <div className="mb-3 flex flex-wrap items-center gap-3">
          {FILTERS.map((f) => (
            <label key={f} className="flex items-center gap-1.5 text-sm">
              <input type="radio" checked={q === f} onChange={() => setParam('q', f)} /> {t.filter[f]}
            </label>
          ))}
        </div>
        <DataTable
          columns={columns}
          data={data?.items ?? []}
          total={data?.total}
          page={page}
          size={size}
          onPage={setPage}
          onSize={(s) => { setSize(s); setPage(1); }}
          loading={isLoading}
          onRowClick={(i) => nav(`/incidents/${i.id}`)}
          initialHidden={{ resolvedAt: false, resolution: false, source: false }}
          mobileHidden={['ward', 'reporter', 'category']}
          toolbar={
            <>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" aria-label={t.from} />
              <span className="text-subtle max-md:hidden">→</span>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" aria-label={t.to} />
            </>
          }
        />
      </div>
      <CreateIncidentModal open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

function CreateIncidentModal({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const t = useDict(INCIDENTS).create;
  const c = useDict(COMMON);
  const tx = useIncidentText();
  const [search, setSearch] = useState('');
  const [cabinetId, setCabinetId] = useState('');
  const [category, setCategory] = useState<string>(INCIDENT_CATEGORIES[0]); // stored value (Vietnamese)
  const [content, setContent] = useState('');
  const found = useQuery({ queryKey: ['search', search], queryFn: () => api.search(search), enabled: search.length >= 2 });
  const create = useMutation({
    mutationFn: () => api.createIncident({ cabinetId, category, content }),
    onError: (e) => toast(e instanceof ApiError ? e.message : t.failed, 'error'),
    onSuccess: (inc) => {
      toast(fill(t.created, { code: inc.code }), 'success');
      qc.invalidateQueries({ queryKey: ['incidents'] });
      onOpenChange(false);
      nav(`/incidents/${inc.id}`);
    },
  });
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t.title}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{c.cancel}</Button>
          <Button disabled={!cabinetId || !content} loading={create.isPending} onClick={() => create.mutate()}>{c.create}</Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={t.cabinet}>
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t.cabinetPlaceholder} />
        </Field>
        {found.data && (
          <Select value={cabinetId} onChange={(e) => setCabinetId(e.target.value)} className="w-full">
            <option value="">{t.pickCabinet}</option>
            {found.data.map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}
          </Select>
        )}
        <Field label={t.category}>
          <Select value={category} onChange={(e) => setCategory(e.target.value)} className="w-full">
            {INCIDENT_CATEGORIES.map((x) => <option key={x} value={x}>{tx.category(x)}</option>)}
          </Select>
        </Field>
        <Field label={t.content}>
          <Textarea value={content} onChange={(e) => setContent(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
