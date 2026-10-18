import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Camera, MapPin } from 'lucide-react';
import type { IncidentPhoto, IncidentTransition } from '@citylight/shared';
import { INCIDENT_STATUS_LABELS, INCIDENT_TRANSITIONS } from '@citylight/shared';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/stores/session';
import { fmtTime } from '@/lib/utils';
import { Badge, Button, Card, CardHeader, Field, Input, KV, Modal, Select, Spinner, Textarea, toast } from '@/components/ui';
import { INCIDENT_TONE } from './IncidentsPage';

const err = (e: unknown) => toast(e instanceof ApiError ? e.message : 'Lỗi', 'error');

export function IncidentDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const can = useSession((s) => s.can);
  const me = useSession((s) => s.user);
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
      toast('Đã cập nhật sự cố', 'success');
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

  return (
    <div className="mx-auto max-w-5xl p-4">
      <Link to="/incidents" className="mb-3 inline-flex items-center gap-1 text-sm text-subtle hover:text-fg">
        <ArrowLeft className="h-4 w-4" /> Danh sách sự cố
      </Link>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold">Sự cố {inc.code}</h1>
          <Badge tone={INCIDENT_TONE[inc.status]}>{INCIDENT_STATUS_LABELS[inc.status]}</Badge>
          {inc.overdue && <Badge tone="red">Quá hạn</Badge>}
        </div>
        <div className="flex gap-2">
          {allowed.map((t) => (
            <Button key={t.label} variant={t.to === 'closed' || t.to === 'resolved' ? 'primary' : 'outline'} onClick={() => setAction(t)}>
              {t.label}
            </Button>
          ))}
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <Card>
            <CardHeader title="Thông tin sự cố" />
            <div className="px-4 py-2">
              <KV label="Tủ" value={<Link className="text-primary" to={`/?cabinet=${inc.cabinetId}`}>{inc.cabinetName}</Link>} />
              <KV label="Khu vực" value={`${inc.wardName}, ${inc.districtName}`} />
              <KV label="Phân loại" value={inc.category} />
              <KV label="Nguồn" value={inc.source === 'alarm' ? 'Từ cảnh báo' : 'Tạo thủ công'} />
              <KV label="Người báo" value={inc.reportedBy} />
              <KV label="Thời điểm ghi nhận" value={fmtTime(inc.reportedAt)} />
              <KV label="Người xử lý" value={inc.assignee ?? '—'} />
              <KV label="Hạn xử lý" value={<span className={inc.overdue ? 'text-st-offline' : ''}>{fmtTime(inc.deadline, 'DD/MM/YYYY HH:mm')}</span>} />
              <KV label="Nội dung xử lý" value={inc.resolution ?? '—'} />
            </div>
            <div className="border-t px-4 py-3 text-sm">{inc.content}</div>
          </Card>
          <Photos incidentId={inc.id} photos={inc.photoList ?? []} canUpload={can('incident.manage') || can('incident.resolve')} onChange={refresh} />
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader title="Vị trí" />
            <div className="p-4 text-sm">
              <div className="flex items-center gap-2">
                <MapPin className="h-4 w-4 text-st-offline" />
                {inc.location.lat.toFixed(6)}, {inc.location.lng.toFixed(6)}
              </div>
              <Link to={`/?cabinet=${inc.cabinetId}`}>
                <Button size="sm" variant="outline" className="mt-2 w-full">Xem trên bản đồ</Button>
              </Link>
            </div>
          </Card>
          <Card>
            <CardHeader title="Tiến trình" />
            <ol className="space-y-3 p-4">
              {inc.events.map((e, i) => (
                <li key={i} className="relative border-l-2 border-primary/40 pl-3">
                  <div className="text-sm font-medium">{e.action}</div>
                  <div className="text-xs text-subtle">{e.by} · {fmtTime(e.at)}</div>
                  {e.note && <div className="mt-0.5 text-xs">{e.note}</div>}
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
      <Modal
        open={!!action}
        onOpenChange={(v) => !v && setAction(null)}
        title={action?.label ?? ''}
        footer={
          <>
            <Button variant="outline" onClick={() => setAction(null)}>Hủy</Button>
            <Button
              loading={run.isPending}
              disabled={(action?.needs === 'resolve' && !note) || (action?.needs === 'assign' && (!assigneeId || !deadline))}
              onClick={() => run.mutate()}
            >
              Xác nhận
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {action?.needs === 'assign' && (
            <>
              <Field label="Giao cho">
                {assignees.isLoading ? (
                  <Spinner />
                ) : (
                  <Select className="w-full" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
                    <option value="">— chọn người xử lý —</option>
                    {assignees.data?.map((u) => (
                      <option key={u.id} value={u.id}>{u.fullName} ({u.email})</option>
                    ))}
                  </Select>
                )}
              </Field>
              {assignees.data?.length === 0 && <p className="text-xs text-subtle">Chưa có tài khoản Bảo trì nào phụ trách khu vực của tủ này.</p>}
              <Field label="Hạn xử lý">
                <Input type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
              </Field>
            </>
          )}
          <Field label={action?.needs === 'resolve' ? 'Nội dung xử lý' : 'Ghi chú / ý kiến'}>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          {action?.needs === 'resolve' && <p className="text-xs text-subtle">Thêm ảnh sau xử lý ở mục Hình ảnh.</p>}
        </div>
      </Modal>
    </div>
  );
}

function Photos({ incidentId, photos, canUpload, onChange }: { incidentId: string; photos: IncidentPhoto[]; canUpload: boolean; onChange: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<'report' | 'resolution'>('report');
  const upload = useMutation({
    mutationFn: (f: File) => api.uploadIncidentPhoto(incidentId, kind, f),
    onSuccess: () => {
      toast('Đã thêm ảnh', 'success');
      onChange();
    },
    onError: err,
  });
  const group = (k: IncidentPhoto['kind']) => photos.filter((p) => p.kind === k);
  return (
    <Card>
      <CardHeader
        title="Hình ảnh"
        actions={
          canUpload && (
            <div className="flex items-center gap-2">
              <Select className="h-8 text-xs" value={kind} onChange={(e) => setKind(e.target.value as 'report' | 'resolution')} aria-label="Loại ảnh">
                <option value="report">Ảnh hiện trường</option>
                <option value="resolution">Ảnh sau xử lý</option>
              </Select>
              <Button size="sm" variant="outline" loading={upload.isPending} onClick={() => input.current?.click()}>
                <Camera className="h-4 w-4" /> Thêm ảnh
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
        {photos.length === 0 && <div className="text-sm text-subtle">Chưa có ảnh. JPG / PNG / WebP, tối đa 5 MB, 10 ảnh mỗi sự cố.</div>}
        {(['report', 'resolution'] as const).map((k) =>
          group(k).length ? (
            <div key={k}>
              <div className="mb-1 text-xs font-medium text-subtle">{k === 'report' ? 'Ảnh hiện trường' : 'Ảnh sau xử lý'}</div>
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
