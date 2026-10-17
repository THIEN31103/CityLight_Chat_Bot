import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Download } from 'lucide-react';
import type { ActivityLog } from '@citylight/shared';
import { api } from '@/lib/api';
import { downloadCsv } from '@/lib/exportFile';
import { fmtTime } from '@/lib/utils';
import { DataTable } from '@/components/DataTable';
import { Button, Input, PageHeader, Select } from '@/components/ui';

export function ActivityLogPage() {
  const [user, setUser] = useState('');
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);
  const users = useQuery({ queryKey: ['users'], queryFn: api.users });
  const params = { user, q, from: from ? new Date(from).toISOString() : undefined, to: to ? new Date(to + 'T23:59:59').toISOString() : undefined, page, size };
  const { data, isLoading } = useQuery({ queryKey: ['activity', params], queryFn: () => api.activityLogs(params) });

  const columns = useMemo<ColumnDef<ActivityLog, unknown>[]>(
    () => [
      { header: 'Mã', accessorKey: 'id' },
      { header: 'Thời điểm', cell: ({ row: r }) => <span className="whitespace-nowrap text-xs">{fmtTime(r.original.ts)}</span> },
      { header: 'Người thực hiện', accessorKey: 'userEmail' },
      { header: 'Hành động', accessorKey: 'action' },
      { header: 'Đối tượng', cell: ({ row: r }) => <span>{r.original.targetName}</span> },
      { header: 'Giá trị cũ', cell: ({ row: r }) => <span className="text-xs text-subtle">{r.original.oldValue ?? '—'}</span> },
      { header: 'Giá trị mới', cell: ({ row: r }) => <span className="text-xs">{r.original.newValue ?? '—'}</span> },
      { header: 'IP', accessorKey: 'ip' },
    ],
    [],
  );

  return (
    <div className="p-4">
      <PageHeader
        title="Nhật ký thao tác"
        subtitle="Ghi tự động mọi API ghi và mọi lệnh thiết bị"
        actions={
          <Button variant="outline" onClick={() => downloadCsv('nhat-ky-thao-tac.csv', ['Mã', 'Thời điểm', 'Người', 'Hành động', 'Đối tượng', 'Cũ', 'Mới', 'IP'], (data?.items ?? []).map((l) => [l.id, fmtTime(l.ts), l.userEmail, l.action, l.targetName, l.oldValue, l.newValue, l.ip]))}>
            <Download className="h-4 w-4" /> Xuất Excel
          </Button>
        }
      />
      <DataTable
        columns={columns}
        data={data?.items ?? []}
        total={data?.total}
        page={page}
        size={size}
        onPage={setPage}
        onSize={(s) => { setSize(s); setPage(1); }}
        loading={isLoading}
        initialHidden={{ ip: false }}
        toolbar={
          <>
            <Select value={user} onChange={(e) => { setUser(e.target.value); setPage(1); }}>
              <option value="">Mọi người dùng</option>
              {users.data?.map((u) => <option key={u.id} value={u.email}>{u.email}</option>)}
            </Select>
            <Input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Tìm tủ / hành động…" className="w-56" />
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" aria-label="Từ ngày" />
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" aria-label="Đến ngày" />
          </>
        }
      />
    </div>
  );
}
