import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Camera, MapPin } from 'lucide-react';
import type { Incident } from '@citylight/shared';
import { INCIDENT_STATUS_LABELS } from '@citylight/shared';
import { api } from '@/lib/api';
import { useSession } from '@/stores/session';
import { fmtTime } from '@/lib/utils';
import { Badge, Button, Card, CardHeader, Field, Input, KV, Modal, Spinner, Textarea, toast } from '@/components/ui';
import { INCIDENT_TONE } from './IncidentsPage';

type Transition = { to: Incident['status']; label: string; perm: 'incident.manage' | 'incident.resolve'; needs?: 'assign' | 'resolve' };

const NEXT: Record<Incident['status'], Transition[]> = {
  new: [
    { to: 'assigned', label: 'Giao xử lý', perm: 'incident.manage', needs: 'assign' },
    { to: 'deferred', label: 'Chưa cần xử lý', perm: 'incident.manage' },
  ],
  assigned: [{ to: 'resolved', label: 'Báo đã xử lý', perm: 'incident.resolve', needs: 'resolve' }],
  deferred: [{ to: 'assigned', label: 'Giao xử lý', perm: 'incident.manage', needs: 'assign' }],
  resolved: [
    { to: 'closed', label: 'Đóng sự cố', perm: 'incident.manage' },
    { to: 'assigned', label: 'Yêu cầu xử lý lại', perm: 'incident.manage', needs: 'assign' },
  ],
  closed: [{ to: 'new', label: 'Mở lại', perm: 'incident.manage' }],
};

export function IncidentDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const can = useSession((s) => s.can);
  const { data: inc, isLoading } = useQuery({ queryKey: ['incident', id], queryFn: () => api.incident(id!) });
  const [action, setAction] = useState<Transition | null>(null);
  const [note, setNote] = useState('');
  const [assignee, setAssignee] = useState('Lê Văn Tu');
  const [deadline, setDeadline] = useState('');
  const run = useMutation({
    mutationFn: () =>
      api.transitionIncident(id!, {
        to: action!.to,
        note: note || undefined,
        assignee: action?.needs === 'assign' ? assignee : undefined,
        deadline: action?.needs === 'assign' && deadline ? new Date(deadline + 'T17:00:00').toISOString() : undefined,
        resolution: action?.needs === 'resolve' ? note : undefined,
      }),
    onSuccess: () => {
      toast('Đã cập nhật sự cố', 'success');
      setAction(null);
      setNote('');
      qc.invalidateQueries({ queryKey: ['incident', id] });
      qc.invalidateQueries({ queryKey: ['incidents'] });
    },
  });

  if (isLoading || !inc) return <div className="p-6"><Spinner /></div>;

  return (
    <div className="mx-auto max-w-5xl p-4">
      <Link to="/incidents" className="mb-3 inline-flex items-center gap-1 text-sm text-subtle hover:text-fg">
        <ArrowLeft className="h-4 w-4" /> Danh sách sự cố
      </Link>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold">Sự cố {inc.code}</h1>
          <Badge tone={INCIDENT_TONE[inc.status]}>{INCIDENT_STATUS_LABELS[inc.status]}</Badge>
        </div>
        <div className="flex gap-2">
          {NEXT[inc.status].filter((t) => can(t.perm)).map((t) => (
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
              <KV label="Hạn xử lý" value={fmtTime(inc.deadline, 'DD/MM/YYYY HH:mm')} />
              <KV label="Nội dung xử lý" value={inc.resolution ?? '—'} />
            </div>
            <div className="border-t px-4 py-3 text-sm">{inc.content}</div>
          </Card>
          <Card>
            <CardHeader title="Hình ảnh" actions={<Button size="sm" variant="outline" onClick={() => toast('Upload ảnh nối API ở M7 (mock)')}><Camera className="h-4 w-4" /> Thêm ảnh</Button>} />
            <div className="grid grid-cols-3 gap-2 p-4">
              {[1, 2, 3].map((i) => (
                <div key={i} className="flex aspect-video items-center justify-center rounded-md border border-dashed text-xs text-subtle">Hình {i}</div>
              ))}
            </div>
          </Card>
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
            <Button loading={run.isPending} disabled={action?.needs === 'resolve' && !note} onClick={() => run.mutate()}>Xác nhận</Button>
          </>
        }
      >
        <div className="space-y-3">
          {action?.needs === 'assign' && (
            <>
              <Field label="Giao cho">
                <Input value={assignee} onChange={(e) => setAssignee(e.target.value)} />
              </Field>
              <Field label="Hạn xử lý">
                <Input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
              </Field>
            </>
          )}
          <Field label={action?.needs === 'resolve' ? 'Nội dung xử lý' : 'Ghi chú / ý kiến'}>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
      </Modal>
    </div>
  );
}
