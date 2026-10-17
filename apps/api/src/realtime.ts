// Socket.IO gateway (spec 11): relays worker events from Redis to signed-in browsers.
// Auth = the same session cookie as REST; unauthenticated sockets are disconnected.
import { Inject, Injectable, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer, type OnGatewayConnection } from '@nestjs/websockets';
import { Redis } from 'ioredis';
import type { Server, Socket } from 'socket.io';
import { AuthModule, AuthService, SESSION_COOKIE } from './auth';
import { REDIS } from './infra';

const EVENTS_CHANNEL = 'cl:events';

function cookieValue(header: string | undefined, name: string) {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

@Injectable()
@WebSocketGateway({ path: '/socket.io', cors: false })
export class RealtimeGateway implements OnGatewayConnection, OnModuleInit, OnModuleDestroy {
  @WebSocketServer() server!: Server;
  private sub: Redis | null = null;

  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(REDIS) private readonly redis: Redis) {}

  async handleConnection(socket: Socket) {
    const user = await this.auth.fromSession(cookieValue(socket.handshake.headers.cookie, SESSION_COOKIE));
    if (!user) {
      socket.emit('error', { code: 'unauthenticated' });
      socket.disconnect(true);
      return;
    }
    socket.data.user = user;
    void socket.join('all');
  }

  async onModuleInit() {
    this.sub = this.redis.duplicate();
    await this.sub.subscribe(EVENTS_CHANNEL);
    this.sub.on('message', (_ch, msg) => {
      try {
        const ev = JSON.parse(msg) as { type: string; items?: unknown[]; alarm?: unknown };
        if (ev.type === 'cabinet.state') for (const it of ev.items ?? []) this.server?.to('all').emit('cabinet.state', it);
        else if (ev.type === 'alarm.raised' || ev.type === 'alarm.cleared') this.server?.to('all').emit(ev.type, ev.alarm);
      } catch {
        /* ignore malformed */
      }
    });
  }

  async onModuleDestroy() {
    await this.sub?.quit().catch(() => undefined);
  }
}

@Module({ imports: [AuthModule], providers: [RealtimeGateway] })
export class RealtimeModule {}
