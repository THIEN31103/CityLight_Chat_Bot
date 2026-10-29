// "Sửa thông tin tủ" (owner request 2026-10-29): name, address, street, district and ward after registration,
// e.g. a cabinet registered without an area (an area-scoped account does not see it). Uses PATCH /cabinets/:id
// (admin.devices); code, LTID, position (RelocateGps / map) and zones (admin Zones tab) stay where they are.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/stores/session';
import { Button, Field, Input, Modal, Select, toast } from '@/components/ui';
import { dictNow, fill, useDict } from '@/i18n';
import { CABINET } from '@/i18n/dict/cabinet';
import { COMMON } from '@/i18n/dict/common';

export interface EditableCabinet {
  id: string;
  code: string;
  name: string;
  address: string | null;
  street: string | null;
  districtId: string | null;
  wardId: string | null;
}

type Form = { name: string; address: string; street: string; districtId: string; wardId: string };

const toForm = (c: EditableCabinet): Form => ({
  name: c.name, address: c.address ?? '', street: c.street ?? '', districtId: c.districtId ?? '', wardId: c.wardId ?? '',
});

export function EditCabinetButton({ cabinet }: { cabinet: EditableCabinet }) {
  const qc = useQueryClient();
  const can = useSession((x) => x.can('admin.devices'));
  const t = useDict(CABINET).edit;
  const c = useDict(COMMON);
  const [form, setForm] = useState<Form | null>(null);
  const tree = useQuery({ queryKey: ['area-tree'], queryFn: api.areaTree, enabled: !!form });
  const districts = tree.data?.areas.filter((a) => a.kind === 'district') ?? [];
  const wards = tree.data?.areas.filter((a) => a.kind === 'ward' && a.parentId === form?.districtId) ?? [];

  const save = useMutation({
    mutationFn: () => {
      // only what changed; district and ward travel together so the server checks the pair
      const f = form!;
      const was = toForm(cabinet);
      const patch: Record<string, unknown> = {};
      if (f.name.trim() !== was.name) patch.name = f.name.trim();
      if (f.address.trim() !== was.address) patch.address = f.address.trim() || null;
      if (f.street.trim() !== was.street) patch.street = f.street.trim() || null;
      if (f.districtId !== was.districtId || f.wardId !== was.wardId) {
        patch.districtId = f.districtId || null;
        patch.wardId = f.wardId || null;
      }
      return api.updateCabinet(cabinet.id, patch);
    },
    onSuccess: () => {
      toast(fill(dictNow(CABINET).edit.saved, { code: cabinet.code }), 'success');
      setForm(null);
      for (const key of [['cabinet', cabinet.id], ['map-cabinets'], ['area-tree']]) void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : dictNow(CABINET).edit.failed, 'error'),
  });

  if (!can) return null;
  const set = (k: keyof Form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f!, [k]: e.target.value }));
  const unchanged = !!form && JSON.stringify({ ...form, name: form.name.trim(), address: form.address.trim(), street: form.street.trim() }) === JSON.stringify(toForm(cabinet));
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setForm(toForm(cabinet))}><Pencil className="h-4 w-4" /> {t.button}</Button>
      <Modal
        open={!!form}
        onOpenChange={(v) => !v && setForm(null)}
        title={fill(t.title, { code: cabinet.code })}
        footer={<><Button variant="outline" onClick={() => setForm(null)}>{c.cancel}</Button><Button loading={save.isPending} disabled={!form?.name.trim() || unchanged} onClick={() => save.mutate()}>{c.save}</Button></>}
      >
        {form && (
          <div className="grid grid-cols-2 gap-3">
            <Field label={t.name} className="col-span-2"><Input value={form.name} onChange={set('name')} maxLength={120} /></Field>
            <Field label={t.address} className="col-span-2"><Input value={form.address} onChange={set('address')} maxLength={300} /></Field>
            <Field label={t.street} className="col-span-2"><Input value={form.street} onChange={set('street')} maxLength={120} /></Field>
            <Field label={t.district}>
              <Select value={form.districtId} onChange={(e) => setForm({ ...form, districtId: e.target.value, wardId: '' })}>
                <option value="">{t.notAssigned}</option>
                {districts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </Select>
            </Field>
            <Field label={t.ward}>
              <Select value={form.wardId} onChange={set('wardId')} disabled={!form.districtId}>
                <option value="">—</option>
                {wards.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </Select>
            </Field>
            <div className="col-span-2 text-xs text-subtle">{t.scopeNote}</div>
          </div>
        )}
      </Modal>
    </>
  );
}
