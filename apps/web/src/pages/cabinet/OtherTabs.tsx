import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, MapPin, Upload } from 'lucide-react';
import type { CabinetDetail, Command, DimmingProfile, GeoPoint, LampGroup, Thresholds } from '@citylight/shared';
import { alarmTypeLabels, describeCommand } from '@citylight/shared';
import { api, ApiError } from '@/lib/api';
import { subscribe } from '@/lib/realtime';
import { useSession } from '@/stores/session';
import { fmtDuration, fmtNum, fmtTime } from '@/lib/utils';
import { Badge, Button, Card, CardHeader, Checkbox, Empty, Input, KV, Select, Spinner, Unsupported, toast } from '@/components/ui';
import { DimmingEditor } from '@/components/DimmingEditor';
import { Ltid } from '@/components/Ltid';
import { ErrorCodeBadge } from '@/components/ErrorHelp';
import { RelocateGpsButton } from './RelocateGps';
import { ImeiButton } from './ImeiDecision';
import { SigningCard } from './Signing';
import { EditCabinetButton } from './EditCabinet';
import { DirectionsLink } from '@/components/Directions';
import { dictNow, fill, useDict, useLabels, useLang } from '@/i18n';
import { CABINET } from '@/i18n/dict/cabinet';
import { COMMON } from '@/i18n/dict/common';

type Detail = CabinetDetail & { cabinet: { districtName: string; wardName: string } };

// ---------- Cài đặt ngưỡng ----------

// label: CABINET.thresholds.rows[key]
const THRESHOLD_ROWS: { key: keyof Thresholds; unit: string; current?: (d: Detail) => string }[] = [
  { key: 'voltageHigh', unit: 'V', current: (d) => `L1 ${fmtNum(d.state.vL1)} · L2 ${fmtNum(d.state.vL2)} · L3 ${fmtNum(d.state.vL3)}` },
  { key: 'voltageLow', unit: 'V' },
  { key: 'voltageSwing', unit: 'V' },
  { key: 'currentHigh', unit: 'A', current: (d) => `I1 ${fmtNum(d.state.iL1)} · I2 ${fmtNum(d.state.iL2)} · I3 ${fmtNum(d.state.iL3)}` },
  { key: 'currentLow', unit: 'A' },
  { key: 'currentSwing', unit: 'A' },
  { key: 'currentNoLoad', unit: 'A' },
  { key: 'leakMa', unit: 'mA', current: (d) => fmtNum(d.state.leakMa, 0, 'mA') },
  { key: 'tempC', unit: '°C', current: (d) => fmtNum(d.state.tempC, 0, '°C') },
  { key: 'batteryLowMv', unit: 'mV', current: (d) => fmtNum(d.state.batteryMv, 0, 'mV') },
];

export function ThresholdsTab({ detail }: { detail: Detail }) {
  const qc = useQueryClient();
  const can = useSession((s) => s.can('cabinet.configure'));
  const d = useDict(CABINET).thresholds;
  const c = useDict(COMMON);
  const [t, setT] = useState<Thresholds>(detail.thresholds);
  useEffect(() => setT(detail.thresholds), [detail.thresholds]);
  const save = useMutation({
    mutationFn: () => api.setThresholds(detail.cabinet.id, t),
    onSuccess: () => {
      toast(dictNow(CABINET).thresholds.saved, 'success');
      qc.invalidateQueries({ queryKey: ['cabinet', detail.cabinet.id] });
    },
  });
  return (
    <Card>
      <CardHeader
        title={d.title}
        subtitle={d.subtitle}
        actions={can && <Button size="sm" onClick={() => save.mutate()} loading={save.isPending}>{c.save}</Button>}
      />
      <div className="divide-y">
        {THRESHOLD_ROWS.map((r) => (
          <div key={r.key} className="grid items-center gap-2 px-4 py-2 sm:grid-cols-[1fr_140px_1fr]">
            <Checkbox label={d.rows[r.key]} checked={t[r.key].enabled} onChange={(v) => setT({ ...t, [r.key]: { ...t[r.key], enabled: v } })} disabled={!can} />
            <div className="flex items-center gap-1">
              <Input type="number" value={t[r.key].value} onChange={(e) => setT({ ...t, [r.key]: { ...t[r.key], value: Number(e.target.value) } })} disabled={!can || !t[r.key].enabled} className="h-8" />
              <span className="w-8 text-xs text-subtle">{r.unit}</span>
            </div>
            <div className="text-xs text-subtle">{r.current ? fill(d.current, { value: r.current(detail) }) : ''}</div>
          </div>
        ))}
      </div>
      <div className="p-4 pt-2">
        <Unsupported>{d.perBranch}</Unsupported>
      </div>
    </Card>
  );
}

