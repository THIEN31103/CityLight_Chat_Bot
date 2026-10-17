import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, CircleSlash, HelpCircle, Play, XCircle } from 'lucide-react';
import type { CabinetDetail, Command, DiagStatus } from '@citylight/shared';
import { api } from '@/lib/api';
import { subscribe } from '@/lib/realtime';
import { useSession } from '@/stores/session';
import { cn, fmtTime } from '@/lib/utils';
import { Badge, Button, Card, CardHeader, KV, Spinner } from '@/components/ui';
import { ErrorCodeBadge } from '@/components/ErrorHelp';
import { useCommand } from './useCommand';

const STATUS: Record<DiagStatus, { label: string; cls: string; Icon: typeof CheckCircle2 }> = {
  ok: { label: 'Bình thường', cls: 'text-st-on', Icon: CheckCircle2 },
  warn: { label: 'Cảnh báo', cls: 'text-st-dimming', Icon: AlertTriangle },
  fault: { label: 'Lỗi', cls: 'text-st-offline', Icon: XCircle },
  unknown: { label: 'Không rõ', cls: 'text-st-unknown', Icon: HelpCircle },
  unsupported: { label: 'Chưa hỗ trợ', cls: 'text-subtle', Icon: CircleSlash },
};

export function DiagnosticsTab({ detail }: { detail: CabinetDetail }) {
  const id = detail.cabinet.id;
  const qc = useQueryClient();
  const can = useSession((s) => s.can('cabinet.control'));
  const { data, isLoading } = useQuery({ queryKey: ['diagnostics', id], queryFn: () => api.diagnostics(id), refetchInterval: 15000 });
  const { send } = useCommand(id, `${detail.cabinet.code} - ${detail.cabinet.name}`);

  useEffect(
    () =>
      subscribe<Command>('command.updated', (c) => {
        if (c.cabinetId === id && c.type === 'DIAG' && c.status === 'confirmed') qc.invalidateQueries({ queryKey: ['diagnostics', id] });
      }),
    [id, qc],
  );

  if (isLoading || !data) return <Spinner />;
  const counts = data.items.reduce<Record<DiagStatus, number>>((acc, i) => ({ ...acc, [i.status]: (acc[i.status] ?? 0) + 1 }), { ok: 0, warn: 0, fault: 0, unknown: 0, unsupported: 0 });

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {(['fault', 'warn', 'ok', 'unknown'] as DiagStatus[]).map((k) => {
          const S = STATUS[k];
          return (
            <Card key={k} className="flex items-center gap-3 p-3">
              <S.Icon className={cn('h-6 w-6', S.cls)} />
              <div>
                <div className="text-xl font-semibold">{counts[k]}</div>
                <div className="text-xs text-subtle">{S.label}</div>
              </div>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader title="Tình trạng từng bộ phận" subtitle="Suy ra từ LCLI, MCON, PCON, PTIM, CTTE, LGPS… trong telemetry. Bấm mã lỗi để xem cách xử lý." />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/60 text-left text-xs text-subtle">
              <tr>
                <th className="px-3 py-2">Bộ phận</th>
                <th className="px-3 py-2">Trạng thái</th>
                <th className="px-3 py-2">Mã</th>
                <th className="px-3 py-2">Dữ liệu</th>
                <th className="px-3 py-2">Đánh giá</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((i) => {
                const S = STATUS[i.status];
                return (
                  <tr key={i.subsystem} className={cn('border-t', i.status === 'fault' && 'bg-st-offline/5')}>
                    <td className="px-3 py-2">
                      <div className="font-medium">{i.subsystem}</div>
                      <div className="text-xs text-subtle">{i.role}</div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <span className={cn('inline-flex items-center gap-1 text-xs font-medium', S.cls)}>
                        <S.Icon className="h-4 w-4" /> {S.label}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <ErrorCodeBadge code={i.code} />
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{i.evidence}</td>
                    <td className="px-3 py-2 text-xs">{i.detail}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader
            title="Tự kiểm tra RS485 (LDIA)"
            subtitle="Kiểm transceiver RS485 trên board LTE, không cần slave"
            actions={
              can && (
                <Button size="sm" variant="outline" disabled={!detail.state.online} onClick={() => send('DIAG', {}, 'Chạy tự kiểm tra RS485 (LDIA)')}>
                  <Play className="h-4 w-4" /> Chạy
                </Button>
              )
            }
          />
          <div className="px-4 py-2">
            {data.selfTest ? (
              <>
                <KV label="Lúc" value={fmtTime(data.selfTest.at)} />
                <KV label="Kết quả thô" value={<span className="font-mono">{data.selfTest.summary}</span>} />
                <KV label="Đường thu (RX)" value={<span className="text-xs">{data.selfTest.rx}</span>} />
                <KV label="Tắt driver (DE)" value={<span className="text-xs">{data.selfTest.de}</span>} />
                <KV label="Đường phát (TX)" value={<span className="text-xs">{data.selfTest.tx}</span>} />
                <div className="pt-2">
                  {data.selfTest.fail ? <Badge tone="orange">Cần kiểm tra thêm (E206)</Badge> : <Badge tone="green">Không thấy lỗi phía LTE</Badge>}
                </div>
              </>
            ) : (
              <div className="py-4 text-sm text-subtle">Chưa chạy lần nào. Nên chạy khi gặp E204 (mất cả 3 slave).</div>
            )}
          </div>
        </Card>
        <Card>
          <CardHeader title="Khởi động & kết nối" />
          <div className="px-4 py-2">
            <KV label="Khởi động gần nhất" value={fmtTime(data.lastBootAt)} />
            <KV label="Số lần khởi động / 24 h" value={<span className={data.bootsLast24h >= 3 ? 'text-st-offline' : ''}>{data.bootsLast24h}</span>} />
            <KV label="Frame telemetry cuối" value={fmtTime(detail.state.lastSeenAt)} />
            <KV label="Mã bus RS485 (LCLI)" value={<span className="font-mono">{detail.state.busStatus ?? 'X'}</span>} />
            <p className="pt-2 text-xs text-subtle">LED PC6 trên board LTE: nháy 4 Hz 3 s rồi tắt = lỗi SIM · 0,2 Hz = có 4G, chưa nối broker · 1 Hz = bình thường.</p>
          </div>
        </Card>
      </div>
    </div>
  );
}
