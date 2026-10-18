import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import dayjs from 'dayjs';
import { Download, Plus } from 'lucide-react';
import type { Incident } from '@citylight/shared';
import { INCIDENT_STATUS_LABELS, INCIDENT_CATEGORIES, incidentOverdue } from '@citylight/shared';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/stores/session';
import { downloadCsv } from '@/lib/exportFile';
import { fmtTime } from '@/lib/utils';
import { DataTable } from '@/components/DataTable';
import { Badge, Button, Checkbox, Field, Input, Modal, PageHeader, Select, Textarea, toast } from '@/components/ui';

const FILTERS = [
  { q: 'all', label: 'Tất cả' },
  { q: 'mine', label: 'Việc của tôi' },
  { q: 'overdue', label: 'Quá hạn' },
  { q: 'new', label: 'Chưa xử lý' },
  { q: 'assigned', label: 'Yêu cầu xử lý' },
  { q: 'deferred', label: 'Chưa cần xử lý' },
  { q: 'resolved_closed', label: 'Đã xử lý' },
  { q: 'deferred_resolved', label: 'Chưa cần & đã xử lý' },
];

export const INCIDENT_TONE: Record<Incident['status'], 'red' | 'orange' | 'muted' | 'green' | 'blue'> = {
  new: 'red',
  assigned: 'orange',
  deferred: 'muted',
  resolved: 'green',
  closed: 'blue',
};

export function IncidentsPage() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? 'all';
  const district = params.get('district') ?? '';
  const [showTree, setShowTree] = useState(true);
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
      { id: 'code', header: 'Mã', accessorKey: 'code' },
      { id: 'cabinet', header: 'Tủ điều khiển', accessorKey: 'cabinetName' },
      { id: 'district', header: 'Quận/huyện', accessorKey: 'districtName' },
      { id: 'ward', header: 'Phường/xã', accessorKey: 'wardName' },
      { id: 'reportedAt', header: 'Thời điểm ghi nhận', cell: ({ row: r }) => <span className="whitespace-nowrap text-xs">{fmtTime(r.original.reportedAt)}</span> },
      { id: 'reporter', header: 'Người báo', accessorKey: 'reportedBy' },
      { id: 'source', header: 'Nguồn', cell: ({ row: r }) => (r.original.source === 'alarm' ? 'Cảnh báo' : 'Thủ công') },
      { id: 'category', header: 'Phân loại', accessorKey: 'category' },
      { id: 'content', header: 'Nội dung', cell: ({ row: r }) => <span className="line-clamp-2 max-w-xs">{r.original.content}</span> },
      { id: 'status', header: 'Trạng thái', cell: ({ row: r }) => <Badge tone={INCIDENT_TONE[r.original.status]}>{INCIDENT_STATUS_LABELS[r.original.status]}</Badge> },
      { id: 'assignee', header: 'Người xử lý', cell: ({ row: r }) => r.original.assignee ?? '—' },
      { id: 'deadline', header: 'Hạn xử lý', cell: ({ row: r }) => <span className={incidentOverdue(r.original) ? 'text-st-offline' : ''}>{fmtTime(r.original.deadline, 'DD/MM/YYYY HH:mm')}</span> },
      { id: 'resolvedAt', header: 'Thời điểm xử lý', cell: ({ row: r }) => <span className="text-xs">{fmtTime(r.original.resolvedAt)}</span> },
      { id: 'resolution', header: 'Nội dung xử lý', cell: ({ row: r }) => r.original.resolution ?? '—' },
    ],
    [],
  );

  return (
    <div className="flex h-full">
      {showTree && (
        <aside className="w-60 shrink-0 overflow-auto border-r bg-panel p-2">
          <div className="mb-1 px-2 text-xs font-semibold uppercase text-subtle">Khu vực</div>
          <button className={`block w-full rounded px-2 py-1 text-left text-sm hover:bg-muted ${!district ? 'bg-primary/10 font-medium' : ''}`} onClick={() => setParam('district', '')}>
            Tất cả
          </button>
          {districts.map((d) => (
            <button key={d.id} className={`block w-full rounded px-2 py-1 text-left text-sm hover:bg-muted ${district === d.name ? 'bg-primary/10 font-medium' : ''}`} onClick={() => setParam('district', d.name)}>
              {d.name} <span className="text-xs text-subtle">({d.cabinetCount})</span>
            </button>
          ))}
        </aside>
      )}
      <div className="min-w-0 flex-1 overflow-auto p-4">
        <PageHeader
          title="Quản lý sự cố"
          actions={
            <>
              <Checkbox label="Hiện cây phân cấp" checked={showTree} onChange={setShowTree} />
              <Button
                variant="outline"
                onClick={async () => {
                  // every row matching the filters, as .xlsx from the server; CSV of this page on the mock demo
                  const { page: _p, size: _s, ...filters } = query;
                  const ok = await api.exportIncidents(filters).catch(() => false);
                  if (!ok)
                    downloadCsv('su-co.csv', ['Mã', 'Tủ', 'Quận', 'Phường', 'Ghi nhận', 'Người báo', 'Phân loại', 'Nội dung', 'Trạng thái', 'Người xử lý', 'Hạn'], (data?.items ?? []).map((i) => [i.code, i.cabinetName, i.districtName, i.wardName, fmtTime(i.reportedAt), i.reportedBy, i.category, i.content, INCIDENT_STATUS_LABELS[i.status], i.assignee, fmtTime(i.deadline)]));
                }}
              >
                <Download className="h-4 w-4" /> Xuất Excel
              </Button>
              {canManage && (
                <Button onClick={() => setCreateOpen(true)}>
                  <Plus className="h-4 w-4" /> Tạo sự cố
                </Button>
              )}
            </>
          }
        />
        <div className="mb-3 flex flex-wrap items-center gap-3">
          {FILTERS.map((f) => (
            <label key={f.q} className="flex items-center gap-1.5 text-sm">
              <input type="radio" checked={q === f.q} onChange={() => setParam('q', f.q)} /> {f.label}
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
          toolbar={
            <>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" aria-label="Từ ngày" />
              <span className="text-subtle">→</span>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" aria-label="Đến ngày" />
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
  const [search, setSearch] = useState('');
  const [cabinetId, setCabinetId] = useState('');
  const [category, setCategory] = useState('Đèn tắt');
  const [content, setContent] = useState('');
  const found = useQuery({ queryKey: ['search', search], queryFn: () => api.search(search), enabled: search.length >= 2 });
  const create = useMutation({
    mutationFn: () => api.createIncident({ cabinetId, category, content }),
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Không tạo được sự cố', 'error'),
    onSuccess: (inc) => {
      toast(`Đã tạo sự cố ${inc.code}`, 'success');
      qc.invalidateQueries({ queryKey: ['incidents'] });
      onOpenChange(false);
      nav(`/incidents/${inc.id}`);
    },
  });
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Tạo sự cố"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Hủy</Button>
          <Button disabled={!cabinetId || !content} loading={create.isPending} onClick={() => create.mutate()}>Tạo</Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Tủ liên quan">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Gõ mã hoặc tên tủ…" />
        </Field>
        {found.data && (
          <Select value={cabinetId} onChange={(e) => setCabinetId(e.target.value)} className="w-full">
            <option value="">— chọn tủ —</option>
            {found.data.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
          </Select>
        )}
        <Field label="Phân loại">
          <Select value={category} onChange={(e) => setCategory(e.target.value)} className="w-full">
            {INCIDENT_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
          </Select>
        </Field>
        <Field label="Nội dung">
          <Textarea value={content} onChange={(e) => setContent(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