// ---------- Tiết giảm ----------

export function DimmingTab({ detail }: { detail: Detail }) {
  const qc = useQueryClient();
  const can = useSession((s) => s.can('dimming.manage'));
  const dict = useDict(CABINET);
  const t = dict.dimming;
  const c = useDict(COMMON);
  const [group, setGroup] = useState<LampGroup>(0);
  const { data } = useQuery({ queryKey: ['cabinet-dimming', detail.cabinet.id, group], queryFn: () => api.cabinetDimming(detail.cabinet.id, group) });
  const [profile, setProfile] = useState<DimmingProfile | null>(null);
  useEffect(() => setProfile(data ?? null), [data]);
  const fail = (e: unknown) => toast(e instanceof ApiError ? e.message : dictNow(COMMON).error, 'error');
  const save = useMutation({
    mutationFn: () => api.setCabinetDimming(detail.cabinet.id, profile!),
    onSuccess: () => {
      toast(dictNow(CABINET).dimming.saved, 'success');
      qc.invalidateQueries({ queryKey: ['cabinet-dimming', detail.cabinet.id] });
    },
    onError: fail,
  });
  const drop = useMutation({
    mutationFn: () => api.dropCabinetDimming(detail.cabinet.id, group),
    onSuccess: () => {
      toast(dictNow(CABINET).dimming.dropped, 'success');
      qc.invalidateQueries({ queryKey: ['cabinet-dimming', detail.cabinet.id] });
    },
    onError: fail,
  });
  const supported = detail.capabilities.includes('dimming');
  return (
    <div className="space-y-3">
      {!supported && <Unsupported>{t.unsupported}</Unsupported>}
      <Card>
        <CardHeader
          title={t.title}
          subtitle={
            profile?.source
              ? profile.source === 'cabinet' ? t.usingOwn : fill(t.inheriting, { source: t.source[profile.source] })
              : profile?.inheritedFromZone ? t.inheritingZone : t.overriding
          }
          actions={
            <>
              <Select value={group} onChange={(e) => setGroup(Number(e.target.value) as LampGroup)}>
                {([0, 1, 2, 3] as LampGroup[]).map((g) => (
                  <option key={g} value={g}>
                    {dict.lampGroups[g]}
                  </option>
                ))}
              </Select>
              {can && profile?.source === 'cabinet' && (
                <Button size="sm" variant="outline" onClick={() => drop.mutate()} loading={drop.isPending}>
                  {t.dropOwn}
                </Button>
              )}
              {can && <Button size="sm" onClick={() => save.mutate()} loading={save.isPending} disabled={!profile}>{c.save}</Button>}
            </>
          }
        />
        <div className="p-4">{profile ? <DimmingEditor segments={profile.segments} onChange={(segments) => setProfile({ ...profile, segments })} disabled={!can} estimate={profile.estimate} /> : <Spinner />}</div>
      </Card>
    </div>
  );
}

// ---------- Đèn ----------

