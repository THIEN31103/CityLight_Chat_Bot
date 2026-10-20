import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import * as DM from '@radix-ui/react-dropdown-menu';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, ChevronDown, CircleHelp, Home, Lightbulb, LogOut, Menu, Settings2, User as UserIcon, Wrench } from 'lucide-react';
import dayjs from 'dayjs';
import type { CabinetSummary, Permission } from '@citylight/shared';
import { fill, useDict, useLabels } from '@/i18n';
import { SHELL } from '@/i18n/dict/shell';
import { LangSwitch } from '../LangSwitch';
import { api } from '@/lib/api';
import { subscribe } from '@/lib/realtime';
import { useSession, useUi } from '@/stores/session';
import { cn, fmtTime } from '@/lib/utils';
import { Badge, ConfirmHost, ThemeIcon, ToastHost } from '../ui';
import { ReauthHost } from '../security';

function ServerClock() {
  const t = useDict(SHELL);
  const { data } = useQuery({ queryKey: ['server-time'], queryFn: api.serverTime, staleTime: Infinity });
  const offset = useRef(0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (data) offset.current = Date.parse(data.now) - Date.now();
  }, [data]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() + offset.current), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="hidden text-right leading-tight md:block" title={t.serverTime}>
      <div className="font-mono text-sm tabular-nums">{dayjs(now).format('HH:mm:ss')}</div>
      <div className="text-[11px] text-subtle">{dayjs(now).format('DD/MM/YYYY')}</div>
    </div>
  );
}

/**
 * Keeps React Query caches fresh from realtime events (Socket.IO / mock emitter).
 * 10k cabinets: state deltas are patched into the cached map list (batched each second) instead of
 * refetching ~1 MB; only the small counters endpoint is refetched.
 */
function RealtimeBridge() {
  const qc = useQueryClient();
  useEffect(() => {
    const pending = new Map<string, Partial<CabinetSummary> & { cabinetId: string }>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      const updates = new Map(pending);
      pending.clear();
      qc.setQueryData<CabinetSummary[]>(['map-cabinets'], (old) =>
        old?.map((c) => {
          const u = updates.get(c.id);
          return u ? { ...c, status: u.status ?? c.status, branch1On: u.branch1On ?? c.branch1On, branch2On: u.branch2On ?? c.branch2On } : c;
        }),
      );
      qc.invalidateQueries({ queryKey: ['map-stats'] });
    };
    const offState = subscribe<Partial<CabinetSummary> & { cabinetId: string }>('cabinet.state', (s) => {
      pending.set(s.cabinetId, s);
      if (!timer) timer = setTimeout(flush, 1000);
    });
    const offAlarm = subscribe('alarm.raised', () => qc.invalidateQueries({ queryKey: ['alarms'] }));
    const offClear = subscribe('alarm.cleared', () => qc.invalidateQueries({ queryKey: ['alarms'] }));
    return () => {
      offState();
      offAlarm();
      offClear();
      if (timer) clearTimeout(timer);
    };
  }, [qc]);
  return null;
}

