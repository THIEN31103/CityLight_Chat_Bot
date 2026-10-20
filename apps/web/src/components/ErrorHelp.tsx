import * as Popover from '@radix-ui/react-popover';
import { Wrench } from 'lucide-react';
import type { AlarmType } from '@citylight/shared';
import { ERROR_CATEGORY_LABELS, errorCatalog, type ErrorDef } from '@citylight/shared';
import { cn } from '@/lib/utils';
import { fill, useDict, useLabels, useLang } from '@/i18n';
import { ERROR_HELP } from '@/i18n/dict/error-help';
import { Badge } from './ui';

export const SEVERITY_TONE = { critical: 'red', major: 'orange', minor: 'amber' } as const;

/** The catalog in the UI language. */
function useCatalog(): ErrorDef[] {
  return errorCatalog(useLang((s) => s.lang));
}

/** Cause + field checks for one error code (any language's `def` is shown in the UI language). */
export function ErrorGuide({ def, compact }: { def: ErrorDef; compact?: boolean }) {
  const t = useDict(ERROR_HELP);
  const L = useLabels();
  const d = useCatalog().find((e) => e.code === def.code) ?? def;
  return (
    <div className={cn('space-y-2 text-sm', compact && 'text-xs')}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="blue" className="font-mono">
          {d.code}
        </Badge>
        <span className="font-semibold">{d.title}</span>
        <Badge tone={SEVERITY_TONE[d.severity]}>{L.severity[d.severity]}</Badge>
        {!d.supported && <Badge>{t.awaitingFirmware}</Badge>}
      </div>
      <div>
        <span className="text-subtle">{t.evidence}</span>
        <span className="font-mono text-xs">{d.source}</span>
      </div>
      <div>
        <span className="text-subtle">{t.cause}</span>
        {d.cause}
      </div>
      <div>
        <div className="flex items-center gap-1 text-subtle">
          <Wrench className="h-3.5 w-3.5" /> {t.checks}
        </div>
        <ol className="ml-5 mt-1 list-decimal space-y-0.5">
          {d.checks.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/** Clickable code badge that opens the guide in a popover. */
export function ErrorCodeBadge({ type, code }: { type?: AlarmType; code: string | null }) {
  const t = useDict(ERROR_HELP);
  const catalog = useCatalog();
  const def = type ? catalog.find((e) => e.type === type) : catalog.find((e) => e.code === code);
  if (!code || !def) return <span className="text-subtle">—</span>;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          onClick={(e) => e.stopPropagation()}
          className="rounded bg-primary/15 px-1.5 py-0.5 font-mono text-xs font-semibold text-primary hover:bg-primary/25"
          aria-label={fill(t.guideFor, { code })}
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
  const t = useDict(ERROR_HELP);
  const L = useLabels();
  const lang = useLang((s) => s.lang);
  const catalog = errorCatalog(lang);
  const cats = [...new Set(catalog.map((e) => e.category))];
  return (
    <div className="space-y-4">
      {cats.map((cat) => (
        <div key={cat} className="overflow-x-auto rounded-lg border bg-panel">
          <div className="border-b bg-muted/50 px-3 py-2 text-sm font-semibold">{ERROR_CATEGORY_LABELS[lang][cat]}</div>
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-subtle">
              <tr>
                <th className="px-3 py-1.5">{t.colCode}</th>
                <th className="px-3 py-1.5">{t.colError}</th>
                <th className="px-3 py-1.5">{t.colSeverity}</th>
                <th className="px-3 py-1.5">{t.colEvidence}</th>
                <th className="px-3 py-1.5">{t.colCause}</th>
              </tr>
            </thead>
            <tbody>
              {catalog
                .filter((e) => e.category === cat)
                .map((e) => (
                  <tr key={e.code} className="border-t align-top">
                    <td className="px-3 py-2 font-mono font-semibold">{e.code}</td>
                    <td className="px-3 py-2">
                      {e.title}
                      {!e.supported && (
                        <Badge className="ml-1" tone="muted">
                          {t.awaitingFirmware}
                        </Badge>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={SEVERITY_TONE[e.severity]}>{L.severity[e.severity]}</Badge>
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
