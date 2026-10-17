import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PanelRight, Maximize2, X } from 'lucide-react';
import type { CabinetState, Command, GeoPoint } from '@citylight/shared';
import { api } from '@/lib/api';
import { subscribe } from '@/lib/realtime';
import { fmtTime } from '@/lib/utils';
import { Badge, Skeleton, StatusBadge, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { cn } from '@/lib/utils';
import { ControlTab } from './ControlTab';
import { MonitorTab, ChartTab, EnergyTab, LeakTempTab } from './MonitorTabs';
import { ThresholdsTab, DimmingTab, LampsTab, InfoTab, CabinetAlarmsTab, CommandsTab } from './OtherTabs';

const STATUS_BAR: Record<string, string> = {
  offline: 'bg-st-offline',
  fault: 'bg-st-fault',
  dimming: 'bg-st-dimming',
  on: 'bg-st-on',
  off: 'bg-st-off',
  unknown: 'bg-st-unknown',
};

/** Cabinet detail: centred panel by default; can be docked to the right to keep the map visible. */
export function CabinetDrawer({
  cabinetId,
  mode,
  onToggleMode,
  onClose,
  onLocate,
}: {
  cabinetId: string;
  mode: 'center' | 'dock';
  onToggleMode: () => void;
  onClose: () => void;
  onLocate: (p: GeoPoint) => void;
}) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['cabinet', cabinetId], queryFn: () => api.cabinet(cabinetId) });

  // Realtime while the drawer is open (spec: detail panel updates live).
  useEffect(() => {
    const off1 = subscribe<CabinetState>('cabinet.state', (s) => {
      if (s.cabinetId === cabinetId) qc.setQueryData(['cabinet', cabinetId], (old: typeof data) => (old ? { ...old, state: s } : old));
    });
    const off2 = subscribe<Command>('command.updated', (c) => {
      if (c.cabinetId === cabinetId) qc.invalidateQueries({ queryKey: ['cabinet-commands', cabinetId] });
    });
    return () => {
      off1();
      off2();
    };
  }, [cabinetId, qc]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const panel = (
    <aside
      role="dialog"
      aria-label="Chi tiết tủ"
      className={cn(
        'flex flex-col bg-panel shadow-2xl',
        mode === 'dock'
          ? 'absolute inset-y-0 right-0 z-20 w-[min(760px,100vw)] border-l'
          : 'relative z-30 h-[min(88vh,900px)] w-[min(1100px,calc(100vw-32px))] overflow-hidden rounded-xl border',
      )}
      onClick={(e) => e.stopPropagation()}
    >
      <div className={`h-1 ${data ? STATUS_BAR[data.state.status] : 'bg-border'}`} />
      <div className="flex items-start justify-between gap-3 border-b px-4 py-3">
        {isLoading || !data ? (
          <Skeleton className="h-10 w-72" />
        ) : (
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-lg font-semibold">
                {data.cabinet.code} - {data.cabinet.name}
              </h2>
              <StatusBadge status={data.state.status} />
              {data.cabinet.fwProfile === 'v2-1307ebc' && <Badge tone="orange">Firmware cũ · chỉ giám sát</Badge>}
            </div>
            <div className="text-xs text-subtle">
              {data.cabinet.ltid} · {data.cabinet.address}, {data.cabinet.wardName}, {data.cabinet.districtName} · cập nhật {fmtTime(data.state.lastSeenAt)}
            </div>
          </div>
        )}
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={onToggleMode}
            className="rounded-md p-1.5 hover:bg-muted"
            aria-label={mode === 'center' ? 'Ghim sang phải để xem bản đồ' : 'Hiển thị giữa màn hình'}
            title={mode === 'center' ? 'Ghim sang phải để xem bản đồ' : 'Hiển thị giữa màn hình'}
          >
            {mode === 'center' ? <PanelRight className="h-5 w-5" /> : <Maximize2 className="h-5 w-5" />}
          </button>
          <button onClick={onClose} className="rounded-md p-1.5 hover:bg-muted" aria-label="Đóng chi tiết tủ">
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>
      {data && (
        <Tabs defaultValue="control" className="flex min-h-0 flex-1 flex-col">
          <TabsList>
            <TabsTrigger value="control">Điều khiển</TabsTrigger>
            <TabsTrigger value="monitor">Giám sát</TabsTrigger>
            <TabsTrigger value="voltage">Điện áp</TabsTrigger>
            <TabsTrigger value="current">Dòng điện</TabsTrigger>
            <TabsTrigger value="energy">Năng lượng</TabsTrigger>
            <TabsTrigger value="leak">Rò dòng & nhiệt</TabsTrigger>
            <TabsTrigger value="thresholds">Cài đặt</TabsTrigger>
            <TabsTrigger value="dimming">Tiết giảm</TabsTrigger>
            <TabsTrigger value="lamps">Đèn</TabsTrigger>
            <TabsTrigger value="info">Thông tin</TabsTrigger>
            <TabsTrigger value="alarms">Cảnh báo</TabsTrigger>
            <TabsTrigger value="commands">Lệnh</TabsTrigger>
          </TabsList>
          <div className="min-h-0 flex-1 overflow-auto p-4">
            <TabsContent value="control">
              <ControlTab detail={data} />
            </TabsContent>
            <TabsContent value="monitor">
              <MonitorTab detail={data} />
            </TabsContent>
            <TabsContent value="voltage">
              <ChartTab cabinetId={cabinetId} metrics={['vL1', 'vL2', 'vL3']} unit="V" title="Điện áp 3 pha" names={['L1N', 'L2N', 'L3N']} />
            </TabsContent>
            <TabsContent value="current">
              <ChartTab cabinetId={cabinetId} metrics={['iL1', 'iL2', 'iL3']} unit="A" title="Dòng điện 3 pha" names={['I1', 'I2', 'I3']} />
            </TabsContent>
            <TabsContent value="energy">
              <EnergyTab cabinetId={cabinetId} />
            </TabsContent>
            <TabsContent value="leak">
              <LeakTempTab detail={data} />
            </TabsContent>
            <TabsContent value="thresholds">
              <ThresholdsTab detail={data} />
            </TabsContent>
            <TabsContent value="dimming">
              <DimmingTab detail={data} />
            </TabsContent>
            <TabsContent value="lamps">
              <LampsTab detail={data} onLocate={onLocate} />
            </TabsContent>
            <TabsContent value="info">
              <InfoTab detail={data} onLocate={onLocate} />
            </TabsContent>
            <TabsContent value="alarms">
              <CabinetAlarmsTab cabinetId={cabinetId} />
            </TabsContent>
            <TabsContent value="commands">
              <CommandsTab cabinetId={cabinetId} />
            </TabsContent>
          </div>
        </Tabs>
      )}
    </aside>
  );

  if (mode === 'dock') return panel;
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/35 p-4 backdrop-blur-[1px]" onClick={onClose}>
      {panel}
    </div>
  );
}
