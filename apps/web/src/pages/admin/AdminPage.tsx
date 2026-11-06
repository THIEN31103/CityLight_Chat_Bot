import { Fragment, useState } from 'react';
import { Navigate, NavLink, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff, Plus, QrCode } from 'lucide-react';
import type { AlarmType, Permission, RoleKey } from '@citylight/shared';
import { LAMP_GROUP_LABELS, ROLE_PERMISSIONS, alarmTypeLabels, assignableRoles, hasPermission, parseCabinetCode, roleRequires2fa, roleSeesAll } from '@citylight/shared';
import { api, ApiError, type AdminUser, type UnknownDevice } from '@/lib/api';
import { useSession } from '@/stores/session';
import { ScopePicker, scopeLabel, useAreaNames, type ScopeValue } from '@/components/security';
import { cn, fmtTime } from '@/lib/utils';
import { dictNow, fill, useDict, useLabels, useLang } from '@/i18n';
import { COMMON } from '@/i18n/dict/common';
import { ADMIN, PERMISSION_LABELS } from '@/i18n/dict/admin';
import { Badge, Button, Card, CardHeader, Checkbox, Field, Input, Modal, PageHeader, Select, Spinner, Toggle, confirm, toast } from '@/components/ui';
import { ErrorCatalogTable } from '@/components/ErrorHelp';
import { ForbiddenPage } from '@/pages/ErrorPages';
import { Ltid } from '@/components/Ltid';
import { useIsMobile } from '@/lib/useIsMobile';
import { QrScanner } from '@/components/QrScanner';

const TABS: { id: string; label: keyof (typeof ADMIN)['vi']['tabs']; perm: Permission }[] = [
  { id: 'users', label: 'users', perm: 'admin.users' },
  { id: 'roles', label: 'roles', perm: 'admin.users' },
  { id: 'areas', label: 'areas', perm: 'admin.users' },
  { id: 'zones', label: 'zones', perm: 'admin.users' },
  // an account granted cabinet approval reaches this tab and no other
  { id: 'devices', label: 'devices', perm: 'device.enroll' },
  { id: 'field-map', label: 'fieldMap', perm: 'device.identity' },
  { id: 'alarm-rules', label: 'alarmRules', perm: 'admin.users' },
  { id: 'settings', label: 'settings', perm: 'admin.users' },
];

export function AdminPage() {
  const { tab = 'users' } = useParams();
  const can = useSession((s) => s.can);
  const a = useDict(ADMIN);
  const tabs = TABS.filter((t) => can(t.perm));
  if (!tabs.length) return <ForbiddenPage />;
  if (!tabs.some((t) => t.id === tab)) return <Navigate to={`/admin/${tabs[0]!.id}`} replace />;
  return (
    <div className="flex h-full max-md:flex-col">
      <aside className={cn('w-56 shrink-0 border-r bg-panel p-2 max-md:flex max-md:w-full max-md:gap-1 max-md:overflow-x-auto max-md:border-b max-md:border-r-0', tabs.length < 2 && 'max-md:hidden')}>
        <div className="mb-1 px-2 text-xs font-semibold uppercase text-subtle max-md:hidden">{a.title}</div>
        {tabs.map((t) => (
          <NavLink key={t.id} to={`/admin/${t.id}`} className={({ isActive }) => cn('block rounded px-2 py-1.5 text-sm hover:bg-muted max-md:shrink-0 max-md:whitespace-nowrap', isActive && 'bg-primary/10 font-medium')}>
            {a.tabs[t.label]}
          </NavLink>
        ))}
      </aside>
      <div className="min-h-0 min-w-0 flex-1 overflow-auto p-4 max-md:p-3">
        {tab === 'users' && <UsersAdmin />}
        {tab === 'roles' && <RolesAdmin />}
        {tab === 'areas' && <AreasAdmin />}
        {tab === 'zones' && <ZonesAdmin />}
        {tab === 'devices' && <DevicesAdmin />}
        {tab === 'field-map' && can('device.identity') && <FieldMapAdmin />}
        {tab === 'alarm-rules' && <AlarmRulesAdmin />}
        {tab === 'settings' && <SettingsAdmin />}
      </div>
    </div>
  );
}

