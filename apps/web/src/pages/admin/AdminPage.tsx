import { useState } from 'react';
import { NavLink, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import type { RoleKey } from '@citylight/shared';
import { ALARM_TYPE_LABELS, LAMP_GROUP_LABELS, ROLE_LABELS, ROLE_PERMISSIONS, SEVERITY_LABELS, roleRequires2fa } from '@citylight/shared';
import { api, ApiError, type AdminUser } from '@/lib/api';
import { useSession } from '@/stores/session';
import { ScopePicker, scopeLabel, useAreaNames, type ScopeValue } from '@/components/security';
import { cn, fmtTime } from '@/lib/utils';
import { Badge, Button, Card, CardHeader, Field, Input, Modal, PageHeader, Select, Spinner, Toggle, confirm, toast } from '@/components/ui';
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

function AreasAdmin() {
  const { data } = useQuery({ queryKey: ['area-tree'], queryFn: api.areaTree });
  const districts = data?.areas.filter((a) => a.kind === 'district') ?? [];
  return (
    <>
      <PageHeader title="Khu vực" actions={<Button onClick={() => toast('Thêm khu vực (mock)')}><Plus className="h-4 w-4" /> Thêm</Button>} />
      <Card>
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs text-subtle"><tr><th className="px-3 py-2">Quận / huyện</th><th className="px-3 py-2">Số phường</th><th className="px-3 py-2">Số tủ</th></tr></thead>
          <tbody>
            {districts.map((d) => (
              <tr key={d.id} className="border-t"><td className="px-3 py-2">{d.name}</td><td className="px-3 py-2">{data!.areas.filter((a) => a.parentId === d.id).length}</td><td className="px-3 py-2">{d.cabinetCount}</td></tr>
            ))}
            <tr className="border-t"><td className="px-3 py-2 text-st-fault">Chưa phân khu vực</td><td /><td className="px-3 py-2">{data?.unassigned}</td></tr>
          </tbody>
        </table>
      </Card>
    </>
  );
}

function ZonesAdmin() {
  const zones = useQuery({ queryKey: ['zones'], queryFn: api.zones });
  const mus = useQuery({ queryKey: ['management-units'], queryFn: api.managementUnits });
  return (
    <>
      <PageHeader title="Vùng & khu quản lý" />
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader title="Vùng (lịch / tiết giảm)" />
          <div className="divide-y">{zones.data?.map((z) => <div key={z.id} className="flex justify-between px-4 py-2 text-sm"><span>{z.name} <span className="text-xs text-subtle">#{z.id}</span></span><span className="text-subtle">{z.cabinetCount} tủ</span></div>)}</div>
        </Card>
        <Card>
          <CardHeader title="Khu quản lý" />
          <div className="divide-y">{mus.data?.map((m) => <div key={m.id} className="px-4 py-2 text-sm">{m.name}</div>)}</div>
        </Card>
        <Card>
          <CardHeader title="Nhóm đèn" />
          <div className="divide-y">{Object.entries(LAMP_GROUP_LABELS).map(([k, v]) => <div key={k} className="px-4 py-2 text-sm">{k} – {v}</div>)}</div>
        </Card>
      </div>
    </>
  );
}

function DevicesAdmin() {
  const { data } = useQuery({ queryKey: ['unknown-devices'], queryFn: api.unknownDevices });
  return (
    <>
      <PageHeader title="Đăng ký tủ" subtitle="Thiết bị gửi frame có LTID chưa đăng ký sẽ nằm ở đây chờ duyệt" actions={<Button onClick={() => toast('Form đăng ký tủ (mock)')}><Plus className="h-4 w-4" /> Đăng ký tủ mới</Button>} />
      <Card>
        <CardHeader title="Thiết bị chưa đăng ký" />
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs text-subtle"><tr><th className="px-3 py-2">LTID</th><th className="px-3 py-2">IMEI</th><th className="px-3 py-2">Thấy lần đầu</th><th className="px-3 py-2">Thấy gần nhất</th><th className="px-3 py-2">Số frame</th><th /></tr></thead>
          <tbody>
            {data?.map((d) => (
              <tr key={d.ltid} className="border-t">
                <td className="px-3 py-2 font-medium">{d.ltid}</td><td className="px-3 py-2 font-mono text-xs">{d.imei}</td><td className="px-3 py-2 text-xs">{fmtTime(d.firstSeenAt)}</td><td className="px-3 py-2 text-xs">{fmtTime(d.lastSeenAt)}</td><td className="px-3 py-2">{d.frames}</td>
                <td className="px-3 py-2"><Button size="sm" onClick={() => toast(`Duyệt ${d.ltid} (mock)`, 'success')}>Duyệt & đăng ký</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

function FieldMapAdmin() {
  const { data } = useQuery({ queryKey: ['field-map'], queryFn: api.fieldMap });
  return (
    <>
      <PageHeader title="Ánh xạ telemetry CoreIF" subtitle="Firmware thêm key mới → thêm dòng ở đây, không cần sửa code" actions={<Button onClick={() => toast('Thêm ánh xạ (mock)')}><Plus className="h-4 w-4" /> Thêm key</Button>} />
      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs text-subtle"><tr><th className="px-3 py-2">Key</th><th className="px-3 py-2">Trường</th><th className="px-3 py-2">Kiểu</th><th className="px-3 py-2">Hệ số</th><th className="px-3 py-2">Đơn vị</th><th className="px-3 py-2">Ghi chú</th><th className="px-3 py-2">Firmware</th></tr></thead>
          <tbody>
            {data?.map((f) => (
              <tr key={f.key} className="border-t">
                <td className="px-3 py-1.5 font-mono font-medium">{f.key}</td><td className="px-3 py-1.5 font-mono text-xs">{f.field}</td><td className="px-3 py-1.5">{f.type}</td><td className="px-3 py-1.5">{f.scale ?? '—'}</td><td className="px-3 py-1.5">{f.unit ?? '—'}</td><td className="px-3 py-1.5 text-xs text-subtle">{f.note}</td>
                <td className="px-3 py-1.5">{f.supported ? <Badge tone="green">Đang gửi</Badge> : <Badge>Chờ</Badge>}</td>
              </tr>
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
      <h2 className="mb-2 mt-6 text-base font-semibold">Bật / tắt quy tắc</h2>
      <Card>
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs text-subtle"><tr><th className="px-3 py-2">Loại</th><th className="px-3 py-2">Mức</th><th className="px-3 py-2">Điều kiện</th><th className="px-3 py-2">Bật</th></tr></thead>
          <tbody>
            {data?.map((r) => (
              <tr key={r.type} className="border-t">
                <td className="px-3 py-2">{ALARM_TYPE_LABELS[r.type as keyof typeof ALARM_TYPE_LABELS] ?? r.type}</td>
                <td className="px-3 py-2"><Badge tone={r.severity === 'critical' ? 'red' : r.severity === 'major' ? 'orange' : 'amber'}>{SEVERITY_LABELS[r.severity as keyof typeof SEVERITY_LABELS]}</Badge></td>
                <td className="px-3 py-2 text-xs">{r.condition}</td>
                <td className="px-3 py-2"><Toggle checked={r.enabled} onChange={() => toast('Lưu quy tắc (mock)')} label={r.type} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

function SettingsAdmin() {
  return (
    <>
      <PageHeader title="Cấu hình hệ thống" />
      <Card className="max-w-xl">
        <div className="space-y-3 p-4">
          <Field label="Coi tủ mất kết nối sau (giây)"><Input type="number" defaultValue={60} /></Field>
          <Field label="Giới hạn tốc độ lệnh hàng loạt (lệnh/giây)"><Input type="number" defaultValue={20} /></Field>
          <Field label="Chờ ack tối đa (giây)"><Input type="number" defaultValue={30} /></Field>
          <Field label="Chờ xác nhận bằng telemetry (giây)"><Input type="number" defaultValue={60} /></Field>
          <Field label="Giữ telemetry thô (ngày)"><Input type="number" defaultValue={90} /></Field>
          <Field label="Tên hệ thống hiển thị"><Input defaultValue="CityLight" /></Field>
          <Button onClick={() => toast('Đã lưu cấu hình (mock)', 'success')}>Lưu</Button>
        </div>
      </Card>
    </>
  );
}
