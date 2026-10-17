// Socket.IO implementation of the Realtime interface (real / hybrid modes).
// The server authenticates the socket with the session cookie and disconnects anonymous sockets,
// so after a server-side disconnect we retry (the user may have just signed in).
import { io, type Socket } from 'socket.io-client';
import type { Realtime } from './realtime';

export function createSocketRealtime(): Realtime {
  let socket: Socket | null = null;
  const ensure = () => {
    if (socket) return socket;
    socket = io({ path: '/socket.io', withCredentials: true, transports: ['websocket'] });
    socket.on('disconnect', (reason) => {
      if (reason === 'io server disconnect') setTimeout(() => socket?.connect(), 5000);
    });
    return socket;
  };
  return {
    subscribe(event, handler) {
      const s = ensure();
      s.on(event, handler);
      return () => {
        s.off(event, handler);
      };
    },
  };
}
