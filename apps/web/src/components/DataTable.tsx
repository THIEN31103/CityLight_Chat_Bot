import { useState } from 'react';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef, type VisibilityState } from '@tanstack/react-table';
import * as Popover from '@radix-ui/react-popover';
import { Columns3, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button, Checkbox, Empty, Select, Skeleton } from './ui';
import { cn } from '@/lib/utils';
import { fill, locale, useDict } from '@/i18n';
import { TABLE } from '@/i18n/dict/table';

/** Server-paginated table with column show/hide (spec: lists paginate on the server). */
export function DataTable<T>({
  columns,
  data,
  total,
  page,
  size,
  onPage,
  onSize,
  loading,
  onRowClick,
  toolbar,
  initialHidden = {},
}: {
  columns: ColumnDef<T, unknown>[];
  data: T[];
  total?: number;
  page?: number;
  size?: number;
  onPage?: (p: number) => void;
  onSize?: (s: number) => void;
  loading?: boolean;
  onRowClick?: (row: T) => void;
  toolbar?: React.ReactNode;
  initialHidden?: VisibilityState;
}) {
  const t = useDict(TABLE);
  const [visibility, setVisibility] = useState<VisibilityState>(initialHidden);
  const table = useReactTable({
    data,
    columns,
    state: { columnVisibility: visibility },
    onColumnVisibilityChange: setVisibility,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
  });
  const pages = total !== undefined && size ? Math.max(1, Math.ceil(total / size)) : 1;

  return (
    <div className="rounded-lg border bg-panel">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">{toolbar}</div>
        <Popover.Root>
          <Popover.Trigger asChild>
            <Button variant="outline" size="sm">
              <Columns3 className="h-4 w-4" /> {t.columns}
            </Button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content align="end" className="z-50 max-h-80 w-56 overflow-auto rounded-md border bg-panel p-2 shadow-lg">
              {table.getAllLeafColumns().map((c) => (
                <div key={c.id} className="py-0.5">
                  <Checkbox label={String(c.columnDef.header ?? c.id)} checked={c.getIsVisible()} onChange={(v) => c.toggleVisibility(v)} />
                </div>
              ))}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-subtle">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => (
                  <th key={h.id} className="whitespace-nowrap px-3 py-2 font-medium">
                    {flexRender(h.column.columnDef.header, h.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {loading &&
              Array.from({ length: 6 }).map((_, i) => (
                <tr key={i} className="border-t">
                  <td colSpan={columns.length} className="px-3 py-2">
                    <Skeleton className="h-5 w-full" />
                  </td>
                </tr>
              ))}
            {!loading &&
              table.getRowModel().rows.map((r) => (
                <tr key={r.id} className={cn('border-t', onRowClick && 'cursor-pointer hover:bg-muted/50')} onClick={() => onRowClick?.(r.original)}>
                  {r.getVisibleCells().map((c) => (
                    <td key={c.id} className="px-3 py-2 align-top">
                      {flexRender(c.column.columnDef.cell, c.getContext())}
                    </td>
                  ))}
                </tr>
              ))}
          </tbody>
        </table>
        {!loading && data.length === 0 && <Empty />}
      </div>
      {total !== undefined && page !== undefined && size !== undefined && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2 text-xs text-subtle">
          <span>{t.summary(total, total.toLocaleString(locale()), page, pages)}</span>
          <div className="flex items-center gap-2">
            <Select value={size} onChange={(e) => onSize?.(Number(e.target.value))} className="h-8">
              {[20, 50, 100].map((s) => (
                <option key={s} value={s}>
                  {fill(t.perPage, { n: s })}
                </option>
              ))}
            </Select>
            <Button variant="outline" size="icon" disabled={page <= 1} onClick={() => onPage?.(page - 1)} aria-label={t.prev}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="icon" disabled={page >= pages} onClick={() => onPage?.(page + 1)} aria-label={t.next}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
