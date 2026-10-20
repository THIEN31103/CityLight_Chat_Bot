import * as React from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as RTabs from '@radix-ui/react-tabs';
import { AlertTriangle, CircleDot, Loader2, Moon, PowerOff, Sun, WifiOff, X, HelpCircle, Lightbulb } from 'lucide-react';
import type { CabinetStatus } from '@citylight/shared';
import { useDict, useLabels } from '@/i18n';
import { COMMON } from '@/i18n/dict/common';
import { create } from 'zustand';
import { cn } from '@/lib/utils';

// ---------- Button ----------

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-primary text-white hover:opacity-90',
  secondary: 'bg-muted text-fg hover:bg-border',
  ghost: 'hover:bg-muted text-fg',
  danger: 'bg-st-offline text-white hover:opacity-90',
  outline: 'border bg-panel hover:bg-muted text-fg',
};

export const Button = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'icon'; loading?: boolean }
>(({ className, variant = 'primary', size = 'md', loading, children, disabled, ...props }, ref) => (
  <button
    ref={ref}
    disabled={disabled || loading}
    className={cn(
      'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50',
      size === 'sm' && 'h-8 px-2.5 text-xs',
      size === 'md' && 'h-9 px-3.5 text-sm',
      size === 'icon' && 'h-8 w-8',
      VARIANTS[variant],
      className,
    )}
    {...props}
  >
    {loading && <Loader2 className="h-4 w-4 animate-spin" />}
    {children}
  </button>
));
Button.displayName = 'Button';

// ---------- Layout bits ----------

export function Card({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-lg border bg-panel', className)} {...p} />;
}

export function CardHeader({ title, actions, subtitle }: { title: React.ReactNode; subtitle?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b px-4 py-3">
      <div>
        <div className="font-semibold">{title}</div>
        {subtitle && <div className="text-xs text-subtle">{subtitle}</div>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {subtitle && <p className="text-sm text-subtle">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Badge({ className, tone = 'muted', children }: { className?: string; tone?: 'muted' | 'red' | 'orange' | 'amber' | 'green' | 'blue' | 'purple'; children: React.ReactNode }) {
  const tones = {
    muted: 'bg-muted text-subtle',
    red: 'bg-st-offline/15 text-st-offline',
    orange: 'bg-st-fault/15 text-st-fault',
    amber: 'bg-st-dimming/15 text-st-dimming',
    green: 'bg-st-on/15 text-st-on',
    blue: 'bg-primary/15 text-primary',
    purple: 'bg-st-unknown/15 text-st-unknown',
  };
  return <span className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium', tones[tone], className)}>{children}</span>;
}

export const STATUS_ICON: Record<CabinetStatus, React.ComponentType<{ className?: string }>> = {
  offline: WifiOff,
  fault: AlertTriangle,
  dimming: CircleDot,
  on: Lightbulb,
  off: PowerOff,
  unknown: HelpCircle,
};

export const STATUS_TONE: Record<CabinetStatus, 'red' | 'orange' | 'amber' | 'green' | 'muted' | 'purple'> = {
  offline: 'red',
  fault: 'orange',
  dimming: 'amber',
  on: 'green',
  off: 'muted',
  unknown: 'purple',
};

/** Status shown with icon + text + colour (never colour alone). */
export function StatusBadge({ status, className }: { status: CabinetStatus; className?: string }) {
  const Icon = STATUS_ICON[status];
  const L = useLabels();
  return (
    <Badge tone={STATUS_TONE[status]} className={className}>
      <Icon className="h-3.5 w-3.5" />
      {L.status[status]}
    </Badge>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('h-5 w-5 animate-spin text-subtle', className)} />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded bg-muted', className)} />;
}

export function Empty({ children }: { children?: React.ReactNode }) {
  const c = useDict(COMMON);
  return <div className="py-10 text-center text-sm text-subtle">{children ?? c.noData}</div>;
}

export function Unsupported({ children }: { children?: React.ReactNode }) {
  const c = useDict(COMMON);
  return (
    <div className="flex items-center gap-2 rounded-md border border-dashed bg-muted/50 px-3 py-2 text-xs text-subtle">
      <HelpCircle className="h-4 w-4 shrink-0" />
      {children ?? c.unsupported}
    </div>
  );
}

// ---------- Form ----------

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...p }, ref) => (
  <input
    ref={ref}
    className={cn('h-9 w-full rounded-md border bg-panel px-3 text-sm outline-none placeholder:text-subtle focus:ring-2 focus:ring-primary/50', className)}
    {...p}
  />
));
Input.displayName = 'Input';

export function Select({ className, children, ...p }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn('h-9 rounded-md border bg-panel px-2 text-sm outline-none focus:ring-2 focus:ring-primary/50', className)} {...p}>
      {children}
    </select>
  );
}

export function Textarea({ className, ...p }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn('min-h-[80px] w-full rounded-md border bg-panel px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/50', className)} {...p} />;
}

