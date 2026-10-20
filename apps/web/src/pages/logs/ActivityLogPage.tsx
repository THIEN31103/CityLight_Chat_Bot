import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Download } from 'lucide-react';
import type { ActivityLog } from '@citylight/shared';
import { api } from '@/lib/api';
import { downloadCsv } from '@/lib/exportFile';
import { fmtTime } from '@/lib/utils';
import { useDict } from '@/i18n';
import { ACTIVITY, LOG_ACTIONS } from '@/i18n/dict/logs';
import { DataTable } from '@/components/DataTable';
import { Button, Input, PageHeader, Select } from '@/components/ui';

export function ActivityLogPage() {
  const t = useDict(ACTIVITY);
  // the action is stored as Vietnamese text by the server; shown in the user's language when known
  const actions = useDict(LOG_ACTIONS);
  const actionText = (a: string) => actions[a] ?? a;
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
      { header: t.col.id, accessorKey: 'id' },
      { header: t.col.ts, cell: ({ row: r }) => <span className="whitespace-nowrap text-xs">{fmtTime(r.original.ts)}</span> },
      { header: t.col.user, accessorKey: 'userEmail' },
      { header: t.col.action, accessorKey: 'action', cell: ({ row: r }) => actions[r.original.action] ?? r.original.action },
      { header: t.col.target, cell: ({ row: r }) => <span>{r.original.targetName}</span> },
      { header: t.col.oldValue, cell: ({ row: r }) => <span className="text-xs text-subtle">{r.original.oldValue ?? '—'}</span> },
      { header: t.col.newValue, cell: ({ row: r }) => <span className="text-xs">{r.original.newValue ?? '—'}</span> },
      { header: t.col.ip, accessorKey: 'ip' },
    ],
    [t, actions],
  );

  return (
    <div className="p-4">
      <PageHeader
        title={t.title}
        subtitle={t.subtitle}
        actions={
          <Button variant="outline" onClick={() => downloadCsv(t.csv.file, [t.csv.id, t.csv.ts, t.csv.user, t.csv.action, t.csv.target, t.csv.oldValue, t.csv.newValue, t.csv.ip], (data?.items ?? []).map((l) => [l.id, fmtTime(l.ts), l.userEmail, actionText(l.action), l.targetName, l.oldValue, l.newValue, l.ip]))}>
            <Download className="h-4 w-4" /> {t.export}
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
              <option value="">{t.allUsers}</option>
              {users.data?.map((u) => <option key={u.id} value={u.email}>{u.email}</option>)}
            </Select>
            <Input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder={t.search} className="w-56" />
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" aria-label={t.from} />
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" aria-label={t.to} />
          </>
        }
      />
    </div>
  );
}
