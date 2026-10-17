import { useEffect, useState } from 'react';
import type { Command, CommandType } from '@citylight/shared';
import { COMMAND_TYPE_LABELS } from '@citylight/shared';
import { api, ApiError } from '@/lib/api';
import { subscribe } from '@/lib/realtime';
import { confirm, toast } from '@/components/ui';

/** Sends a command after a confirm dialog and tracks its lifecycle via realtime events (spec 12). */
export function useCommand(cabinetId: string, cabinetLabel: string) {
  const [active, setActive] = useState<Command | null>(null);

  useEffect(() => {
    return subscribe<Command>('command.updated', (c) => {
      setActive((cur) => (cur && cur.id === c.id ? c : cur));
      if (c.cabinetId !== cabinetId) return;
      if (c.status === 'confirmed') toast(`${COMMAND_TYPE_LABELS[c.type]}: tủ đã xác nhận`, 'success');
      if (c.status === 'failed' || c.status === 'timeout') toast(`${COMMAND_TYPE_LABELS[c.type]}: ${c.error ?? c.status}`, 'error');
    });
  }, [cabinetId]);

  async function send(type: CommandType, params: Record<string, unknown>, actionText: string, danger = false) {
    const ok = await confirm({
      title: 'Xác nhận gửi lệnh',
      body: (
        <div className="space-y-1">
          <div>
            Tủ: <b>{cabinetLabel}</b>
          </div>
          <div>
            Hành động: <b>{actionText}</b>
          </div>
        </div>
      ),
      danger,
      confirmLabel: 'Gửi lệnh',
    });
    if (!ok) return;
    try {
      const cmd = await api.sendCommand(cabinetId, type, params);
      setActive(cmd);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Gửi lệnh thất bại', 'error');
    }
  }

  return { active, send, clear: () => setActive(null) };
}
