import * as Popover from '@radix-ui/react-popover';
import { Wrench } from 'lucide-react';
import type { AlarmType } from '@citylight/shared';
import { ERROR_CATALOG, SEVERITY_LABELS, errorOf, type ErrorDef } from '@citylight/shared';
import { cn } from '@/lib/utils';
import { Badge } from './ui';

export const SEVERITY_TONE = { critical: 'red', major: 'orange', minor: 'amber' } as const;

/** Cause + field checks for one error code. */
export function ErrorGuide({ def, compact }: { def: ErrorDef; compact?: boolean }) {
  return (
    <div className={cn('space-y-2 text-sm', compact && 'text-xs')}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="blue" className="font-mono">
          {def.code}
        </Badge>
        <span className="font-semibold">{def.title}</span>
        <Badge tone={SEVERITY_TONE[def.severity]}>{SEVERITY_LABELS[def.severity]}</Badge>
        {!def.supported && <Badge>Chờ firmware</Badge>}
      </div>
      <div>
        <span className="text-subtle">Dấu hiệu: </span>
        <span className="font-mono text-xs">{def.source}</span>
      </div>
      <div>
        <span className="text-subtle">Nguyên nhân: </span>
        {def.cause}
      </div>
      <div>
        <div className="flex items-center gap-1 text-subtle">
          <Wrench className="h-3.5 w-3.5" /> Kiểm tra / xử lý:
        </div>
        <ol className="ml-5 mt-1 list-decimal space-y-0.5">
          {def.checks.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/** Clickable code badge that opens the guide in a popover. */
export function ErrorCodeBadge({ type, code }: { type?: AlarmType; code: string | null }) {
  const def = type ? errorOf(type) : ERROR_CATALOG.find((e) => e.code === code);
  if (!code || !def) return <span className="text-subtle">—</span>;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          onClick={(e) => e.stopPropagation()}
          className="rounded bg-primary/15 px-1.5 py-0.5 font-mono text-xs font-semibold text-primary hover:bg-primary/25"
          aria-label={`Hướng dẫn mã lỗi ${code}`}
        >
          {code}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} className="z-[70] w-96 rounded-lg border bg-panel p-3 shadow-xl" onClick={(e) => e.stopPropagation()}>
          <ErrorGuide def={def} compact />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Full catalog table (Help + Admin). */
export function ErrorCatalogTable() {
  const cats = [...new Set(ERROR_CATALOG.map((e) => e.category))];
  return (
    <div className="space-y-4">
      {cats.map((cat) => (
        <div key={cat} className="overflow-x-auto rounded-lg border bg-panel">
          <div className="border-b bg-muted/50 px-3 py-2 text-sm font-semibold">{cat}</div>
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-subtle">
              <tr>
                <th className="px-3 py-1.5">Mã</th>
                <th className="px-3 py-1.5">Lỗi</th>
                <th className="px-3 py-1.5">Mức</th>
                <th className="px-3 py-1.5">Dấu hiệu</th>
                <th className="px-3 py-1.5">Nguyên nhân & xử lý</th>
              </tr>
            </thead>
            <tbody>
              {ERROR_CATALOG.filter((e) => e.category === cat).map((e) => (
                <tr key={e.code} className="border-t align-top">
                  <td className="px-3 py-2 font-mono font-semibold">{e.code}</td>
                  <td className="px-3 py-2">
                    {e.title}
                    {!e.supported && (
                      <Badge className="ml-1" tone="muted">
                        Chờ firmware
                      </Badge>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={SEVERITY_TONE[e.severity]}>{SEVERITY_LABELS[e.severity]}</Badge>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{e.source}</td>
                  <td className="px-3 py-2 text-xs">
                    <div>{e.cause}</div>
                    <ul className="ml-4 mt-1 list-disc text-subtle">
                      {e.checks.map((c) => (
                        <li key={c}>{c}</li>
                      ))}
                    </ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