export function LampsTab({ detail, onLocate }: { detail: Detail; onLocate: (p: GeoPoint) => void }) {
  const { data, isLoading } = useQuery({ queryKey: ['cabinet-lamps', detail.cabinet.id], queryFn: () => api.cabinetLamps(detail.cabinet.id) });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const smart = detail.capabilities.includes('smart_lamps');
  const dict = useDict(CABINET);
  const t = dict.lamps;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Card className="p-3">
          <div className="text-xs text-subtle">{t.total}</div>
          <div className="text-lg font-semibold">{data?.length ?? '…'}</div>
        </Card>
        <Card className="p-3">
          <div className="text-xs text-subtle">{t.connected}</div>
          <div className="text-lg font-semibold">—</div>
        </Card>
        <Card className="p-3">
          <div className="text-xs text-subtle">{t.powerLevel}</div>
          <div className="text-lg font-semibold">—</div>
        </Card>
        <Card className="p-3">
          <div className="text-xs text-subtle">PAN ID</div>
          <div className="text-lg font-semibold">—</div>
        </Card>
      </div>
      {!smart && <Unsupported>{t.noSmart}</Unsupported>}
      <Card>
        <CardHeader
          title={t.list}
          actions={
            <>
              <Button size="sm" variant="outline" disabled={!smart || !selected.size}>{t.on}</Button>
              <Button size="sm" variant="outline" disabled={!smart || !selected.size}>{t.off}</Button>
              <Button size="sm" variant="outline" disabled={!smart || !selected.size}>Dim %</Button>
            </>
          }
        />
        {isLoading ? (
          <div className="p-6"><Spinner /></div>
        ) : (
          <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3 md:grid-cols-4">
            {data?.map((l) => (
              <div key={l.id} className="rounded-md border p-2 text-xs">
                <div className="flex items-center justify-between">
                  <Checkbox
                    label={<b>{l.poleCode.split('_').slice(-2).join('_')}·{l.code}</b>}
                    checked={selected.has(l.id)}
                    onChange={(v) =>
                      setSelected((s) => {
                        const n = new Set(s);
                        if (v) n.add(l.id);
                        else n.delete(l.id);
                        return n;
                      })
                    }
                  />
                  <button onClick={() => onLocate(l.location)} className="text-subtle hover:text-primary" aria-label={t.locate}>
                    <MapPin className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="mt-1 text-subtle">{l.ratedPowerW} W · {t.branch} {l.branch}</div>
                <Select className="mt-1 h-7 w-full text-xs" defaultValue={l.lampGroup} aria-label={t.group}>
                  {([0, 1, 2, 3] as LampGroup[]).map((g) => (
                    <option key={g} value={g}>
                      {dict.lampGroups[g]}
                    </option>
                  ))}
                </Select>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------- Thông tin ----------

/** S54: DS18B20 fitted or not; device admins switch it here, everyone else reads it. */
function TempSensorToggle({ cabinetId, fitted }: { cabinetId: string; fitted: boolean }) {
  const qc = useQueryClient();
  const canEdit = useSession((x) => x.can('admin.devices'));
  const t = useDict(CABINET).info;
  const save = useMutation({
    mutationFn: (v: boolean) => api.updateCabinet(cabinetId, { hasTempSensor: v }),
    onSuccess: (_r, v) => {
      const tt = dictNow(CABINET).info;
      toast(fill(tt.tempSensorSaved, { state: (v ? tt.tempSensorFitted : tt.tempSensorNone).toLowerCase() }), 'success');
      qc.invalidateQueries({ queryKey: ['cabinet', cabinetId] });
      qc.invalidateQueries({ queryKey: ['diagnostics', cabinetId] });
    },
  });
  if (!canEdit) return <span>{fitted ? t.tempSensorFitted : t.tempSensorNone}</span>;
  return <Checkbox label={fitted ? t.tempSensorFitted : t.tempSensorNone} checked={fitted} disabled={save.isPending} onChange={(v) => save.mutate(v)} />;
}

export function InfoTab({ detail, onLocate }: { detail: Detail; onLocate: (p: GeoPoint) => void }) {
  const { cabinet: c, state: s } = detail;
  const can = useSession((x) => x.can('cabinet.configure'));
  const dict = useDict(CABINET);
  const t = dict.info;
  const gpsDiff =
    s.gpsDevice &&
    Math.round(
      6371000 *
        2 *
        Math.asin(
          Math.sqrt(
            Math.sin(((s.gpsDevice.lat - c.location.lat) * Math.PI) / 360) ** 2 +
              Math.cos((c.location.lat * Math.PI) / 180) * Math.cos((s.gpsDevice.lat * Math.PI) / 180) * Math.sin(((s.gpsDevice.lng - c.location.lng) * Math.PI) / 360) ** 2,
          ),
        ),
    );
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader title={t.device} />
        <div className="px-4 py-2">
          {c.ltid && <KV label={t.ltid} value={<Ltid value={c.ltid} />} />}
          <KV label="IMEI" value={<span className="inline-flex items-center gap-2"><span className="font-mono">{c.imei || t.noImei}</span><ImeiButton cabinetId={c.id} label={`${c.code} - ${c.name}`} text="IMEI…" /></span>} />
          <KV label="Firmware" value={<Badge tone={c.fwProfile === 'v2-1307ebc' ? 'orange' : 'blue'}>{c.fwProfile}</Badge>} />
          <KV label={t.battery} value={fmtNum(s.batteryMv, 0, 'mV')} />
          <KV label={t.sim} value={<span className="text-subtle">{dict.monitor.waitFw}</span>} />
          <KV label={t.installed} value={fmtTime(c.installedAt, 'DD/MM/YYYY')} />
          <KV label={t.tempSensor} value={<TempSensorToggle cabinetId={c.id} fitted={c.hasTempSensor} />} />
        </div>
      </Card>
      <Card>
        <CardHeader title={t.location} actions={<div className="flex gap-2"><DirectionsLink point={c.location} /><Button size="sm" variant="outline" onClick={() => onLocate(s.gpsDevice ?? c.location)}><MapPin className="h-4 w-4" /> {t.locateGps}</Button></div>} />
        <div className="px-4 py-2">
          <KV label={t.declared} value={`${c.location.lat.toFixed(6)}, ${c.location.lng.toFixed(6)}`} />
          <KV label={t.gpsDevice} value={s.gpsDevice ? `${s.gpsDevice.lat.toFixed(6)}, ${s.gpsDevice.lng.toFixed(6)}` : t.noFix} />
          <KV label={t.offset} value={gpsDiff !== null && gpsDiff !== undefined ? <span className={gpsDiff > 200 ? 'text-st-offline' : ''}>{gpsDiff} m</span> : '—'} />
          <KV label="Zone 1 / Zone 2" value={`${c.zone1Id ?? '—'} / ${c.zone2Id ?? '—'}`} />
        </div>
        <div className="flex items-center justify-between gap-2 border-t px-4 py-2">
          <span className="text-xs text-subtle">{t.mapNote}</span>
          <RelocateGpsButton cabinetId={c.id} label={`${c.code} - ${c.name}`} onLocate={onLocate} />
        </div>
      </Card>
      <SigningCard cabinetId={c.id} label={`${c.code} - ${c.name}`} />
      <Card>
        <CardHeader title={t.admin} actions={<EditCabinetButton cabinet={c} />} />
        <div className="px-4 py-2">
          <KV label={t.address} value={c.address} />
          <KV label={t.street} value={c.street} />
          <KV label={t.ward} value={detail.cabinet.wardName} />
          <KV label={t.district} value={detail.cabinet.districtName} />
          <KV label={t.unit} value={c.managementUnitId ?? '—'} />
        </div>
      </Card>
      <Card>
        <CardHeader title={t.photos} actions={can && <Button size="sm" variant="outline" onClick={() => toast(t.uploadMock)}><Upload className="h-4 w-4" /> {t.upload}</Button>} />
        <div className="flex h-40 items-center justify-center text-subtle">
          <div className="flex flex-col items-center gap-1 text-sm">
            <Camera className="h-8 w-8" />
            {t.noPhoto}
          </div>
        </div>
      </Card>
    </div>
  );
}

// ---------- Cảnh báo của tủ ----------

export function CabinetAlarmsTab({ cabinetId }: { cabinetId: string }) {
  const { data, isLoading } = useQuery({ queryKey: ['cabinet-alarms', cabinetId], queryFn: () => api.cabinetAlarms(cabinetId, 20) });
  const t = useDict(CABINET).alarms;
  const L = useLabels();
  const lang = useLang((s) => s.lang);
  if (isLoading) return <Spinner />;
  if (!data?.length) return <Empty>{t.empty}</Empty>;
  const typeLabels = alarmTypeLabels(lang);
  return (
    <Card>
      <CardHeader title={t.title} />
      <table className="w-full text-sm">
        <thead className="bg-muted/60 text-left text-xs text-subtle">
          <tr>
            <th className="px-3 py-2">{t.colCode}</th>
            <th className="px-3 py-2">{t.colContent}</th>
            <th className="px-3 py-2">{t.colSeverity}</th>
            <th className="px-3 py-2">{t.colTime}</th>
            <th className="px-3 py-2">{t.colDuration}</th>
          </tr>
        </thead>
        <tbody>
          {data.map((a) => (
            <tr key={a.id} className="border-t">
              <td className="px-3 py-2">
                <ErrorCodeBadge type={a.type} code={a.code} />
              </td>
              <td className="px-3 py-2">
                <div className="font-medium">{typeLabels[a.type]}</div>
                <div className="text-xs text-subtle">{a.message}</div>
              </td>
              <td className="px-3 py-2">
                <Badge tone={a.severity === 'critical' ? 'red' : a.severity === 'major' ? 'orange' : 'amber'}>{L.severity[a.severity]}</Badge>
                {a.active && <Badge tone="red" className="ml-1">{t.ongoing}</Badge>}
              </td>
              <td className="px-3 py-2 text-xs">{fmtTime(a.startedAt)}</td>
              <td className="px-3 py-2 text-xs">{fmtDuration(a.startedAt, a.endedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

// ---------- Lịch sử lệnh ----------

export function CommandsTab({ cabinetId }: { cabinetId: string }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['cabinet-commands', cabinetId], queryFn: () => api.cabinetCommands(cabinetId) });
  useEffect(
    () =>
      subscribe<Command>('command.updated', (c) => {
        if (c.cabinetId !== cabinetId) return;
        qc.setQueryData<Command[]>(['cabinet-commands', cabinetId], (list = []) =>
          list.some((x) => x.id === c.id) ? list.map((x) => (x.id === c.id ? c : x)) : [c, ...list],
        );
      }),
    [cabinetId, qc],
  );
  const t = useDict(CABINET).commands;
  const L = useLabels();
  const lang = useLang((s) => s.lang);
  const tone = (s: string) => (s === 'confirmed' ? 'green' : s === 'failed' || s === 'timeout' ? 'red' : s === 'acked_unconfirmed' ? 'amber' : 'blue');
  if (isLoading) return <Spinner />;
  if (!data?.length) return <Empty>{t.empty}</Empty>;
  return (
    <Card>
      <CardHeader title={t.title} />
      <div className="divide-y">
        {data.map((c) => (
          <div key={c.id} className="px-4 py-2 text-sm">
            <div className="flex items-center justify-between gap-2">
              <b>{describeCommand(c.type, c.params, lang)}</b>
              <Badge tone={tone(c.status) as 'green'}>{L.commandStatus[c.status]}</Badge>
            </div>
            <div className="text-xs text-subtle">
              {c.requestedBy} · {t.sent} {fmtTime(c.queuedAt)}
              {c.confirmedAt && ` · ${t.confirmed} ${fmtTime(c.confirmedAt)}`}
              {c.error && <span className="text-st-offline"> · {c.error}</span>}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

export { ApiError };