function UsersAdmin() {
  const qc = useQueryClient();
  const me = useSession((s) => s.user);
  const names = useAreaNames();
  const t = useDict(ADMIN).users;
  const c = useDict(COMMON);
  const L = useLabels();
  const { data, isLoading } = useQuery({ queryKey: ['users'], queryFn: api.users });
  // S47: only roles below one's own (the provider: all); accounts at or above are listed read-only
  const roleChoices = me ? assignableRoles(me.role) : [];
  const [open, setOpen] = useState(false);
  const blank = { email: '', fullName: '', role: 'viewer' as RoleKey, scopeAll: false, scopeAreaIds: [] as string[], canEnroll: false };
  const [form, setForm] = useState(blank);
  const [scopeEdit, setScopeEdit] = useState<{ user: AdminUser; value: ScopeValue } | null>(null);
  const [secret, setSecret] = useState<{ email: string; tempPassword: string; created: boolean } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['users'] });
  const fail = (e: unknown) => toast(e instanceof ApiError ? e.message : dictNow(COMMON).error, 'error');

  const create = useMutation({
    mutationFn: () => api.createUser(form),
    onSuccess: (r) => {
      setOpen(false);
      setForm(blank);
      setSecret({ email: r.user.email, tempPassword: r.tempPassword, created: true });
      refresh();
    },
    onError: fail,
  });
  const update = useMutation({
    mutationFn: (p: { id: string; patch: Parameters<typeof api.updateUser>[1] }) => api.updateUser(p.id, p.patch),
    onSuccess: () => {
      setScopeEdit(null);
      refresh();
    },
    onError: fail,
  });
  const resetPw = useMutation({
    mutationFn: (u: AdminUser) => api.resetUserPassword(u.id),
    onSuccess: (r) => {
      setSecret({ email: r.user.email, tempPassword: r.tempPassword, created: false });
      refresh();
    },
    onError: fail,
  });
  const unlock = useMutation({ mutationFn: (u: AdminUser) => api.unlockUser(u.id), onSuccess: () => { toast(dictNow(ADMIN).users.unlocked, 'success'); refresh(); }, onError: fail });
  const reset2fa = useMutation({ mutationFn: (u: AdminUser) => api.resetUser2fa(u.id), onSuccess: () => { toast(dictNow(ADMIN).users.reset2faDone, 'success'); refresh(); }, onError: fail });

  const ask = async (title: string, body: string, run: () => void) => {
    if (await confirm({ title, body, danger: true })) run();
  };

  return (
    <>
      <PageHeader
        title={t.title}
        subtitle={t.subtitle}
        actions={<Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> {t.add}</Button>}
      />
      <Card className="overflow-x-auto">
        {isLoading ? (
          <div className="p-6"><Spinner /></div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/60 text-left text-xs text-subtle">
              <tr><th className="px-3 py-2">{t.col.fullName}</th><th className="px-3 py-2">{t.col.email}</th><th className="px-3 py-2">{t.col.role}</th><th className="px-3 py-2">{t.col.scope}</th><th className="px-3 py-2">{t.col.canEnroll}</th><th className="px-3 py-2">{t.col.totp}</th><th className="px-3 py-2">{t.col.lastLogin}</th><th className="px-3 py-2">{t.col.active}</th><th className="px-3 py-2" /></tr>
            </thead>
            <tbody>
              {data?.map((u) => {
                const self = u.id === me?.id;
                const locked = self || u.manageable === false;
                return (
                  <tr key={u.id} className="border-t align-top">
                    <td className="px-3 py-2 font-medium">
                      {u.fullName} {self && <Badge tone="blue">{t.you}</Badge>}
                      {u.passwordChangeRequired && <div className="text-xs font-normal text-st-fault">{t.tempNotChanged}</div>}
                      {u.lockedUntil && <div className="text-xs font-normal text-st-offline">{fill(t.lockedUntil, { time: fmtTime(u.lockedUntil) })}</div>}
                    </td>
                    <td className="px-3 py-2">{u.email}</td>
                    <td className="px-3 py-2">
                      {locked ? (
                        <Badge tone={u.role === 'admin' ? 'blue' : undefined}>{L.role[u.role]}</Badge>
                      ) : (
                        <Select value={u.role} onChange={(e) => update.mutate({ id: u.id, patch: { role: e.target.value as RoleKey } })} className="h-8">
                          {roleChoices.map((k) => <option key={k} value={k}>{L.role[k]}</option>)}
                        </Select>
                      )}
                    </td>
                    <td className="max-w-[16rem] px-3 py-2 text-xs">
                      <span className={cn(!u.scopeAll && !u.scopeAreaIds.length && 'text-st-fault')}>{roleSeesAll(u.role) ? t.scopeAllByRole : scopeLabel(u, names)}</span>
                      {!locked && !roleSeesAll(u.role) && (
                        <button className="ml-1 text-primary hover:underline" onClick={() => setScopeEdit({ user: u, value: { scopeAll: u.scopeAll, scopeAreaIds: u.scopeAreaIds } })}>{c.edit}</button>
                      )}
                    </td>
                    <td className="px-3 py-2" title={hasPermission(u.role, 'device.enroll') ? t.canEnrollByRole : t.canEnrollHint}>
                      <Checkbox checked={u.canEnroll} disabled={locked || hasPermission(u.role, 'device.enroll')} onChange={(v) => update.mutate({ id: u.id, patch: { canEnroll: v } })} />
                    </td>
                    <td className="px-3 py-2">
                      {u.totpEnabled ? <Badge tone="green">{t.totpOn}</Badge> : u.totpRequired ? <Badge tone="orange">{t.totpRequiredOff}</Badge> : <Badge>{t.totpOff}</Badge>}
                    </td>
                    <td className="px-3 py-2 text-xs">{fmtTime(u.lastLoginAt)}</td>
                    <td className="px-3 py-2"><Toggle checked={u.active} disabled={locked} onChange={(v) => update.mutate({ id: u.id, patch: { active: v } })} label={t.activate} /></td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs">
                      {!self && u.manageable === false && <span className="text-subtle">{t.readOnly}</span>}
                      {!locked && (
                        <div className="flex flex-col items-start gap-1">
                          <button className="text-primary hover:underline" onClick={() => ask(t.resetPasswordAsk, fill(t.resetPasswordBody, { email: u.email }), () => resetPw.mutate(u))}>{t.resetPassword}</button>
                          {u.totpEnabled && <button className="text-primary hover:underline" onClick={() => ask(t.reset2faAsk, fill(t.reset2faBody, { email: u.email }), () => reset2fa.mutate(u))}>{t.reset2fa}</button>}
                          {u.lockedUntil && <button className="text-primary hover:underline" onClick={() => unlock.mutate(u)}>{t.unlock}</button>}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      <Modal open={open} onOpenChange={setOpen} title={t.add} footer={<><Button variant="outline" onClick={() => setOpen(false)}>{c.cancel}</Button><Button disabled={!form.email || !form.fullName} loading={create.isPending} onClick={() => create.mutate()}>{c.create}</Button></>}>
        <div className="space-y-3">
          <Field label={t.col.fullName}><Input value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} /></Field>
          <Field label={t.col.email}><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label={t.col.role} hint={roleRequires2fa(form.role) ? t.roleNeeds2fa : undefined}>
            <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as RoleKey })} className="w-full">
              {roleChoices.map((k) => <option key={k} value={k}>{L.role[k]}</option>)}
            </Select>
          </Field>
          {roleSeesAll(form.role) ? (
            <p className="text-xs text-subtle">{fill(t.roleSeesAll, { role: L.role[form.role] })}</p>
          ) : (
            <Field label={t.scopeField}><ScopePicker value={form} onChange={(v) => setForm({ ...form, ...v })} /></Field>
          )}
          {!hasPermission(form.role, 'device.enroll') && <Checkbox label={t.canEnrollField} checked={form.canEnroll} onChange={(v) => setForm({ ...form, canEnroll: v })} />}
          <p className="text-xs text-subtle">{t.tempNote}</p>
        </div>
      </Modal>

      <Modal
        open={!!scopeEdit}
        onOpenChange={(v) => !v && setScopeEdit(null)}
        title={fill(t.scopeTitle, { name: scopeEdit?.user.fullName ?? '' })}
        footer={<><Button variant="outline" onClick={() => setScopeEdit(null)}>{c.cancel}</Button><Button loading={update.isPending} onClick={() => scopeEdit && update.mutate({ id: scopeEdit.user.id, patch: scopeEdit.value })}>{c.save}</Button></>}
      >
        {scopeEdit && <ScopePicker value={scopeEdit.value} onChange={(v) => setScopeEdit({ ...scopeEdit, value: v })} />}
        <p className="mt-2 text-xs text-subtle">{t.scopeSaveNote}</p>
      </Modal>

      <Modal open={!!secret} onOpenChange={(v) => !v && setSecret(null)} title={secret?.created ? t.created : t.passwordReset} footer={<Button onClick={() => setSecret(null)}>{t.sentToUser}</Button>}>
        {secret && (
          <div className="space-y-2">
            <p>{t.tempFor} <b>{secret.email}</b> {t.tempOnce}</p>
            <div className="flex items-center gap-2">
              <code className="rounded bg-muted px-2 py-1 font-mono text-base">{secret.tempPassword}</code>
              <Button size="sm" variant="outline" onClick={() => navigator.clipboard?.writeText(secret.tempPassword).then(() => toast(dictNow(COMMON).copied, 'success'))}>{c.copy}</Button>
            </div>
            <p className="text-xs text-subtle">{t.mustChange}</p>
          </div>
        )}
      </Modal>
    </>
  );
}

function RolesAdmin() {
  const t = useDict(ADMIN).roles;
  const L = useLabels();
  const P = useDict(PERMISSION_LABELS);
  const perms = [...new Set(Object.values(ROLE_PERMISSIONS).flat())];
  const roles = Object.keys(L.role) as RoleKey[];
  return (
    <>
      <PageHeader title={t.title} subtitle={t.subtitle} />
      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs text-subtle">
            <tr><th className="px-3 py-2">{t.permission}</th>{roles.map((r) => <th key={r} className="px-3 py-2 text-center">{L.role[r]}</th>)}</tr>
          </thead>
          <tbody>
            {perms.map((p) => (
              <tr key={p} className="border-t">
                <td className="px-3 py-1.5">
                  {P[p] ?? p} <span className="ml-1 font-mono text-[11px] text-subtle">{p}</span>
                </td>
                {roles.map((r) => <td key={r} className="px-3 py-1.5 text-center">{ROLE_PERMISSIONS[r].includes(p) ? '✔' : ''}</td>)}
              </tr>
            ))}
            <tr className="border-t bg-muted/30">
              <td className="px-3 py-1.5 text-xs">{t.requires2fa}</td>
              {roles.map((r) => <td key={r} className="px-3 py-1.5 text-center">{roleRequires2fa(r) ? '✔' : ''}</td>)}
            </tr>
          </tbody>
        </table>
      </Card>
    </>
  );
}

const errToast = (e: unknown) => toast(e instanceof ApiError ? e.message : dictNow(COMMON).error, 'error');

/** Small inline "name" editor used by the catalog tables. */
async function askName(title: string, current = ''): Promise<string | null> {
  const v = window.prompt(title, current);
  return v && v.trim() ? v.trim() : null;
}

function AreasAdmin() {
  const qc = useQueryClient();
  const a = useDict(ADMIN);
  const t = a.areas;
  const c = useDict(COMMON);
  const { data } = useQuery({ queryKey: ['area-tree'], queryFn: api.areaTree });
  const unit = data?.areas.find((x) => x.kind === 'unit');
  const districts = data?.areas.filter((x) => x.kind === 'district') ?? [];
  const [open, setOpen] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['area-tree'] });
  const run = async (f: () => Promise<unknown>, ok: string) => {
    try {
      await f();
      toast(ok, 'success');
      refresh();
    } catch (e) {
      errToast(e);
    }
  };
  const add = async (kind: 'district' | 'ward', parentId: string) => {
    const name = await askName(kind === 'district' ? t.newDistrict : t.newWard);
    if (name) await run(() => api.createArea({ kind, name, parentId }), fill(a.added, { name }));
  };
  const rename = async (id: string, cur: string) => {
    const name = await askName(a.newName, cur);
    if (name && name !== cur) await run(() => api.renameArea(id, name), a.renamed);
  };
  const del = async (id: string, name: string) => {
    if (await confirm({ title: fill(t.deleteAsk, { name }), body: t.deleteBody, danger: true, confirmLabel: c.delete }))
      await run(() => api.deleteArea(id), fill(t.deletedName, { name }));
  };
  return (
    <>
      <PageHeader title={t.title} subtitle={t.subtitle} actions={unit && <Button onClick={() => add('district', unit.id)}><Plus className="h-4 w-4" /> {t.addDistrict}</Button>} />
      <Card>
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs text-subtle"><tr><th className="px-3 py-2">{t.colName}</th><th className="px-3 py-2">{t.colCabinets}</th><th /></tr></thead>
          <tbody>
            {districts.map((d) => {
              const wards = data!.areas.filter((x) => x.parentId === d.id);
              return (
                <Fragment key={d.id}>
                  <tr className="border-t">
                    <td className="px-3 py-2">
                      <button className="font-medium" onClick={() => setOpen(open === d.id ? null : d.id)}>{open === d.id ? '▾' : '▸'} {d.name}</button>
                      <span className="ml-2 text-xs text-subtle">{t.wards(wards.length)}</span>
                    </td>
                    <td className="px-3 py-2">{d.cabinetCount}</td>
                    <td className="space-x-1 px-3 py-2 text-right">
                      <Button size="sm" variant="ghost" onClick={() => add('ward', d.id)}>{t.addWard}</Button>
                      <Button size="sm" variant="ghost" onClick={() => rename(d.id, d.name)}>{a.rename}</Button>
                      <Button size="sm" variant="ghost" onClick={() => del(d.id, d.name)}>{c.delete}</Button>
                    </td>
                  </tr>
                  {open === d.id &&
                    wards.map((w) => (
                      <tr key={w.id} className="border-t bg-muted/20">
                        <td className="px-3 py-1.5 pl-8">{w.name}</td>
                        <td className="px-3 py-1.5">{w.cabinetCount}</td>
                        <td className="space-x-1 px-3 py-1.5 text-right">
                          <Button size="sm" variant="ghost" onClick={() => rename(w.id, w.name)}>{a.rename}</Button>
                          <Button size="sm" variant="ghost" onClick={() => del(w.id, w.name)}>{c.delete}</Button>
                        </td>
                      </tr>
                    ))}
                </Fragment>
              );
            })}
            <tr className="border-t"><td className="px-3 py-2 text-st-fault">{t.unassigned}</td><td className="px-3 py-2">{data?.unassigned}</td><td /></tr>
          </tbody>
        </table>
      </Card>
    </>
  );
}

function ZonesAdmin() {
  const qc = useQueryClient();
  const a = useDict(ADMIN);
  const t = a.zones;
  const c = useDict(COMMON);
  const zones = useQuery({ queryKey: ['zones'], queryFn: api.zones });
  const mus = useQuery({ queryKey: ['management-units'], queryFn: api.managementUnits });
  const tree = useQuery({ queryKey: ['area-tree'], queryFn: api.areaTree });
  const districts = tree.data?.areas.filter((x) => x.kind === 'district') ?? [];
  const [assignFor, setAssignFor] = useState<string | null>(null);
  const [areaIds, setAreaIds] = useState<string[]>([]);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['zones'] });
    void qc.invalidateQueries({ queryKey: ['management-units'] });
  };
  const run = async (f: () => Promise<unknown>, ok: string) => {
    try {
      await f();
      toast(ok, 'success');
      refresh();
    } catch (e) {
      errToast(e);
    }
  };
  const addZone = async () => {
    const name = await askName(t.newZone);
    if (!name) return;
    const ll = await askName(t.center, '10.7769, 106.7009');
    const [lat, lng] = (ll ?? '').split(',').map((x) => Number(x.trim()));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return toast(t.badCoords, 'error');
    await run(() => api.createZone({ name, center: { lat: lat!, lng: lng! } }), fill(t.zoneAdded, { name }));
  };
  const assign = useMutation({
    mutationFn: () => api.assignZone(assignFor!, { areaIds }),
    onSuccess: (r) => {
      toast(dictNow(ADMIN).zones.assigned(r.assigned), 'success');
      setAssignFor(null);
      setAreaIds([]);
      refresh();
    },
    onError: errToast,
  });
  return (
    <>
      <PageHeader title={t.title} />
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader title={t.zonesCard} actions={<Button size="sm" onClick={addZone}><Plus className="h-4 w-4" /> {c.add}</Button>} />
          <div className="divide-y">
            {zones.data?.map((z) => (
              <div key={z.id} className="flex items-center justify-between gap-2 px-4 py-2 text-sm">
                <div>
                  <div>{z.name}</div>
                  <div className="text-xs text-subtle">{fill(t.zoneLine, { cabinets: t.cabinets(z.cabinetCount), lat: z.center.lat.toFixed(4), lng: z.center.lng.toFixed(4) })}</div>
                </div>
                <div className="space-x-1 whitespace-nowrap">
                  <Button size="sm" variant="ghost" onClick={() => setAssignFor(z.id)}>{t.assign}</Button>
                  <Button size="sm" variant="ghost" onClick={async () => { const n = await askName(a.newName, z.name); if (n) await run(() => api.updateZone(z.id, { name: n }), a.renamed); }}>{a.rename}</Button>
                  <Button size="sm" variant="ghost" onClick={async () => { if (await confirm({ title: fill(t.deleteZoneAsk, { name: z.name }), body: t.deleteZoneBody, danger: true, confirmLabel: c.delete })) await run(() => api.deleteZone(z.id), t.zoneDeleted); }}>{c.delete}</Button>
                </div>
              </div>
            ))}
          </div>
        </Card>
        <Card>
          <CardHeader title={t.units} actions={<Button size="sm" onClick={async () => { const n = await askName(t.newUnit); if (n) await run(() => api.createUnit(n), fill(a.added, { name: n })); }}><Plus className="h-4 w-4" /> {c.add}</Button>} />
          <div className="divide-y">
            {mus.data?.map((m) => (
              <div key={m.id} className="flex items-center justify-between px-4 py-2 text-sm">
                <span>{m.name}</span>
                <span className="space-x-1">
                  <Button size="sm" variant="ghost" onClick={async () => { const n = await askName(a.newName, m.name); if (n) await run(() => api.renameUnit(m.id, n), a.renamed); }}>{a.rename}</Button>
                  <Button size="sm" variant="ghost" onClick={async () => { if (await confirm({ title: fill(t.deleteUnitAsk, { name: m.name }), body: t.deleteUnitBody, danger: true, confirmLabel: c.delete })) await run(() => api.deleteUnit(m.id), a.deleted); }}>{c.delete}</Button>
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>
      <Modal
        open={!!assignFor}
        onOpenChange={(v) => !v && setAssignFor(null)}
        title={fill(t.assignTitle, { name: zones.data?.find((z) => z.id === assignFor)?.name ?? '' })}
        footer={<><Button variant="outline" onClick={() => setAssignFor(null)}>{c.cancel}</Button><Button disabled={!areaIds.length} loading={assign.isPending} onClick={() => assign.mutate()}>{t.assignButton}</Button></>}
      >
        <p className="mb-2 text-sm text-subtle">{t.assignNote}</p>
        <div className="grid max-h-72 grid-cols-2 gap-1 overflow-auto">
          {districts.map((d) => (
            <Checkbox key={d.id} label={`${d.name} (${d.cabinetCount})`} checked={areaIds.includes(d.id)} onChange={(v) => setAreaIds((s) => (v ? [...s, d.id] : s.filter((x) => x !== d.id)))} />
          ))}
        </div>
      </Modal>
    </>
  );
}

function DevicesAdmin() {
  const qc = useQueryClient();
  const t = useDict(ADMIN).devices;
  const c = useDict(COMMON);
  const mobile = useIsMobile();
  // a board that was just powered shows up on its own
  const { data } = useQuery({ queryKey: ['unknown-devices'], queryFn: () => api.unknownDevices(), refetchInterval: 5000 });
  const history = useQuery({ queryKey: ['registration-history'], queryFn: api.registrationHistory });
  const tree = useQuery({ queryKey: ['area-tree'], queryFn: api.areaTree });
  const zones = useQuery({ queryKey: ['zones'], queryFn: api.zones });
  const districts = tree.data?.areas.filter((a) => a.kind === 'district') ?? [];
  const blank = { deviceId: '', ltid: '', code: '', name: '', lat: '', lng: '', districtId: '', wardId: '', zone1Id: '', address: '', imei: '' };
  const [form, setForm] = useState<typeof blank | null>(null);
  const [tempSensor, setTempSensor] = useState(false);
  // the device's own GPS fix pre-fills the position (wrong hand-typed coordinates are the usual E802 cause)
  const [fromGps, setFromGps] = useState(false);
  // S42: the IMEI becomes the cabinet's identity; two IMEIs under one LTID = the admin picks the real one
  const [imeiChoices, setImeiChoices] = useState<string[]>([]);
  const [pageScan, setPageScan] = useState(false);
  const [search, setSearch] = useState('');
  // the code in the form came from the QR label (typing over it clears this)
  const [scanned, setScanned] = useState(false);
  const canReplace = useSession((s) => s.can('admin.devices'));
  const canSeeLtid = useSession((s) => s.can('device.identity'));
  const [ltidOpen, setLtidOpen] = useState(false);
  const closeForm = () => {
    setForm(null);
    setScanned(false);
    setLtidOpen(false);
  };
  const replace = useMutation({
    mutationFn: (code: string) => api.replaceDevice(code),
    onSuccess: (_r, code) => {
      toast(fill(dictNow(ADMIN).devices.replaced, { code }), 'success');
      void qc.invalidateQueries({ queryKey: ['unknown-devices'] });
      void qc.invalidateQueries({ queryKey: ['registration-history'] });
      void qc.invalidateQueries({ queryKey: ['map-cabinets'] });
    },
    onError: errToast,
  });
  // a bad signature stops everyone; a board without one (older firmware) needs someone who can register by hand
  const blocked = (d: UnknownDevice) => (d.ident === 'invalid' ? t.sigBad : !d.ident && !canReplace ? t.sigNeedsManager : null);
  const askReplace = async (d: UnknownDevice) => {
    if (!d.code || !d.replaces) return;
    if (!canReplace) return toast(t.replaceDenied, 'error');
    const ok = await confirm({ title: fill(t.replaceTitle, { code: d.code }), body: fill(t.replaceBody, { name: d.replaces.name }), danger: true, confirmLabel: t.replace });
    if (ok) replace.mutate(d.code);
  };
  const review = (d: UnknownDevice) => {
    setTempSensor(false);
    setFromGps(!!d.gps);
    setImeiChoices(d.otherImei && d.imei ? [d.imei, d.otherImei] : []);
    setForm({ ...blank, deviceId: d.id, ltid: d.ltid ?? '', code: d.code ?? '', lat: d.gps ? d.gps.lat.toFixed(7) : '', lng: d.gps ? d.gps.lng.toFixed(7) : '', imei: d.otherImei ? '' : (d.imei ?? '') });
  };
  // a scanned label or a typed code: go straight to that cabinet, however long the list is
  const openByCode = async (raw: string, fromLabel: boolean) => {
    setPageScan(false);
    const code = parseCabinetCode(raw);
    if (!code) return toast(fill(t.badQr, { text: raw.trim().slice(0, 40) }), 'error');
    try {
      const rows = await api.unknownDevices(code);
      const device = rows[0];
      if (!device) return toast(fill(t.scanNotFound, { code }), 'error');
      if (rows.length > 1) return toast(fill(t.scanMany, { code, n: rows.length }), 'error');
      const stop = blocked(device);
      if (stop) return toast(stop, 'error');
      if (device.replaces) return void askReplace(device);
      review(device);
      setScanned(fromLabel);
      setSearch('');
    } catch (e) {
      errToast(e);
    }
  };
  // what this board itself reports (LCOD): a different code here means the wrong label or the wrong board
  const boardCode = data?.find((d) => d.id === form?.deviceId)?.code;
  const codeMismatch = !!boardCode && !!form?.code && form.code !== boardCode;
  const unsigned = !!data?.some((d) => d.id === form?.deviceId && !d.ident);
  const wards = tree.data?.areas.filter((a) => a.kind === 'ward' && a.parentId === form?.districtId) ?? [];
  const reg = useMutation({
    mutationFn: () =>
      api.registerCabinet({
        ...(canSeeLtid ? { ltid: form!.ltid } : { deviceId: form!.deviceId }), code: form!.code, name: form!.name.trim() || null, location: form!.lat && form!.lng ? { lat: Number(form!.lat), lng: Number(form!.lng) } : null,
        districtId: form!.districtId || null, wardId: form!.wardId || null, zone1Id: form!.zone1Id || null, address: form!.address || null,
        imei: form!.imei || null, hasTempSensor: tempSensor, scanned,
      }),
    onSuccess: () => {
      toast(fill(dictNow(ADMIN).devices.registered, { code: form!.code }), 'success');
      closeForm();
      void qc.invalidateQueries({ queryKey: ['unknown-devices'] });
      void qc.invalidateQueries({ queryKey: ['registration-history'] });
      void qc.invalidateQueries({ queryKey: ['map-cabinets'] });
    },
    onError: errToast,
  });
  const set = (k: keyof typeof blank) => (e: { target: { value: string } }) => setForm((f) => ({ ...f!, [k]: e.target.value }));
  const sigBadge = (d: UnknownDevice) => <Badge tone={d.ident === 'valid' ? 'green' : d.ident === 'invalid' ? 'red' : 'orange'}>{d.ident === 'valid' ? t.sigOk : d.ident === 'invalid' ? t.sigBadShort : t.sigNone}</Badge>;
  const deviceAction = (d: UnknownDevice) =>
    blocked(d) ? (
      <div className="max-w-[14rem] text-xs text-st-offline max-md:max-w-none">{blocked(d)}</div>
    ) : d.replaces ? (
      <>
        <div className="mb-1 text-xs text-st-fault">{fill(t.newBoardFor, { name: d.replaces.name })}</div>
        <Button size="sm" className="max-md:w-full" loading={replace.isPending} onClick={() => void askReplace(d)}>{t.replace}</Button>
      </>
    ) : (
      <Button size="sm" className="max-md:w-full" onClick={() => review(d)}>{t.review}</Button>
    );
  const viaBadge = (via: string) => <Badge tone={via === 'qr' ? 'green' : via === 'replace' ? 'orange' : 'blue'}>{via === 'qr' ? t.history.viaQr : via === 'replace' ? t.history.viaReplace : t.history.viaForm}</Badge>;
  return (
    <>
      <PageHeader title={t.title} subtitle={t.subtitle} actions={<>
        <Button className="max-md:h-12 max-md:w-full max-md:text-base" onClick={() => setPageScan(true)}><QrCode className="h-4 w-4" /> {t.scanPage}</Button>
        {canSeeLtid && <Button variant="outline" onClick={() => { setFromGps(false); setTempSensor(false); setLtidOpen(true); setForm(blank); }}><Plus className="h-4 w-4" /> {t.registerNew}</Button>}
      </>} />
      <Modal open={pageScan} onOpenChange={setPageScan} title={t.scanPage}>
        {pageScan && (
          <div className="mx-auto w-full max-w-sm">
            <QrScanner
              onRead={(raw) => void openByCode(raw, true)}
              onCameraError={(message) => {
                setPageScan(false);
                toast(message, 'error');
              }}
            />
          </div>
        )}
      </Modal>
      <Card>
        <CardHeader
          title={t.unknown}
          actionsClassName="max-md:w-full"
          actions={
            <form
              className="flex gap-2 max-md:w-full"
              onSubmit={(e) => {
                e.preventDefault();
                void openByCode(search, false);
              }}
            >
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t.searchCode} aria-label={t.searchCode} className="w-44 max-md:w-auto max-md:min-w-0 max-md:flex-1" spellCheck={false} />
              <Button type="submit" variant="outline" disabled={!search.trim()}>{t.searchButton}</Button>
            </form>
          }
        />
        {mobile ? (
          <div className="divide-y">
            {!data?.length && <div className="px-4 py-6 text-center text-subtle">{t.none}</div>}
            {data?.map((d) => (
              <div key={d.id} className="space-y-2 px-4 py-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 font-medium">
                    {canSeeLtid ? <Ltid value={d.ltid} /> : (d.code ?? '-')}
                    {canSeeLtid && d.code && <div className="text-xs font-normal text-subtle">{d.code}</div>}
                  </div>
                  {sigBadge(d)}
                </div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                  <dt className="text-subtle">IMEI</dt>
                  <dd className="min-w-0 break-all font-mono">
                    {d.imei}
                    {d.otherImei && <div className="font-sans text-st-offline">{fill(t.alsoImei, { imei: d.otherImei })}</div>}
                  </dd>
                  <dt className="text-subtle">GPS</dt>
                  <dd className="font-mono">{d.gps ? `${d.gps.lat.toFixed(5)}, ${d.gps.lng.toFixed(5)}` : <span className="font-sans text-subtle">{t.noFix}</span>}</dd>
                  <dt className="text-subtle">{t.col.lastSeen}</dt>
                  <dd>{fmtTime(d.lastSeenAt)}</dd>
                </dl>
                {deviceAction(d)}
              </div>
            ))}
          </div>
        ) : (
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs text-subtle"><tr><th className="px-3 py-2">{canSeeLtid ? 'LTID' : t.code}</th><th className="px-3 py-2">IMEI</th><th className="px-3 py-2">GPS</th><th className="px-3 py-2">{t.col.firstSeen}</th><th className="px-3 py-2">{t.col.lastSeen}</th><th className="px-3 py-2">{t.col.frames}</th><th /></tr></thead>
          <tbody>
            {!data?.length && <tr><td colSpan={7} className="px-3 py-4 text-center text-subtle">{t.none}</td></tr>}
            {data?.map((d) => (
              <tr key={d.id} className="border-t">
                <td className="px-3 py-2 font-medium">
                  {canSeeLtid ? <Ltid value={d.ltid} /> : (d.code ?? '-')}
                  {canSeeLtid && d.code && <div className="text-xs font-normal text-subtle">{d.code}</div>}
                  <div className="mt-1">{sigBadge(d)}</div>
                </td>
                <td className="px-3 py-2 font-mono text-xs">
                  {d.imei}
                  {d.otherImei && <div className="font-sans text-st-offline" title={t.twoImeiHint}>{fill(t.alsoImei, { imei: d.otherImei })}</div>}
                </td>
                <td className="px-3 py-2 font-mono text-xs">{d.gps ? `${d.gps.lat.toFixed(5)}, ${d.gps.lng.toFixed(5)}` : <span className="text-subtle">{t.noFix}</span>}</td>
                <td className="px-3 py-2 text-xs">{fmtTime(d.firstSeenAt)}</td><td className="px-3 py-2 text-xs">{fmtTime(d.lastSeenAt)}</td><td className="px-3 py-2">{d.frames}</td>
                <td className="px-3 py-2">{deviceAction(d)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        )}
      </Card>
      <p className="mt-2 text-xs text-subtle">{t.replaceHint}</p>
      <Card className="mt-4">
        <CardHeader title={t.history.title} subtitle={fill(t.history.subtitle, { n: 100 })} />
        {mobile ? (
          <div className="divide-y">
            {!history.data?.length && <div className="px-4 py-6 text-center text-subtle">{t.history.none}</div>}
            {history.data?.map((r) => (
              <div key={`${r.at}-${r.code}`} className="space-y-1 px-4 py-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 font-medium">
                    {r.code}
                    {!r.active && <Badge className="ml-2">{t.history.inactive}</Badge>}
                  </div>
                  {viaBadge(r.via)}
                </div>
                {r.name && <div className="text-sm">{r.name}</div>}
                {canSeeLtid && <div className="text-xs"><Ltid value={r.ltid} /></div>}
                <div className="text-xs text-subtle">{fmtTime(r.at)} · {r.by}</div>
              </div>
            ))}
          </div>
        ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/60 text-left text-xs text-subtle">
              <tr>
                <th className="px-3 py-2">{t.history.col.at}</th>
                <th className="px-3 py-2">{t.code}</th>
                <th className="px-3 py-2">{t.name}</th>
                {canSeeLtid && <th className="px-3 py-2">LTID</th>}
                <th className="px-3 py-2">{t.history.col.by}</th>
                <th className="px-3 py-2">{t.history.col.via}</th>
              </tr>
            </thead>
            <tbody>
              {!history.data?.length && <tr><td colSpan={canSeeLtid ? 6 : 5} className="px-3 py-4 text-center text-subtle">{t.history.none}</td></tr>}
              {history.data?.map((r) => (
                <tr key={`${r.at}-${r.code}`} className="border-t">
                  <td className="whitespace-nowrap px-3 py-2 text-xs">{fmtTime(r.at)}</td>
                  <td className="px-3 py-2 font-medium">
                    {r.code}
                    {!r.active && <Badge className="ml-2">{t.history.inactive}</Badge>}
                  </td>
                  <td className="px-3 py-2">{r.name}</td>
                  {canSeeLtid && <td className="px-3 py-2 text-xs"><Ltid value={r.ltid} /></td>}
                  <td className="px-3 py-2 text-xs">{r.by}</td>
                  <td className="px-3 py-2">{viaBadge(r.via)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        )}
      </Card>
      <Modal
        open={!!form}
        onOpenChange={(v) => !v && closeForm()}
        title={t.title}
        footer={<><Button variant="outline" onClick={closeForm}>{c.cancel}</Button><Button loading={reg.isPending} disabled={!(canSeeLtid ? form?.ltid : form?.deviceId) || !form?.code || !form.lat !== !form.lng || (imeiChoices.length > 0 && !form.imei)} onClick={() => reg.mutate()}>{t.register}</Button></>}
      >
        {form && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {canSeeLtid && (
              <Field label={t.ltid}>
                <div className="relative">
                  {/* not type=password: that would offer to save it */}
                  <Input value={form.ltid} onChange={set('ltid')} autoComplete="off" spellCheck={false} className="pr-9 font-mono" style={ltidOpen ? undefined : ({ WebkitTextSecurity: 'disc' } as React.CSSProperties)} />
                  <button type="button" className="absolute right-2 top-2.5 text-subtle hover:text-foreground" title={ltidOpen ? t.hideLtid : t.showLtid} aria-label={ltidOpen ? t.hideLtid : t.showLtid} onClick={() => setLtidOpen(!ltidOpen)}>
                    {ltidOpen ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </Field>
            )}
            <Field label={t.code}><Input value={form.code} onChange={(e) => { setScanned(false); set('code')(e); }} placeholder="TL01.0123" /></Field>
            {codeMismatch && <div className="text-sm text-st-offline sm:col-span-2">{fill(t.codeMismatch, { code: boardCode })}</div>}
            {unsigned && <div className="text-sm text-st-fault sm:col-span-2">{t.sigNoneHint}</div>}
            <Field label={t.name}><Input value={form.name} onChange={set('name')} /></Field>
            <Field label={t.address}><Input value={form.address} onChange={set('address')} /></Field>
            <Field label={t.lat}><Input value={form.lat} onChange={set('lat')} placeholder={t.optional} /></Field>
            <Field label={t.lng}><Input value={form.lng} onChange={set('lng')} placeholder={t.optional} /></Field>
            {!fromGps && <p className="text-xs text-subtle sm:col-span-2">{t.optionalHint}</p>}
            {fromGps && (
              <div className="-mt-1 text-xs text-subtle sm:col-span-2">
                {t.fromGps}
              </div>
            )}
            {imeiChoices.length > 0 ? (
              <div className="space-y-1 rounded-md border border-st-offline/40 bg-st-offline/10 p-3 text-sm sm:col-span-2">
                <div><b>{t.twoImeiTitle}</b>{t.twoImeiBody}</div>
                <Select value={form.imei} onChange={set('imei')} aria-label={t.realImei} className="w-full">
                  <option value="">{t.pickImei}</option>
                  {imeiChoices.map((i) => <option key={i} value={i}>{i}</option>)}
                </Select>
              </div>
            ) : (
              <Field label={t.imeiField} className="sm:col-span-2">
                <Input value={form.imei} onChange={set('imei')} placeholder={t.imeiPlaceholder} className="font-mono" />
              </Field>
            )}
            <Field label={t.district}>
              <Select value={form.districtId} onChange={(e) => setForm({ ...form, districtId: e.target.value, wardId: '' })} className="w-full">
                <option value="">{t.notAssigned}</option>
                {districts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </Select>
            </Field>
            <Field label={t.ward}>
              <Select value={form.wardId} onChange={set('wardId')} disabled={!form.districtId} className="w-full">
                <option value="">—</option>
                {wards.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </Select>
            </Field>
            <Field label={t.zone}>
              <Select value={form.zone1Id} onChange={set('zone1Id')} className="w-full">
                <option value="">—</option>
                {zones.data?.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
              </Select>
            </Field>
            <div className="sm:col-span-2">
              <Checkbox label={t.tempSensor} checked={tempSensor} onChange={setTempSensor} />
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}

function FieldMapAdmin() {
  const t = useDict(ADMIN).fieldMap;
  const { data } = useQuery({ queryKey: ['field-map'], queryFn: api.fieldMap });
  return (
    <>
      <PageHeader title={t.title} subtitle={t.subtitle} />
      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs text-subtle"><tr><th className="px-3 py-2">Key</th><th className="px-3 py-2">{t.col.field}</th><th className="px-3 py-2">{t.col.type}</th><th className="px-3 py-2">{t.col.scale}</th><th className="px-3 py-2">{t.col.unit}</th><th className="px-3 py-2">{t.col.note}</th><th className="px-3 py-2">Firmware</th></tr></thead>
          <tbody>
            {data?.entries.map((f) => (
              <tr key={f.key} className="border-t">
                <td className="px-3 py-1.5 font-mono font-medium">{f.key}</td><td className="px-3 py-1.5 font-mono text-xs">{f.field}</td><td className="px-3 py-1.5">{f.type}</td><td className="px-3 py-1.5">{f.scale ?? '—'}</td><td className="px-3 py-1.5">{f.unit ?? '—'}</td><td className="px-3 py-1.5 text-xs text-subtle">{f.note}</td>
                <td className="px-3 py-1.5">{f.supported ? <Badge tone="green">{t.sending}</Badge> : <Badge>{t.waiting}</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <h2 className="mb-2 mt-6 text-base font-semibold">{t.unknownKeys}</h2>
      <Card>
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs text-subtle"><tr><th className="px-3 py-2">Key</th><th className="px-3 py-2">{t.col.cabinets}</th><th className="px-3 py-2">{t.col.sample}</th></tr></thead>
          <tbody>
            {!data?.unknownKeys.length && <tr><td colSpan={3} className="px-3 py-4 text-center text-subtle">{t.noUnknown}</td></tr>}
            {data?.unknownKeys.map((k) => (
              <tr key={k.key} className="border-t"><td className="px-3 py-1.5 font-mono">{k.key}</td><td className="px-3 py-1.5">{k.cabinets}</td><td className="px-3 py-1.5 font-mono text-xs">{k.sample}</td></tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

function AlarmRulesAdmin() {
  const t = useDict(ADMIN).alarmRules;
  const L = useLabels();
  const lang = useLang((s) => s.lang);
  const typeLabels = alarmTypeLabels(lang);
  const { data } = useQuery({ queryKey: ['alarm-rules'], queryFn: api.alarmRules });
  return (
    <>
      <PageHeader title={t.title} subtitle={t.subtitle} />
      <h2 className="mb-2 mt-2 text-base font-semibold">{t.catalog}</h2>
      <ErrorCatalogTable />
      <h2 className="mb-2 mt-6 text-base font-semibold">{t.running}</h2>
      <Card>
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs text-subtle"><tr><th className="px-3 py-2">{t.col.type}</th><th className="px-3 py-2">{t.col.severity}</th><th className="px-3 py-2">{t.col.condition}</th><th className="px-3 py-2">{t.col.status}</th></tr></thead>
          <tbody>
            {data?.map((r) => (
              <tr key={r.type} className="border-t">
                <td className="px-3 py-2">{typeLabels[r.type as AlarmType] ?? r.type}</td>
                <td className="px-3 py-2"><Badge tone={r.severity === 'critical' ? 'red' : r.severity === 'major' ? 'orange' : 'amber'}>{L.severity[r.severity as keyof typeof L.severity]}</Badge></td>
                <td className="px-3 py-2 text-xs">{r.condition}</td>
                <td className="px-3 py-2">{r.enabled ? <Badge tone="green">{t.enabled}</Badge> : <Badge>{t.waiting}</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

function SettingsAdmin() {
  const qc = useQueryClient();
  const t = useDict(ADMIN).settings;
  const c = useDict(COMMON);
  const { data, isLoading } = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const [offline, setOffline] = useState<number | null>(null);
  const [labels, setLabels] = useState<Record<string, string> | null>(null);
  const [price, setPrice] = useState<number | null>(null);
  const save = useMutation({
    mutationFn: () => api.saveSettings({ offlineAfterS: offline ?? data!.offlineAfterS, lampGroupLabels: labels ?? data!.lampGroupLabels, pricePerKwh: price ?? data!.pricePerKwh }),
    onSuccess: (d) => {
      qc.setQueryData(['settings'], d);
      setOffline(null);
      setLabels(null);
      setPrice(null);
      toast(dictNow(ADMIN).settings.saved, 'success');
    },
    onError: errToast,
  });
  if (isLoading || !data) return <Spinner />;
  const l = labels ?? data.lampGroupLabels;
  return (
    <>
      <PageHeader title={t.title} subtitle={data.updatedAt ? fill(t.updated, { time: fmtTime(data.updatedAt), user: data.updatedBy ?? '—' }) : undefined} />
      <Card className="max-w-xl">
        <div className="space-y-3 p-4">
          <Field label={t.offlineAfter}>
            <Input type="number" min={30} max={900} value={offline ?? data.offlineAfterS} onChange={(e) => setOffline(Number(e.target.value))} />
          </Field>
          <Field label={t.price}>
            <Input type="number" min={0} max={100000} step={50} value={price ?? data.pricePerKwh ?? 2000} onChange={(e) => setPrice(Number(e.target.value))} />
          </Field>
          <div className="text-sm font-medium">{t.lampGroups}</div>
          {['0', '1', '2', '3'].map((k) => (
            <Field key={k} label={fill(t.group, { k })}>
              <Input value={l[k] ?? ''} onChange={(e) => setLabels({ ...l, [k]: e.target.value })} />
            </Field>
          ))}
          <p className="text-xs text-subtle">{t.envNote}</p>
          <Button loading={save.isPending} disabled={offline === null && labels === null && price === null} onClick={() => save.mutate()}>{c.save}</Button>
        </div>
      </Card>
    </>
  );
}
