import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Camera, MapPin } from 'lucide-react';
import type { IncidentPhoto, IncidentTransition } from '@citylight/shared';
import { INCIDENT_TRANSITIONS, INCIDENT_TRANSITION_LABELS } from '@citylight/shared';
import { dictNow, fill, useDict, useLabels, useLang } from '@/i18n';
import { COMMON } from '@/i18n/dict/common';
import { INCIDENTS } from '@/i18n/dict/incidents';
import { LOG_ACTIONS } from '@/i18n/dict/logs';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/stores/session';
import { fmtTime } from '@/lib/utils';
import { Badge, Button, Card, CardHeader, Field, Input, KV, Modal, Select, Spinner, Textarea, toast } from '@/components/ui';
import { INCIDENT_TONE, useIncidentText } from './IncidentsPage';
import { DirectionsLink } from '@/components/Directions';

const err = (e: unknown) => toast(e instanceof ApiError ? e.message : dictNow(COMMON).error, 'error');

export function IncidentDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const can = useSession((s) => s.can);
  const me = useSession((s) => s.user);
  const t = useDict(INCIDENTS).detail;
  const c = useDict(COMMON);
  const L = useLabels();
  const tx = useIncidentText();
  const actions = useDict(LOG_ACTIONS);
  const lang = useLang((s) => s.lang);
  const { data: inc, isLoading } = useQuery({ queryKey: ['incident', id], queryFn: () => api.incident(id!) });
  const [action, setAction] = useState<IncidentTransition | null>(null);
  const [note, setNote] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [deadline, setDeadline] = useState('');
  const assignees = useQuery({
    queryKey: ['incident-assignees', inc?.cabinetId],
    queryFn: () => api.incidentAssignees(inc!.cabinetId),
    enabled: !!inc && action?.needs === 'assign',
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['incident', id] });
    void qc.invalidateQueries({ queryKey: ['incidents'] });
  };
  const run = useMutation({
    mutationFn: () =>
      api.transitionIncident(id!, {
        to: action!.to,
        note: note || undefined,
        assigneeId: action?.needs === 'assign' ? assigneeId : undefined,
        deadline: action?.needs === 'assign' && deadline ? new Date(deadline).toISOString() : undefined,
        resolution: action?.needs === 'resolve' ? note : undefined,
      }),
    onSuccess: () => {
      toast(t.updated, 'success');
      setAction(null);
      setNote('');
      refresh();
    },
    onError: err,
  });

  if (isLoading || !inc) return <div className="p-6"><Spinner /></div>;

  // field staff report only the incidents assigned to them; managers may act for them
  const allowed = INCIDENT_TRANSITIONS[inc.status].filter(
    (t) => can(t.perm) && (t.needs !== 'resolve' || can('incident.manage') || inc.assigneeId === me?.id),
  );
  const trLabel = (tr: IncidentTransition) => INCIDENT_TRANSITION_LABELS[lang][`${inc.status}>${tr.to}`] ?? tr.label;

  return (
    <div className="mx-auto max-w-5xl p-4">
      <Link to="/incidents" className="mb-3 inline-flex items-center gap-1 text-sm text-subtle hover:text-fg">
        <ArrowLeft className="h-4 w-4" /> {t.backToList}
      </Link>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold">{fill(t.heading, { code: inc.code })}</h1>
          <Badge tone={INCIDENT_TONE[inc.status]}>{L.incidentStatus[inc.status]}</Badge>
          {inc.overdue && <Badge tone="red">{t.overdue}</Badge>}
        </div>
        <div className="flex gap-2">
          {allowed.map((tr) => (
            <Button key={tr.label} variant={tr.to === 'closed' || tr.to === 'resolved' ? 'primary' : 'outline'} onClick={() => setAction(tr)}>
              {trLabel(tr)}
            </Button>
          ))}
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <Card>
            <CardHeader title={t.info} />
            <div className="px-4 py-2">
              <KV label={t.cabinet} value={<Link className="text-primary" to={`/?cabinet=${inc.cabinetId}`}>{inc.cabinetName}</Link>} />
              <KV label={t.area} value={`${inc.wardName}, ${tx.area(inc.districtName)}`} />
              <KV label={t.category} value={tx.category(inc.category)} />
              <KV label={t.source} value={inc.source === 'alarm' ? t.fromAlarm : t.manual} />
              <KV label={t.reporter} value={inc.reportedBy} />
              <KV label={t.reportedAt} value={fmtTime(inc.reportedAt)} />
              <KV label={t.assignee} value={inc.assignee ?? '—'} />
              <KV label={t.deadline} value={<span className={inc.overdue ? 'text-st-offline' : ''}>{fmtTime(inc.deadline, 'DD/MM/YYYY HH:mm')}</span>} />
              <KV label={t.resolution} value={inc.resolution ?? '—'} />
            </div>
            <div className="border-t px-4 py-3 text-sm">{inc.content}</div>
          </Card>
          <Photos incidentId={inc.id} photos={inc.photoList ?? []} canUpload={can('incident.manage') || can('incident.resolve')} onChange={refresh} />
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader title={t.location} />
            <div className="p-4 text-sm">
              <div className="flex items-center gap-2">
                <MapPin className="h-4 w-4 text-st-offline" />
                {inc.location.lat.toFixed(6)}, {inc.location.lng.toFixed(6)}
              </div>
              <Link to={`/?cabinet=${inc.cabinetId}`}>
                <Button size="sm" variant="outline" className="mt-2 w-full">{t.viewOnMap}</Button>
              </Link>
              <DirectionsLink point={inc.location} className="mt-2 w-full" />
            </div>
          </Card>
          <Card>
            <CardHeader title={t.timeline} />
            <ol className="space-y-3 p-4">
              {inc.events.map((e, i) => (
                <li key={i} className="relative border-l-2 border-primary/40 pl-3">
                  {/* stored Vietnamese event text, shown in the reader's language when it is a known phrase (S49) */}
                  <div className="text-sm font-medium">{actions[e.action] ?? e.action}</div>
                  <div className="text-xs text-subtle">{actions[e.by] ?? e.by} · {fmtTime(e.at)}</div>
                  {e.note && <div className="mt-0.5 text-xs">{actions[e.note] ?? e.note}</div>}
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
      <Modal
        open={!!action}
        onOpenChange={(v) => !v && setAction(null)}
        title={action ? trLabel(action) : ''}
        footer={
          <>
            <Button variant="outline" onClick={() => setAction(null)}>{c.cancel}</Button>
            <Button
              loading={run.isPending}
              disabled={(action?.needs === 'resolve' && !note) || (action?.needs === 'assign' && (!assigneeId || !deadline))}
              onClick={() => run.mutate()}
            >
              {c.confirm}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {action?.needs === 'assign' && (
            <>
              <Field label={t.assignTo}>
                {assignees.isLoading ? (
                  <Spinner />
                ) : (
                  <Select className="w-full" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
                    <option value="">{t.pickAssignee}</option>
                    {assignees.data?.map((u) => (
                      <option key={u.id} value={u.id}>{u.fullName} ({u.email})</option>
                    ))}
                  </Select>
                )}
              </Field>
              {assignees.data?.length === 0 && <p className="text-xs text-subtle">{t.noAssignees}</p>}
              <Field label={t.deadline}>
                <Input type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
              </Field>
            </>
          )}
          <Field label={action?.needs === 'resolve' ? t.resolution : t.note}>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          {action?.needs === 'resolve' && <p className="text-xs text-subtle">{t.addPhotosHint}</p>}
        </div>
      </Modal>
    </div>
  );
}

function Photos({ incidentId, photos, canUpload, onChange }: { incidentId: string; photos: IncidentPhoto[]; canUpload: boolean; onChange: () => void }) {
  const t = useDict(INCIDENTS).detail;
  const input = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<'report' | 'resolution'>('report');
  const upload = useMutation({
    mutationFn: (f: File) => api.uploadIncidentPhoto(incidentId, kind, f),
    onSuccess: () => {
      toast(t.photoAdded, 'success');
      onChange();
    },
    onError: err,
  });
  const group = (k: IncidentPhoto['kind']) => photos.filter((p) => p.kind === k);
  return (
    <Card>
      <CardHeader
        title={t.photos}
        actions={
          canUpload && (
            <div className="flex items-center gap-2">
              <Select className="h-8 text-xs" value={kind} onChange={(e) => setKind(e.target.value as 'report' | 'resolution')} aria-label={t.photoKind}>
                <option value="report">{t.photoReport}</option>
                <option value="resolution">{t.photoResolution}</option>
              </Select>
              <Button size="sm" variant="outline" loading={upload.isPending} onClick={() => input.current?.click()}>
                <Camera className="h-4 w-4" /> {t.addPhoto}
              </Button>
              <input
                ref={input}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                capture="environment"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) upload.mutate(f);
                }}
              />
            </div>
          )
        }
      />
      <div className="space-y-3 p-4">
        {photos.length === 0 && <div className="text-sm text-subtle">{t.noPhotos}</div>}
        {(['report', 'resolution'] as const).map((k) =>
          group(k).length ? (
            <div key={k}>
              <div className="mb-1 text-xs font-medium text-subtle">{k === 'report' ? t.photoReport : t.photoResolution}</div>
              <div className="grid grid-cols-3 gap-2">
                {group(k).map((p) => (
                  <a key={p.id} href={p.url} target="_blank" rel="noreferrer" title={`${p.uploadedBy} · ${fmtTime(p.createdAt)}`}>
                    <img src={p.url} alt="" loading="lazy" className="aspect-video w-full rounded-md border object-cover" />
                  </a>
                ))}
              </div>
            </div>
          ) : null,
        )}
      </div>
    </Card>
  );
}
