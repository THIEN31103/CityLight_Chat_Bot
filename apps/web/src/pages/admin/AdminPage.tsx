import { Fragment, useState } from 'react';
import { NavLink, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import type { RoleKey } from '@citylight/shared';
import { ALARM_TYPE_LABELS, LAMP_GROUP_LABELS, ROLE_LABELS, ROLE_PERMISSIONS, SEVERITY_LABELS, roleRequires2fa } from '@citylight/shared';
import { api, ApiError, type AdminUser, type UnknownDevice } from '@/lib/api';
import { useSession } from '@/stores/session';
import { ScopePicker, scopeLabel, useAreaNames, type ScopeValue } from '@/components/security';
import { cn, fmtTime } from '@/lib/utils';
import { Badge, Button, Card, CardHeader, Checkbox, Field, Input, Modal, PageHeader, Select, Spinner, Toggle, confirm, toast } from '@/components/ui';
import { ErrorCatalogTable } from '@/components/ErrorHelp';

const TABS = [
  { id: 'users', label: 'Người dùng' },
  { id: 'roles', label: 'Vai trò & quyền' },
  { id: 'areas', label: 'Khu vực' },
  { id: 'zones', label: 'Vùng & khu quản lý' },
  { id: 'devices', label: 'Đăng ký tủ' },
  { id: 'field-map', label: 'Ánh xạ telemetry' },
  { id: 'alarm-rules', label: 'Quy tắc cảnh báo' },
  { id: 'settings', label: 'Cấu hình hệ thống' },
];

export function AdminPage() {
  const { tab = 'users' } = useParams();
  return (
    <div className="flex h-full">
      <aside className="w-56 shrink-0 border-r bg-panel p-2">
        <div className="mb-1 px-2 text-xs font-semibold uppercase text-subtle">Quản trị</div>
        {TABS.map((t) => (
          <NavLink key={t.id} to={`/admin/${t.id}`} className={({ isActive }) => cn('block rounded px-2 py-1.5 text-sm hover:bg-muted', isActive && 'bg-primary/10 font-medium')}>
            {t.label}
          </NavLink>
        ))}
      </aside>
      <div className="min-w-0 flex-1 overflow-auto p-4">
        {tab === 'users' && <UsersAdmin />}
        {tab === 'roles' && <RolesAdmin />}
        {tab === 'areas' && <AreasAdmin />}
        {tab === 'zones' && <ZonesAdmin />}
        {tab === 'devices' && <DevicesAdmin />}
        {tab === 'field-map' && <FieldMapAdmin />}
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
  const { data, isLoading } = useQuery({ queryKey: ['users'], queryFn: api.users });
  const [open, setOpen] = useState(false);
  const blank = { email: '', fullName: '', role: 'viewer' as RoleKey, scopeAll: false, scopeAreaIds: [] as string[] };
  const [form, setForm] = useState(blank);
  const [scopeEdit, setScopeEdit] = useState<{ user: AdminUser; value: ScopeValue } | null>(null);
  const [secret, setSecret] = useState<{ email: string; tempPassword: string; created: boolean } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['users'] });
  const fail = (e: unknown) => toast(e instanceof ApiError ? e.message : 'Lỗi', 'error');

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
  const unlock = useMutation({ mutationFn: (u: AdminUser) => api.unlockUser(u.id), onSuccess: () => { toast('Đã mở khóa đăng nhập', 'success'); refresh(); }, onError: fail });
  const reset2fa = useMutation({ mutationFn: (u: AdminUser) => api.resetUser2fa(u.id), onSuccess: () => { toast('Đã đặt lại 2FA', 'success'); refresh(); }, onError: fail });

  const ask = async (title: string, body: string, run: () => void) => {
    if (await confirm({ title, body, danger: true })) run();
  };

  return (
    <>
      <PageHeader
        title="Người dùng"
        subtitle="Đổi vai trò, phạm vi hoặc khóa tài khoản sẽ đăng xuất người đó ngay"
        actions={<Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Thêm người dùng</Button>}
      />
      <Card className="overflow-x-auto">
        {isLoading ? (
          <div className="p-6"><Spinner /></div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/60 text-left text-xs text-subtle">
              <tr><th className="px-3 py-2">Họ tên</th><th className="px-3 py-2">Email</th><th className="px-3 py-2">Vai trò</th><th className="px-3 py-2">Phạm vi</th><th className="px-3 py-2">2FA</th><th className="px-3 py-2">Đăng nhập gần nhất</th><th className="px-3 py-2">Hoạt động</th><th className="px-3 py-2" /></tr>
            </thead>
            <tbody>
              {data?.map((u) => {
                const self = u.id === me?.id;
                return (
                  <tr key={u.id} className="border-t align-top">
                    <td className="px-3 py-2 font-medium">
                      {u.fullName} {self && <Badge tone="blue">Bạn</Badge>}
                      {u.passwordChangeRequired && <div className="text-xs font-normal text-st-fault">Chưa đổi mật khẩu tạm</div>}
                      {u.lockedUntil && <div className="text-xs font-normal text-st-offline">Tạm khóa tới {fmtTime(u.lockedUntil)}</div>}
                    </td>
                    <td className="px-3 py-2">{u.email}</td>
                    <td className="px-3 py-2">
                      <Select value={u.role} disabled={self} onChange={(e) => update.mutate({ id: u.id, patch: { role: e.target.value as RoleKey } })} className="h-8">
                        {Object.entries(ROLE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </Select>
                    </td>
                    <td className="max-w-[16rem] px-3 py-2 text-xs">
                      <span className={cn(!u.scopeAll && !u.scopeAreaIds.length && 'text-st-fault')}>{u.role === 'admin' ? 'Toàn hệ thống (quản trị)' : scopeLabel(u, names)}</span>
                      {!self && u.role !== 'admin' && (
                        <button className="ml-1 text-primary hover:underline" onClick={() => setScopeEdit({ user: u, value: { scopeAll: u.scopeAll, scopeAreaIds: u.scopeAreaIds } })}>Sửa</button>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {u.totpEnabled ? <Badge tone="green">Bật</Badge> : u.totpRequired ? <Badge tone="orange">Bắt buộc, chưa bật</Badge> : <Badge>Tắt</Badge>}
                    </td>
                    <td className="px-3 py-2 text-xs">{fmtTime(u.lastLoginAt)}</td>
                    <td className="px-3 py-2"><Toggle checked={u.active} disabled={self} onChange={(v) => update.mutate({ id: u.id, patch: { active: v } })} label="Kích hoạt" /></td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs">
                      {!self && (
                        <div className="flex flex-col items-start gap-1">
                          <button className="text-primary hover:underline" onClick={() => ask('Đặt lại mật khẩu?', `${u.email} sẽ bị đăng xuất và nhận mật khẩu tạm mới.`, () => resetPw.mutate(u))}>Đặt lại mật khẩu</button>
                          {u.totpEnabled && <button className="text-primary hover:underline" onClick={() => ask('Đặt lại 2FA?', `Xóa 2FA của ${u.email} (ví dụ khi mất điện thoại). Người đó sẽ bị đăng xuất và phải thiết lập lại.`, () => reset2fa.mutate(u))}>Đặt lại 2FA</button>}
                          {u.lockedUntil && <button className="text-primary hover:underline" onClick={() => unlock.mutate(u)}>Mở khóa đăng nhập</button>}
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

      <Modal open={open} onOpenChange={setOpen} title="Thêm người dùng" footer={<><Button variant="outline" onClick={() => setOpen(false)}>Hủy</Button><Button disabled={!form.email || !form.fullName} loading={create.isPending} onClick={() => create.mutate()}>Tạo</Button></>}>
        <div className="space-y-3">
          <Field label="Họ tên"><Input value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} /></Field>
          <Field label="Email"><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Vai trò" hint={roleRequires2fa(form.role) ? 'Vai trò này bắt buộc 2FA ở lần đăng nhập đầu' : undefined}>
            <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as RoleKey })} className="w-full">
              {Object.entries(ROLE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
          {form.role === 'admin' ? (
            <p className="text-xs text-subtle">Quản trị viên luôn thấy toàn hệ thống.</p>
          ) : (
            <Field label="Phạm vi khu vực"><ScopePicker value={form} onChange={(v) => setForm({ ...form, ...v })} /></Field>
          )}
          <p className="text-xs text-subtle">Hệ thống tạo mật khẩu tạm; người dùng phải đổi ở lần đăng nhập đầu.</p>
        </div>
      </Modal>

      <Modal
        open={!!scopeEdit}
        onOpenChange={(v) => !v && setScopeEdit(null)}
        title={`Phạm vi: ${scopeEdit?.user.fullName ?? ''}`}
        footer={<><Button variant="outline" onClick={() => setScopeEdit(null)}>Hủy</Button><Button loading={update.isPending} onClick={() => scopeEdit && update.mutate({ id: scopeEdit.user.id, patch: scopeEdit.value })}>Lưu</Button></>}
      >
        {scopeEdit && <ScopePicker value={scopeEdit.value} onChange={(v) => setScopeEdit({ ...scopeEdit, value: v })} />}
        <p className="mt-2 text-xs text-subtle">Lưu sẽ đăng xuất người dùng này để áp phạm vi mới.</p>
      </Modal>

      <Modal open={!!secret} onOpenChange={(v) => !v && setSecret(null)} title={secret?.created ? 'Đã tạo người dùng' : 'Đã đặt lại mật khẩu'} footer={<Button onClick={() => setSecret(null)}>Đã gửi cho người dùng</Button>}>
        {secret && (
          <div className="space-y-2">
            <p>Mật khẩu tạm cho <b>{secret.email}</b> (chỉ hiện lần này, gửi qua kênh riêng):</p>
            <div className="flex items-center gap-2">
              <code className="rounded bg-muted px-2 py-1 font-mono text-base">{secret.tempPassword}</code>
              <Button size="sm" variant="outline" onClick={() => navigator.clipboard?.writeText(secret.tempPassword).then(() => toast('Đã chép', 'success'))}>Chép</Button>
            </div>
            <p className="text-xs text-subtle">Người dùng phải đổi mật khẩu này ở lần đăng nhập đầu.</p>
          </div>
        )}
      </Modal>
    </>
  );
}

function RolesAdmin() {
  const perms = [...new Set(Object.values(ROLE_PERMISSIONS).flat())];
  const roles = Object.keys(ROLE_LABELS) as RoleKey[];
  return (
    <>
      <PageHeader title="Vai trò & quyền" subtitle="Quyền luôn được kiểm ở backend; giao diện chỉ ẩn/hiện" />
      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs text-subtle">
            <tr><th className="px-3 py-2">Quyền</th>{roles.map((r) => <th key={r} className="px-3 py-2 text-center">{ROLE_LABELS[r]}</th>)}</tr>
          </thead>
          <tbody>
            {perms.map((p) => (
              <tr key={p} className="border-t">
                <td className="px-3 py-1.5 font-mono text-xs">{p}</td>
                {roles.map((r) => <td key={r} className="px-3 py-1.5 text-center">{ROLE_PERMISSIONS[r].includes(p) ? '✔' : ''}</td>)}
              </tr>
            ))}
            <tr className="border-t bg-muted/30">
              <td className="px-3 py-1.5 text-xs">Bắt buộc 2FA (vai trò có quyền điều khiển tủ)</td>
              {roles.map((r) => <td key={r} className="px-3 py-1.5 text-center">{roleRequires2fa(r) ? '✔' : ''}</td>)}
            </tr>
          </tbody>
        </table>
      </Card>
    </>
  );
}

const errToast = (e: unknown) => toast(e instanceof ApiError ? e.message : 'Lỗi', 'error');

/** Small inline "name" editor used by the catalog tables. */
async function askName(title: string, current = ''): Promise<string | null> {
  const v = window.prompt(title, current);
  return v && v.trim() ? v.trim() : null;
}

function AreasAdmin() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['area-tree'], queryFn: api.areaTree });
  const unit = data?.areas.find((a) => a.kind === 'unit');
  const districts = data?.areas.filter((a) => a.kind === 'district') ?? [];
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
    const name = await askName(kind === 'district' ? 'Tên quận / huyện mới' : 'Tên phường / xã mới');
    if (name) await run(() => api.createArea({ kind, name, parentId }), `Đã thêm ${name}`);
  };
  const rename = async (id: string, cur: string) => {
    const name = await askName('Tên mới', cur);
    if (name && name !== cur) await run(() => api.renameArea(id, name), 'Đã đổi tên');
  };
  const del = async (id: string, name: string) => {
    if (await confirm({ title: `Xóa "${name}"?`, body: 'Chỉ xóa được khu vực không còn tủ, khu vực con hay người dùng được phân quyền.', danger: true, confirmLabel: 'Xóa' }))
      await run(() => api.deleteArea(id), `Đã xóa ${name}`);
  };
  return (
    <>
      <PageHeader title="Khu vực" subtitle="Cây đơn vị → quận / huyện → phường / xã; dùng cho phân quyền và lọc" actions={unit && <Button onClick={() => add('district', unit.id)}><Plus className="h-4 w-4" /> Thêm quận</Button>} />
      <Card>
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs text-subtle"><tr><th className="px-3 py-2">Quận / huyện · phường / xã</th><th className="px-3 py-2">Số tủ</th><th /></tr></thead>
          <tbody>
            {districts.map((d) => {
              const wards = data!.areas.filter((a) => a.parentId === d.id);
              return (
                <Fragment key={d.id}>
                  <tr className="border-t">
                    <td className="px-3 py-2">
                      <button className="font-medium" onClick={() => setOpen(open === d.id ? null : d.id)}>{open === d.id ? '▾' : '▸'} {d.name}</button>
                      <span className="ml-2 text-xs text-subtle">{wards.length} phường</span>
                    </td>
                    <td className="px-3 py-2">{d.cabinetCount}</td>
                    <td className="space-x-1 px-3 py-2 text-right">
                      <Button size="sm" variant="ghost" onClick={() => add('ward', d.id)}>+ Phường</Button>
                      <Button size="sm" variant="ghost" onClick={() => rename(d.id, d.name)}>Đổi tên</Button>
                      <Button size="sm" variant="ghost" onClick={() => del(d.id, d.name)}>Xóa</Button>
                    </td>
                  </tr>
                  {open === d.id &&
                    wards.map((w) => (
                      <tr key={w.id} className="border-t bg-muted/20">
                        <td className="px-3 py-1.5 pl-8">{w.name}</td>
                        <td className="px-3 py-1.5">{w.cabinetCount}</td>
                        <td className="space-x-1 px-3 py-1.5 text-right">
                          <Button size="sm" variant="ghost" onClick={() => rename(w.id, w.name)}>Đổi tên</Button>
                          <Button size="sm" variant="ghost" onClick={() => del(w.id, w.name)}>Xóa</Button>
                        </td>
                      </tr>
                    ))}
                </Fragment>
              );
            })}
            <tr className="border-t"><td className="px-3 py-2 text-st-fault">Chưa phân khu vực</td><td className="px-3 py-2">{data?.unassigned}</td><td /></tr>
          </tbody>
        </table>
      </Card>
    </>
  );
}

function ZonesAdmin() {
  const qc = useQueryClient();
  const zones = useQuery({ queryKey: ['zones'], queryFn: api.zones });
  const mus = useQuery({ queryKey: ['management-units'], queryFn: api.managementUnits });
  const tree = useQuery({ queryKey: ['area-tree'], queryFn: api.areaTree });
  const districts = tree.data?.areas.filter((a) => a.kind === 'district') ?? [];
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
    const name = await askName('Tên vùng mới');
    if (!name) return;
    const ll = await askName('Tâm vùng (vĩ độ, kinh độ), dùng cho lịch thiên văn', '10.7769, 106.7009');
    const [lat, lng] = (ll ?? '').split(',').map((x) => Number(x.trim()));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return toast('Tọa độ không hợp lệ', 'error');
    await run(() => api.createZone({ name, center: { lat: lat!, lng: lng! } }), `Đã thêm vùng ${name}`);
  };
  const assign = useMutation({
    mutationFn: () => api.assignZone(assignFor!, { areaIds }),
    onSuccess: (r) => {
      toast(`Đã chuyển ${r.assigned} tủ vào vùng`, 'success');
      setAssignFor(null);
      setAreaIds([]);
      refresh();
    },
    onError: errToast,
  });
  return (
    <>
      <PageHeader title="Vùng & khu quản lý" />
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader title="Vùng (lịch / tiết giảm)" actions={<Button size="sm" onClick={addZone}><Plus className="h-4 w-4" /> Thêm</Button>} />
          <div className="divide-y">
            {zones.data?.map((z) => (
              <div key={z.id} className="flex items-center justify-between gap-2 px-4 py-2 text-sm">
                <div>
                  <div>{z.name}</div>
                  <div className="text-xs text-subtle">{z.cabinetCount} tủ · tâm {z.center.lat.toFixed(4)}, {z.center.lng.toFixed(4)}</div>
                </div>
                <div className="space-x-1 whitespace-nowrap">
                  <Button size="sm" variant="ghost" onClick={() => setAssignFor(z.id)}>Gán tủ</Button>
                  <Button size="sm" variant="ghost" onClick={async () => { const n = await askName('Tên mới', z.name); if (n) await run(() => api.updateZone(z.id, { name: n }), 'Đã đổi tên'); }}>Đổi tên</Button>
                  <Button size="sm" variant="ghost" onClick={async () => { if (await confirm({ title: `Xóa vùng ${z.name}?`, body: 'Chỉ xóa được vùng không còn tủ. Lịch / ngưỡng của vùng bị xóa theo.', danger: true, confirmLabel: 'Xóa' })) await run(() => api.deleteZone(z.id), 'Đã xóa vùng'); }}>Xóa</Button>
                </div>
              </div>
            ))}
          </div>
        </Card>
        <Card>
          <CardHeader title="Khu quản lý" actions={<Button size="sm" onClick={async () => { const n = await askName('Tên khu quản lý mới'); if (n) await run(() => api.createUnit(n), `Đã thêm ${n}`); }}><Plus className="h-4 w-4" /> Thêm</Button>} />
          <div className="divide-y">
            {mus.data?.map((m) => (
              <div key={m.id} className="flex items-center justify-between px-4 py-2 text-sm">
                <span>{m.name}</span>
                <span className="space-x-1">
                  <Button size="sm" variant="ghost" onClick={async () => { const n = await askName('Tên mới', m.name); if (n) await run(() => api.renameUnit(m.id, n), 'Đã đổi tên'); }}>Đổi tên</Button>
                  <Button size="sm" variant="ghost" onClick={async () => { if (await confirm({ title: `Xóa ${m.name}?`, body: 'Chỉ xóa được khu quản lý không còn tủ.', danger: true, confirmLabel: 'Xóa' })) await run(() => api.deleteUnit(m.id), 'Đã xóa'); }}>Xóa</Button>
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>
      <Modal
        open={!!assignFor}
        onOpenChange={(v) => !v && setAssignFor(null)}
        title={`Gán tủ vào vùng ${zones.data?.find((z) => z.id === assignFor)?.name ?? ''}`}
        footer={<><Button variant="outline" onClick={() => setAssignFor(null)}>Hủy</Button><Button disabled={!areaIds.length} loading={assign.isPending} onClick={() => assign.mutate()}>Gán</Button></>}
      >
        <p className="mb-2 text-sm text-subtle">Mọi tủ thuộc các quận đã chọn sẽ chuyển sang vùng này (lịch vùng áp lại tự động).</p>
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
  const { data } = useQuery({ queryKey: ['unknown-devices'], queryFn: api.unknownDevices });
  const tree = useQuery({ queryKey: ['area-tree'], queryFn: api.areaTree });
  const zones = useQuery({ queryKey: ['zones'], queryFn: api.zones });
  const districts = tree.data?.areas.filter((a) => a.kind === 'district') ?? [];
  const blank = { ltid: '', code: '', name: '', lat: '', lng: '', districtId: '', wardId: '', zone1Id: '', address: '' };
  const [form, setForm] = useState<typeof blank | null>(null);
  // the device's own GPS fix pre-fills the position (wrong hand-typed coordinates are the usual E802 cause)
  const [fromGps, setFromGps] = useState(false);
  const review = (d: UnknownDevice) => {
    setFromGps(!!d.gps);
    setForm({ ...blank, ltid: d.ltid, lat: d.gps ? d.gps.lat.toFixed(7) : '', lng: d.gps ? d.gps.lng.toFixed(7) : '' });
  };
  const wards = tree.data?.areas.filter((a) => a.kind === 'ward' && a.parentId === form?.districtId) ?? [];
  const reg = useMutation({
    mutationFn: () =>
      api.registerCabinet({
        ltid: form!.ltid, code: form!.code, name: form!.name, location: { lat: Number(form!.lat), lng: Number(form!.lng) },
        districtId: form!.districtId || null, wardId: form!.wardId || null, zone1Id: form!.zone1Id || null, address: form!.address || null,
      }),
    onSuccess: () => {
      toast(`Đã đăng ký tủ ${form!.code}`, 'success');
      setForm(null);
      void qc.invalidateQueries({ queryKey: ['unknown-devices'] });
      void qc.invalidateQueries({ queryKey: ['map-cabinets'] });
    },
    onError: errToast,
  });
  const set = (k: keyof typeof blank) => (e: { target: { value: string } }) => setForm((f) => ({ ...f!, [k]: e.target.value }));
  return (
    <>
      <PageHeader title="Đăng ký tủ" subtitle="Thiết bị gửi frame có LTID chưa đăng ký nằm ở đây chờ duyệt; tủ mới được nhận dữ liệu ngay" actions={<Button onClick={() => { setFromGps(false); setForm(blank); }}><Plus className="h-4 w-4" /> Đăng ký tủ mới</Button>} />
      <Card>
        <CardHeader title="Thiết bị chưa đăng ký" />
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs text-subtle"><tr><th className="px-3 py-2">LTID</th><th className="px-3 py-2">IMEI</th><th className="px-3 py-2">GPS</th><th className="px-3 py-2">Thấy lần đầu</th><th className="px-3 py-2">Thấy gần nhất</th><th className="px-3 py-2">Số frame</th><th /></tr></thead>
          <tbody>
            {!data?.length && <tr><td colSpan={7} className="px-3 py-4 text-center text-subtle">Không có thiết bị lạ</td></tr>}
            {data?.map((d) => (
              <tr key={d.ltid} className="border-t">
                <td className="px-3 py-2 font-medium">{d.ltid}</td><td className="px-3 py-2 font-mono text-xs">{d.imei}</td>
                <td className="px-3 py-2 font-mono text-xs">{d.gps ? `${d.gps.lat.toFixed(5)}, ${d.gps.lng.toFixed(5)}` : <span className="text-subtle">chưa có fix</span>}</td>
                <td className="px-3 py-2 text-xs">{fmtTime(d.firstSeenAt)}</td><td className="px-3 py-2 text-xs">{fmtTime(d.lastSeenAt)}</td><td className="px-3 py-2">{d.frames}</td>
                <td className="px-3 py-2"><Button size="sm" onClick={() => review(d)}>Duyệt & đăng ký</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Modal
        open={!!form}
        onOpenChange={(v) => !v && setForm(null)}
        title="Đăng ký tủ"
        footer={<><Button variant="outline" onClick={() => setForm(null)}>Hủy</Button><Button loading={reg.isPending} disabled={!form?.ltid || !form.code || !form.name || !form.lat || !form.lng} onClick={() => reg.mutate()}>Đăng ký</Button></>}
      >
        {form && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="LTID (trong firmware)"><Input value={form.ltid} onChange={set('ltid')} /></Field>
            <Field label="Mã tủ"><Input value={form.code} onChange={set('code')} placeholder="TL01.0123" /></Field>
            <Field label="Tên tủ"><Input value={form.name} onChange={set('name')} /></Field>
            <Field label="Địa chỉ"><Input value={form.address} onChange={set('address')} /></Field>
            <Field label="Vĩ độ"><Input value={form.lat} onChange={set('lat')} placeholder="10.7769" /></Field>
            <Field label="Kinh độ"><Input value={form.lng} onChange={set('lng')} placeholder="106.7009" /></Field>
            {fromGps && (
              <div className="col-span-2 -mt-1 text-xs text-subtle">
                Tọa độ điền sẵn từ GPS thiết bị gửi lên (điểm gần nhất). Sửa lại nếu thiết bị đang ở chỗ khác chỗ lắp tủ.
              </div>
            )}
            <Field label="Quận / huyện">
              <Select value={form.districtId} onChange={(e) => setForm({ ...form, districtId: e.target.value, wardId: '' })}>
                <option value="">— chưa phân —</option>
                {districts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </Select>
            </Field>
            <Field label="Phường / xã">
              <Select value={form.wardId} onChange={set('wardId')} disabled={!form.districtId}>
                <option value="">—</option>
                {wards.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </Select>
            </Field>
            <Field label="Vùng lịch">
              <Select value={form.zone1Id} onChange={set('zone1Id')}>
                <option value="">—</option>
                {zones.data?.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
              </Select>
            </Field>
          </div>
        )}
      </Modal>
    </>
  );
}

function FieldMapAdmin() {
  const { data } = useQuery({ queryKey: ['field-map'], queryFn: api.fieldMap });
  return (
    <>
      <PageHeader title="Ánh xạ telemetry CoreIF" subtitle="Ánh xạ đang dùng (trong code ingest). Chỉnh trên web sẽ làm ở mốc sau; key lạ tủ đang gửi liệt kê bên dưới." />
      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs text-subtle"><tr><th className="px-3 py-2">Key</th><th className="px-3 py-2">Trường</th><th className="px-3 py-2">Kiểu</th><th className="px-3 py-2">Hệ số</th><th className="px-3 py-2">Đơn vị</th><th className="px-3 py-2">Ghi chú</th><th className="px-3 py-2">Firmware</th></tr></thead>
          <tbody>
            {data?.entries.map((f) => (
              <tr key={f.key} className="border-t">
                <td className="px-3 py-1.5 font-mono font-medium">{f.key}</td><td className="px-3 py-1.5 font-mono text-xs">{f.field}</td><td className="px-3 py-1.5">{f.type}</td><td className="px-3 py-1.5">{f.scale ?? '—'}</td><td className="px-3 py-1.5">{f.unit ?? '—'}</td><td className="px-3 py-1.5 text-xs text-subtle">{f.note}</td>
                <td className="px-3 py-1.5">{f.supported ? <Badge tone="green">Đang gửi</Badge> : <Badge>Chờ</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <h2 className="mb-2 mt-6 text-base font-semibold">Key lạ tủ đang gửi</h2>
      <Card>
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs text-subtle"><tr><th className="px-3 py-2">Key</th><th className="px-3 py-2">Số tủ</th><th className="px-3 py-2">Giá trị mẫu</th></tr></thead>
          <tbody>
            {!data?.unknownKeys.length && <tr><td colSpan={3} className="px-3 py-4 text-center text-subtle">Không có key lạ</td></tr>}
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
  const { data } = useQuery({ queryKey: ['alarm-rules'], queryFn: api.alarmRules });
  return (
    <>
      <PageHeader title="Quy tắc cảnh báo" subtitle="Rule engine phía máy chủ; ngưỡng chi tiết đặt theo vùng hoặc từng tủ" />
      <h2 className="mb-2 mt-2 text-base font-semibold">Bảng mã lỗi thiết bị</h2>
      <ErrorCatalogTable />
      <h2 className="mb-2 mt-6 text-base font-semibold">Quy tắc đang chạy</h2>
      <Card>
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs text-subtle"><tr><th className="px-3 py-2">Loại</th><th className="px-3 py-2">Mức</th><th className="px-3 py-2">Điều kiện</th><th className="px-3 py-2">Trạng thái</th></tr></thead>
          <tbody>
            {data?.map((r) => (
              <tr key={r.type} className="border-t">
                <td className="px-3 py-2">{ALARM_TYPE_LABELS[r.type as keyof typeof ALARM_TYPE_LABELS] ?? r.type}</td>
                <td className="px-3 py-2"><Badge tone={r.severity === 'critical' ? 'red' : r.severity === 'major' ? 'orange' : 'amber'}>{SEVERITY_LABELS[r.severity as keyof typeof SEVERITY_LABELS]}</Badge></td>
                <td className="px-3 py-2 text-xs">{r.condition}</td>
                <td className="px-3 py-2">{r.enabled ? <Badge tone="green">Đang chạy</Badge> : <Badge>Chờ firmware / cấu hình</Badge>}</td>
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
      toast('Đã lưu cấu hình, áp dụng ngay', 'success');
    },
    onError: errToast,
  });
  if (isLoading || !data) return <Spinner />;
  const l = labels ?? data.lampGroupLabels;
  return (
    <>
      <PageHeader title="Cấu hình hệ thống" subtitle={data.updatedAt ? `Sửa lần cuối ${fmtTime(data.updatedAt)} bởi ${data.updatedBy}` : undefined} />
      <Card className="max-w-xl">
        <div className="space-y-3 p-4">
          <Field label="Coi tủ mất kết nối sau (giây, 30–900)">
            <Input type="number" min={30} max={900} value={offline ?? data.offlineAfterS} onChange={(e) => setOffline(Number(e.target.value))} />
          </Field>
          <Field label="Giá điện để ước tính tiết giảm (đ/kWh, 0 = chỉ hiện kWh)">
            <Input type="number" min={0} max={100000} step={50} value={price ?? data.pricePerKwh ?? 2000} onChange={(e) => setPrice(Number(e.target.value))} />
          </Field>
          <div className="text-sm font-medium">Tên nhóm đèn</div>
          {['0', '1', '2', '3'].map((k) => (
            <Field key={k} label={`Nhóm ${k}`}>
              <Input value={l[k] ?? ''} onChange={(e) => setLabels({ ...l, [k]: e.target.value })} />
            </Field>
          ))}
          <p className="text-xs text-subtle">Tốc độ gửi lệnh, thời gian chờ ack / xác nhận, thời gian lưu dữ liệu đặt bằng biến môi trường của worker (xem README).</p>
          <Button loading={save.isPending} disabled={offline === null && labels === null && price === null} onClick={() => save.mutate()}>Lưu</Button>
        </div>
      </Card>
    </>
  );
}
