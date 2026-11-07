import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useDict } from '@/i18n';
import { ADMIN } from '@/i18n/dict/admin';

/** Same length for every value: the mask says nothing about the LTID. */
export const LTID_MASK = '•••••••';

/**
 * Hidden until opened. The API only sends an LTID to the provider role (shared/ltid.ts), so this is about who is
 * looking over the shoulder; screens render nothing for everyone else.
 */
export function Ltid({ value }: { value: string | null | undefined }) {
  const t = useDict(ADMIN).devices;
  const [open, setOpen] = useState(false);
  if (!value) return <span className="text-subtle">-</span>;
  return (
    <span className="inline-flex items-center gap-1">
      <span className="font-mono">{open ? value : LTID_MASK}</span>
      <button type="button" className="text-subtle hover:text-foreground" title={open ? t.hideLtid : t.showLtid} aria-label={open ? t.hideLtid : t.showLtid} onClick={() => setOpen(!open)}>
        {open ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </button>
    </span>
  );
}
