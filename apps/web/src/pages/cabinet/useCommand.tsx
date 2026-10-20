import { useEffect, useState } from 'react';
import type { Command, CommandType } from '@citylight/shared';
import { CONFIRMED_BY_TELEMETRY, LABELS } from '@citylight/shared';
import { api, ApiError } from '@/lib/api';
import { subscribe } from '@/lib/realtime';
import { confirm, toast } from '@/components/ui';
import { dictNow, fill, getLang } from '@/i18n';
import { CABINET } from '@/i18n/dict/cabinet';

/** Sends a command after a confirm dialog and tracks its lifecycle via realtime events (spec 12). */
export function useCommand(cabinetId: string, cabinetLabel: string) {
  const [active, setActive] = useState<Command | null>(null);

  useEffect(() => {
    return subscribe<Command>('command.updated', (c) => {
      setActive((cur) => (cur && cur.id === c.id ? c : cur));
      if (c.cabinetId !== cabinetId) return;
      const t = dictNow(CABINET).command;
      const type = LABELS[getLang()].commandType[c.type];
      if (c.status === 'confirmed') toast(fill(t.confirmed, { type }), 'success');
      // these types have nothing in telemetry to confirm: "acked" is their final state
      if (c.status === 'acked' && !CONFIRMED_BY_TELEMETRY.includes(c.type)) toast(fill(t.acked, { type }), 'success');
      if (c.status === 'acked_unconfirmed') toast(fill(t.ackedUnconfirmed, { type }), 'info');
      if (c.status === 'failed' || c.status === 'timeout') toast(`${type}: ${c.error ?? c.status}`, 'error');
    });
  }, [cabinetId]);

  async function send(type: CommandType, params: Record<string, unknown>, actionText: string, danger = false) {
    const t = dictNow(CABINET).command;
    const ok = await confirm({
      title: t.title,
      body: (
        <div className="space-y-1">
          <div>
            {t.cabinet} <b>{cabinetLabel}</b>
          </div>
          <div>
            {t.action} <b>{actionText}</b>
          </div>
        </div>
      ),
      danger,
      confirmLabel: t.send,
    });
    if (!ok) return;
    try {
      const cmd = await api.sendCommand(cabinetId, type, params);
      setActive(cmd);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : t.failed, 'error');
    }
  }

  return { active, send, clear: () => setActive(null) };
}
