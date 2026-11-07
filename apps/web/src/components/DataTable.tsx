import { useState } from 'react';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef, type VisibilityState } from '@tanstack/react-table';
import * as Popover from '@radix-ui/react-popover';
import { Columns3, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button, Checkbox, Empty, Select, Skeleton } from './ui';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/lib/useIsMobile';
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
  mobileHidden = [],
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
  /** column ids left off the phone cards: a card should read at a glance */
  mobileHidden?: string[];
}) {
  const t = useDict(TABLE);
  const mobile = useIsMobile();
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
        <div className="flex flex-wrap items-center gap-2 max-md:w-full max-md:[&>*]:min-w-0 max-md:[&>*]:flex-1 max-md:[&>*]:basis-[calc(50%-0.25rem)]">{toolbar}</div>
        <Popover.Root>
          <Popover.Trigger asChild>
            <Button variant="outline" size="sm" className="max-md:hidden">
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
      {mobile ? (
        <div className="divide-y">
          {loading && Array.from({ length: 4 }).map((_, i) => <div key={i} className="p-3"><Skeleton className="h-16 w-full" /></div>)}
          {!loading &&
            table.getRowModel().rows.map((r) => (
              <div key={r.id} className={cn('space-y-1.5 px-3 py-3', onRowClick && 'cursor-pointer active:bg-muted/50')} onClick={() => onRowClick?.(r.original)}>
                {r.getVisibleCells().filter((c) => !mobileHidden.includes(c.column.id)).map((c) => (
                  <div key={c.id} className="flex items-start justify-between gap-3 text-sm">
                    <span className="shrink-0 text-xs text-subtle">{typeof c.column.columnDef.header === 'string' ? c.column.columnDef.header : ''}</span>
                    <div className="min-w-0 text-right">{flexRender(c.column.columnDef.cell, c.getContext())}</div>
                  </div>
                ))}
              </div>
            ))}
          {!loading && data.length === 0 && <Empty />}
        </div>
      ) : (
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
      )}
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
