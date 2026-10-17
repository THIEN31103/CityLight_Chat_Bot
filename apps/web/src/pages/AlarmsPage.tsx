import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Download, Check } from 'lucide-react';
import type { Alarm, AlarmType } from '@citylight/shared';
import { ALARM_TYPE_LABELS, SEVERITY_LABELS } from '@citylight/shared';
import { api } from '@/lib/api';
import { useSession } from '@/stores/session';
import { downloadCsv } from '@/lib/exportFile';
import { fmtDuration, fmtTime } from '@/lib/utils';
import { DataTable } from '@/components/DataTable';
import { Badge, Button, Input, PageHeader, Select, Tabs, TabsList, TabsTrigger, toast } from '@/components/ui';

export function AlarmsPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const canAck = useSession((s) => s.can('alarm.ack'));
  const [tab, setTab] = useState<'active' | 'all'>('active');
  const [type, setType] = useState('');
  const [severity, setSeverity] = useState('');
  const [district, setDistrict] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);
  const tree = useQuery({ queryKey: ['area-tree'], queryFn: api.areaTree });
  const districts = tree.data?.areas.filter((a) => a.kind === 'district') ?? [];

  const params = { active: tab === 'active' ? true : undefined, type, severity, district, from: from ? new Date(from).toISOString() : undefined, to: to ? new Date(to + 'T23:59:59').toISOString() : undefined, page, size };
  const { data, isLoading } = useQuery({ queryKey: ['alarms', params], queryFn: () => api.alarms(params) });
  const ack = useMutation({
    mutationFn: api.ackAlarm,
    onSuccess: () => {
      toast('Đã xác nhận cảnh báo', 'success');
      qc.invalidateQueries({ queryKey: ['alarms'] });
    },
  });

  const columns = useMemo<ColumnDef<Alarm, unknown>[]>(
    () => [
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
            onClick={() =>
              downloadCsv('canh-bao.csv', ['Mã tủ', 'Tên tủ', 'Khu vực', 'Loại', 'Mức', 'Nội dung', 'Bắt đầu', 'Kết thúc'], (data?.items ?? []).map((a) => [a.cabinetCode, a.cabinetName, a.districtName, ALARM_TYPE_LABELS[a.type], SEVERITY_LABELS[a.severity], a.message, fmtTime(a.startedAt), fmtTime(a.endedAt)]))
            }
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
        onRowClick={(a) => nav(`/?cabinet=${a.cabinetId}`)}
        toolbar={
          <>
            <Select value={district} onChange={(e) => { setDistrict(e.target.value); setPage(1); }}>
              <option value="">Tất cả khu vực</option>
              {districts.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
              <option value="Chưa phân khu vực">Chưa phân khu vực</option>
            </Select>
            <Select value={type} onChange={(e) => { setType(e.target.value); setPage(1); }}>
              <option value="">Tất cả loại</option>
              {(Object.keys(ALARM_TYPE_LABELS) as AlarmType[]).map((t) => <option key={t} value={t}>{ALARM_TYPE_LABELS[t]}</option>)}
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
    </div>
  );
}
