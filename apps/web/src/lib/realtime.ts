// Realtime abstraction (spec 11, WebSocket). Mock mode plugs in the in-browser emitter;
// the real build will plug in a Socket.IO client with the same interface.

export type RealtimeEvent = 'cabinet.state' | 'command.updated' | 'alarm.raised' | 'alarm.cleared' | 'batch.progress';

export interface Realtime {
  subscribe(event: RealtimeEvent, handler: (payload: unknown) => void): () => void;
}

let impl: Realtime = {
  subscribe: () => () => undefined,
};

export function setRealtime(r: Realtime) {
  impl = r;
}

export function subscribe<T>(event: RealtimeEvent, handler: (payload: T) => void) {
  return impl.subscribe(event, handler as (p: unknown) => void);
}