function AlarmBell() {
  const t = useDict(SHELL);
  const L = useLabels();
  const nav = useNavigate();
  const { data } = useQuery({ queryKey: ['alarms', 'bell'], queryFn: () => api.alarms({ active: true, size: 10 }), refetchInterval: 30000 });
  const count = data?.total ?? 0;
  return (
    <DM.Root>
      <DM.Trigger asChild>
        <button className="relative rounded-md p-2 hover:bg-muted" aria-label={fill(t.bellLabel, { n: count })}>
          <Bell className="h-5 w-5" />
          {count > 0 && (
            <span className="absolute -right-0.5 -top-0.5 min-w-[18px] rounded-full bg-st-offline px-1 text-center text-[10px] font-semibold leading-[18px] text-white">
              {count > 99 ? '99+' : count}
            </span>
          )}
        </button>
      </DM.Trigger>
      <DM.Portal>
        <DM.Content align="end" sideOffset={6} className="z-50 w-96 rounded-lg border bg-panel shadow-xl">
          <div className="border-b px-3 py-2 text-sm font-semibold">{t.latestAlarms}</div>
          <div className="max-h-96 overflow-auto">
            {data?.items.length ? (
              data.items.map((a) => (
                <DM.Item key={a.id} onSelect={() => nav(`/?cabinet=${a.cabinetId}`)} className="cursor-pointer border-b px-3 py-2 outline-none last:border-0 hover:bg-muted data-[highlighted]:bg-muted">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">
                      <span className="mr-1 font-mono text-xs text-primary">{a.code}</span>
                      {a.cabinetCode} · {a.cabinetName}
                    </span>
                    <Badge tone={a.severity === 'critical' ? 'red' : a.severity === 'major' ? 'orange' : 'amber'}>{L.severity[a.severity]}</Badge>
                  </div>
                  <div className="truncate text-xs text-subtle">{a.message}</div>
                  <div className="text-[11px] text-subtle">{fmtTime(a.startedAt)}</div>
                </DM.Item>
              ))
            ) : (
              <div className="px-3 py-6 text-center text-sm text-subtle">{t.noNewAlarms}</div>
            )}
          </div>
          <DM.Item onSelect={() => nav('/alarms')} className="cursor-pointer border-t px-3 py-2 text-center text-sm text-primary outline-none hover:bg-muted">
            {t.seeAll}
          </DM.Item>
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

interface MenuEntry {
  label: string;
  to: string;
  perm?: Permission;
}

function NavMenu({ label, icon: Icon, items }: { label: string; icon: React.ComponentType<{ className?: string }>; items: MenuEntry[] }) {
  const nav = useNavigate();
  const can = useSession((s) => s.can);
  const visible = items.filter((i) => !i.perm || can(i.perm));
  if (!visible.length) return null;
  return (
    <DM.Root>
      <DM.Trigger asChild>
        <button className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-2 text-sm hover:bg-muted">
          <Icon className="h-4 w-4" />
          <span className="hidden lg:inline">{label}</span>
          <ChevronDown className="h-3.5 w-3.5 text-subtle" />
        </button>
      </DM.Trigger>
      <DM.Portal>
        <DM.Content align="start" sideOffset={6} className="z-50 min-w-[220px] rounded-lg border bg-panel p-1 shadow-xl">
          {visible.map((i) => (
            <DM.Item key={i.to} onSelect={() => nav(i.to)} className="cursor-pointer rounded px-2.5 py-1.5 text-sm outline-none hover:bg-muted data-[highlighted]:bg-muted">
              {i.label}
            </DM.Item>
          ))}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

type ShellText = (typeof SHELL)['vi'];

const incidentMenu = (t: ShellText): MenuEntry[] => [
  { label: t.incidentMenu.new, to: '/incidents?q=new' },
  { label: t.incidentMenu.assigned, to: '/incidents?q=assigned' },
  { label: t.incidentMenu.deferredResolved, to: '/incidents?q=deferred_resolved' },
  { label: t.incidentMenu.all, to: '/incidents?q=all' },
  { label: t.incidentMenu.report, to: '/incidents/report' },
];

const functionMenu = (t: ShellText): MenuEntry[] => [
  { label: t.functionMenu.alarms, to: '/alarms', perm: 'alarm.view' },
  { label: t.functionMenu.schedules, to: '/schedules', perm: 'schedule.manage' },
  { label: t.functionMenu.dimming, to: '/dimming', perm: 'dimming.manage' },
  { label: t.functionMenu.batches, to: '/batches', perm: 'batch.run' },
  { label: t.functionMenu.activityLog, to: '/logs/activity', perm: 'log.view' },
  { label: t.functionMenu.syncLog, to: '/logs/sync', perm: 'log.view' },
  { label: t.functionMenu.admin, to: '/admin/users', perm: 'admin.users' },
  { label: t.functionMenu.system, to: '/system', perm: 'system.view' },
];

export function AppShell() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { user, setUser } = useSession();
  const { theme, toggleTheme } = useUi();
  const t = useDict(SHELL);
  const L = useLabels();

  async function logout() {
    await api.logout().catch(() => undefined);
    setUser(null);
    qc.clear();
    nav('/login', { replace: true });
  }

  return (
    <div className="flex h-full flex-col">
      <header className="z-30 flex h-14 shrink-0 items-center gap-2 border-b bg-panel px-3">
        <Link to="/" className="mr-2 flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-white">
            <Lightbulb className="h-4 w-4" />
          </div>
          <span className="hidden font-semibold sm:inline">CityLight</span>
        </Link>
        <NavLink to="/" end className={({ isActive }) => cn('rounded-md p-2 hover:bg-muted', isActive && 'bg-muted')} aria-label={t.home}>
          <Home className="h-4 w-4" />
        </NavLink>
        <NavMenu label={t.incidents} icon={Wrench} items={incidentMenu(t).map((i) => ({ ...i, perm: 'incident.view' as Permission }))} />
        <NavMenu label={t.functions} icon={Menu} items={functionMenu(t)} />
        <div className="flex-1" />
        <ServerClock />
        <AlarmBell />
        <LangSwitch className="hidden sm:flex" />
        <button className="rounded-md p-2 hover:bg-muted" onClick={toggleTheme} aria-label={t.themeToggle}>
          <ThemeIcon dark={theme === 'dark'} />
        </button>
        <DM.Root>
          <DM.Trigger asChild>
            <button className="rounded-md p-2 hover:bg-muted" aria-label={t.help}>
              <CircleHelp className="h-5 w-5" />
            </button>
          </DM.Trigger>
          <DM.Portal>
            <DM.Content align="end" sideOffset={6} className="z-50 min-w-[200px] rounded-lg border bg-panel p-1 shadow-xl">
              <DM.Item onSelect={() => nav('/help')} className="cursor-pointer rounded px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-muted">
                {t.userGuide}
              </DM.Item>
              <DM.Item onSelect={() => nav('/help#about')} className="cursor-pointer rounded px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-muted">
                {t.about}
              </DM.Item>
            </DM.Content>
          </DM.Portal>
        </DM.Root>
        <DM.Root>
          <DM.Trigger asChild>
            <button className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-muted">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted">
                <UserIcon className="h-4 w-4" />
              </div>
              <div className="hidden text-left leading-tight md:block">
                <div className="text-sm font-medium">{user?.fullName}</div>
                <div className="text-[11px] text-subtle">{user ? L.role[user.role] : ''}</div>
              </div>
            </button>
          </DM.Trigger>
          <DM.Portal>
            <DM.Content align="end" sideOffset={6} className="z-50 min-w-[200px] rounded-lg border bg-panel p-1 shadow-xl">
              <DM.Item onSelect={() => nav('/account')} className="flex cursor-pointer items-center gap-2 rounded px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-muted">
                <Settings2 className="h-4 w-4" /> {t.account}
              </DM.Item>
              <DM.Item onSelect={logout} className="flex cursor-pointer items-center gap-2 rounded px-2.5 py-1.5 text-sm text-st-offline outline-none data-[highlighted]:bg-muted">
                <LogOut className="h-4 w-4" /> {t.logout}
              </DM.Item>
            </DM.Content>
          </DM.Portal>
        </DM.Root>
      </header>
      <main className="relative min-h-0 flex-1 overflow-auto">
        <Outlet />
      </main>
      <RealtimeBridge />
      <ConfirmHost />
      <ReauthHost />
      <ToastHost />
    </div>
  );
}
