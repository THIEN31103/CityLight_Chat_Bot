import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Download, Check } from 'lucide-react';
import type { Alarm } from '@citylight/shared';
import { ALARM_TYPE_LABELS, ERROR_CATALOG, SEVERITY_LABELS, errorOf } from '@citylight/shared';
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
      toast(`Đã tạo sự cố ${inc.code}`, 'success');
      nav(`/incidents/${inc.id}`);
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Không tạo được sự cố', 'error'),
  });
  const ack = useMutation({
    mutationFn: api.ackAlarm,
    onSuccess: () => {
      toast('Đã xác nhận cảnh báo', 'success');
      qc.invalidateQueries({ queryKey: ['alarms'] });
    },
  });

  const columns = useMemo<ColumnDef<Alarm, unknown>[]>(
    () => [
      { header: 'Mã', cell: ({ row: r }) => <ErrorCodeBadge type={r.original.type} code={r.original.code} /> },
      { header: 'Tủ', cell: ({ row: r }) => <div><div className="font-medium">{r.original.cabinetCode}</div><div className="text-xs text-subtle">{r.original.cabinetName}</div></div> },
      { header: 'Khu vực', accessorKey: 'districtName' },
      { header: 'Loại', cell: ({ row: r }) => ALARM_TYPE_LABELS[r.original.type] },
      { header: 'Mức', cell: ({ row: r }) => <Badge tone={r.original.severity === 'critical' ? 'red' : r.original.severity === 'major' ? 'orange' : 'amber'}>{SEVERITY_LABELS[r.original.severity]}</Badge> },
      { header: 'Nội dung', accessorKey: 'message' },
      { header: 'Bắt đầu', cell: ({ row: r }) => <span className="whitespace-nowrap text-xs">{fmtTime(r.original.startedAt)}</span> },
      { header: 'Kéo dài', cell: ({ row: r }) => <span className="whitespace-nowrap text-xs">{fmtDuration(r.original.startedAt, r.original.endedAt)}</span> },
      { header: 'Trạng thái', cell: ({ row: r }) => (r.original.active ? <Badge tone="red">Hiện hữu</Badge> : <Badge>Đã kết thúc</Badge>) },
      {
        header: 'Xác nhận',
        cell: ({ row: r }) =>
          r.original.ackedBy ? (
            <span className="text-xs text-subtle">{r.original.ackedBy}<br />{fmtTime(r.original.ackedAt)}</span>
          ) : canAck ? (
            <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); ack.mutate(r.original.id); }}>
              <Check className="h-3.5 w-3.5" /> Đã biết
            </Button>
          ) : (
            '—'
          ),
      },
    ],
    [ack, canAck],
  );

  return (
    <div className="p-4">
      <PageHeader
        title="Cảnh báo lỗi"
        subtitle="Số tủ lỗi / mất kết nối trên bản đồ luôn khớp danh sách cảnh báo hiện hữu (cùng một nguồn trạng thái)"
        actions={
          <Button
            variant="outline"
            onClick={async () => {
              const { page: _p, size: _s, ...filters } = params;
              if (await api.exportAlarms(filters).catch(() => false)) return;
              downloadCsv('canh-bao.csv', ['Mã lỗi', 'Mã tủ', 'Tên tủ', 'Khu vực', 'Loại', 'Mức', 'Nội dung', 'Bắt đầu', 'Kết thúc'], (data?.items ?? []).map((a) => [a.code, a.cabinetCode, a.cabinetName, a.districtName, ALARM_TYPE_LABELS[a.type], SEVERITY_LABELS[a.severity], a.message, fmtTime(a.startedAt), fmtTime(a.endedAt)]));
            }}
          >
            <Download className="h-4 w-4" /> Xuất Excel
          </Button>
        }
      />
      <Tabs value={tab} onValueChange={(v) => { setTab(v as 'active' | 'all'); setPage(1); }}>
        <TabsList className="mb-3">
          <TabsTrigger value="active">Cảnh báo hiện hữu</TabsTrigger>
          <TabsTrigger value="all">Tất cả cảnh báo</TabsTrigger>
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
              <option value="">Tất cả khu vực</option>
              {districts.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
              <option value="Chưa phân khu vực">Chưa phân khu vực</option>
            </Select>
            <Select value={type} onChange={(e) => { setType(e.target.value); setPage(1); }}>
              <option value="">Tất cả loại</option>
              {[...new Set(ERROR_CATALOG.map((e) => e.category))].map((cat) => (
                <optgroup key={cat} label={cat}>
                  {ERROR_CATALOG.filter((e) => e.category === cat).map((e) => (
                    <option key={e.type} value={e.type}>
                      {e.code} · {e.title}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
            <Select value={severity} onChange={(e) => { setSeverity(e.target.value); setPage(1); }}>
              <option value="">Mọi mức</option>
              {Object.entries(SEVERITY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" aria-label="Từ ngày" />
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" aria-label="Đến ngày" />
          </>
        }
      />
      <Modal
        open={!!open}
        onOpenChange={(v) => !v && setOpen(null)}
        title={open ? `${open.code} · ${ALARM_TYPE_LABELS[open.type]}` : ''}
        className="w-[min(680px,calc(100vw-32px))]"
        footer={
          open && (
            <>
              {canAck && !open.ackedBy && (
                <Button variant="outline" onClick={() => { ack.mutate(open.id); setOpen(null); }}>
                  Xác nhận đã biết
                </Button>
              )}
              {canReport && (
                <Button variant="outline" loading={toIncident.isPending} onClick={() => toIncident.mutate(open.id)}>
                  Tạo sự cố
                </Button>
              )}
              <Button onClick={() => nav(`/?cabinet=${open.cabinetId}`)}>Mở tủ trên bản đồ</Button>
            </>
          )
        }
      >
        {open && (
          <div className="space-y-4">
            <div>
              <KV label="Tủ" value={`${open.cabinetCode} · ${open.cabinetName}`} />
              <KV label="Khu vực" value={open.districtName} />
              <KV label="Chi tiết" value={open.message} />
              <KV label="Bắt đầu" value={fmtTime(open.startedAt)} />
              <KV label="Kéo dài" value={`${fmtDuration(open.startedAt, open.endedAt)}${open.active ? ' (đang diễn ra)' : ''}`} />
              <KV label="Xác nhận" value={open.ackedBy ? `${open.ackedBy} · ${fmtTime(open.ackedAt)}` : 'Chưa'} />
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
            {errorOf(open.type) && (
              <div className="rounded-md border bg-muted/40 p-3">
                <ErrorGuide def={errorOf(open.type)!} />
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