export function Field({ label, hint, children, className }: { label: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <label className={cn('block space-y-1', className)}>
      <span className="text-xs font-medium text-subtle">{label}</span>
      {children}
      {hint && <span className="block text-xs text-subtle">{hint}</span>}
    </label>
  );
}

export function Checkbox({ label, checked, onChange, disabled }: { label?: React.ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={cn('inline-flex cursor-pointer select-none items-center gap-2 text-sm', disabled && 'cursor-not-allowed opacity-50')}>
      <input type="checkbox" className="h-4 w-4 accent-[rgb(var(--primary))]" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn('relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition disabled:opacity-50', checked ? 'bg-primary' : 'bg-border')}
    >
      <span className={cn('inline-block h-4 w-4 rounded-full bg-white shadow transition', checked ? 'translate-x-4' : 'translate-x-0.5')} />
    </button>
  );
}

export function KV({ label, value, className }: { label: React.ReactNode; value: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-baseline justify-between gap-3 border-b border-dashed py-1.5 text-sm last:border-0', className)}>
      <span className="text-subtle">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

// ---------- Dialogs ----------

export function Modal({
  open,
  onOpenChange,
  title,
  children,
  footer,
  className,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}) {
  const c = useDict(COMMON);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/40" />
        <Dialog.Content className={cn('fixed left-1/2 top-1/2 z-[61] max-h-[90vh] w-[min(560px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-lg border bg-panel shadow-xl', className)}>
          <div className="flex items-center justify-between border-b px-4 py-3">
            <Dialog.Title className="font-semibold">{title}</Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label={c.close}>
                <X className="h-4 w-4" />
              </Button>
            </Dialog.Close>
          </div>
          <Dialog.Description asChild>
            <div className="px-4 py-3 text-sm">{children}</div>
          </Dialog.Description>
          {footer && <div className="flex justify-end gap-2 border-t px-4 py-3">{footer}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

interface ConfirmState {
  open: boolean;
  title: string;
  body: React.ReactNode;
  danger: boolean;
  confirmLabel: string;
  resolve: ((ok: boolean) => void) | null;
}
const useConfirmStore = create<ConfirmState>(() => ({ open: false, title: '', body: null, danger: false, confirmLabel: '', resolve: null }));

/** Promise-based confirm dialog: `if (await confirm({...})) ...` */
export function confirm(o: { title: string; body: React.ReactNode; danger?: boolean; confirmLabel?: string }): Promise<boolean> {
  return new Promise((resolve) => {
    useConfirmStore.setState({ open: true, title: o.title, body: o.body, danger: !!o.danger, confirmLabel: o.confirmLabel ?? '', resolve });
  });
}

export function ConfirmHost() {
  const s = useConfirmStore();
  const c = useDict(COMMON);
  const close = (ok: boolean) => {
    s.resolve?.(ok);
    useConfirmStore.setState({ open: false, resolve: null });
  };
  return (
    <Modal
      open={s.open}
      onOpenChange={(v) => !v && close(false)}
      title={s.title}
      footer={
        <>
          <Button variant="outline" onClick={() => close(false)}>
            {c.cancel}
          </Button>
          <Button variant={s.danger ? 'danger' : 'primary'} onClick={() => close(true)}>
            {s.confirmLabel || c.confirm}
          </Button>
        </>
      }
    >
      {s.body}
    </Modal>
  );
}

// ---------- Toast ----------

interface ToastItem {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
}
const useToasts = create<{ items: ToastItem[] }>(() => ({ items: [] }));
let toastSeq = 1;
export function toast(text: string, kind: ToastItem['kind'] = 'info') {
  const id = toastSeq++;
  useToasts.setState((s) => ({ items: [...s.items, { id, kind, text }] }));
  setTimeout(() => useToasts.setState((s) => ({ items: s.items.filter((t) => t.id !== id) })), 4000);
}
export function ToastHost() {
  const items = useToasts((s) => s.items);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[80] flex w-80 flex-col gap-2">
      {items.map((t) => (
        <div
          key={t.id}
          role="status"
          className={cn(
            'pointer-events-auto rounded-md border bg-panel px-3 py-2 text-sm shadow-lg',
            t.kind === 'success' && 'border-st-on/50',
            t.kind === 'error' && 'border-st-offline/60',
          )}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}

// ---------- Tabs ----------

export const Tabs = RTabs.Root;
export function TabsList({ className, ...p }: React.ComponentProps<typeof RTabs.List>) {
  return <RTabs.List className={cn('flex gap-1 overflow-x-auto border-b px-2', className)} {...p} />;
}
export function TabsTrigger({ className, ...p }: React.ComponentProps<typeof RTabs.Trigger>) {
  return (
    <RTabs.Trigger
      className={cn(
        '-mb-px whitespace-nowrap border-b-2 border-transparent px-2.5 py-2 text-sm text-subtle hover:text-fg data-[state=active]:border-primary data-[state=active]:font-medium data-[state=active]:text-fg',
        className,
      )}
      {...p}
    />
  );
}
export const TabsContent = RTabs.Content;

export function ThemeIcon({ dark }: { dark: boolean }) {
  return dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />;
}
