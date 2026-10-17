// Redis pub/sub channel between workers and the API's Socket.IO gateway.
export const EVENTS_CHANNEL = 'cl:events';

export type WorkerEvent =
  | { type: 'cabinet.state'; items: CabinetStateEvent[] }
  | { type: 'alarm.raised'; alarm: AlarmEvent }
  | { type: 'alarm.cleared'; alarm: AlarmEvent };

export interface CabinetStateEvent {
  cabinetId: string;
  ltid: string;
  status: string;
  online: boolean;
  branch1On: boolean | null;
  branch2On: boolean | null;
  manualMode: boolean | null;
  activeAlarmCount: number;
  lastSeenAt: string | null;
}

export interface AlarmEvent {
  id: string;
  code: string;
  type: string;
  severity: string;
  cabinetId: string;
  cabinetCode: string;
  cabinetName: string;
  message: string;
  startedAt: string;
  endedAt: string | null;
}
