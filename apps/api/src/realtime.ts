// Socket.IO gateway (spec 11): relays worker events from Redis to signed-in browsers.
// Auth = the same session cookie as REST; unauthenticated sockets are disconnected.
// Scope (spec 13): scope_all users join room `all`, others one room per area (descendants included);
// each event goes to `all` plus the cabinet's district and ward rooms, so users only get their cabinets.
import { Inject, Injectable, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer, type OnGatewayConnection } from '@nestjs/websockets';
import { Redis } from 'ioredis';
import type { Server, Socket } from 'socket.io';
import { stripLtid } from '@citylight/shared';
import { AUTH_CHANNEL, AuthModule, AuthService, SESSION_COOKIE, publicUser } from './auth';
import { REDIS, SQL, type Sql } from './infra';

const EVENTS_CHANNEL = 'cl:events';
const AREA_REFRESH_MS = 60_000;

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
  /** cabinet id -> rooms of its district / ward */
  private cabinetRooms = new Map<string, string[]>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(SQL) private readonly sql: Sql,
  ) {}

  async handleConnection(socket: Socket) {
    const sid = cookieValue(socket.handshake.headers.cookie, SESSION_COOKIE);
    const user = await this.auth.fromSession(sid);
    // a user who still has to set up 2FA or change a temporary password gets no live data either
    if (!user || (user.totpRequired && !user.totpEnabled) || user.passwordChangeRequired) {
      socket.emit('error', { code: 'unauthenticated' });
      socket.disconnect(true);
      return;
    }
    socket.data.user = publicUser(user);
    socket.data.sid = sid;
    void socket.join(`user:${user.id}`); // own batch progress
    if (user.scope.all) void socket.join('all');
    else for (const id of user.scope.areaIds) void socket.join(`area:${id}`);
  }

  private async refreshAreas() {
    const rows = await this.sql<{ id: string; district_id: string | null; ward_id: string | null }[]>`SELECT id, district_id, ward_id FROM cabinets`;
    const m = new Map<string, string[]>();
    for (const r of rows) m.set(r.id, [r.district_id, r.ward_id].filter((x): x is string => !!x).map((x) => `area:${x}`));
    this.cabinetRooms = m;
  }

  private roomsFor(cabinetId: string) {
    return ['all', ...(this.cabinetRooms.get(cabinetId) ?? [])];
  }

  async onModuleInit() {
    await this.refreshAreas();
    this.timer = setInterval(() => void this.refreshAreas().catch((e) => console.error('[realtime] area refresh', e)), AREA_REFRESH_MS);
    this.sub = this.redis.duplicate();
    await this.sub.subscribe(EVENTS_CHANNEL, AUTH_CHANNEL);
    this.sub.on('message', (ch, msg) => {
      try {
        if (ch === AUTH_CHANNEL) return void this.onAuthEvent(JSON.parse(msg));
        // rooms are by area, not by role: nobody gets the LTID here, the screens read it from the API
        const ev = stripLtid(JSON.parse(msg)) as {
          type: string; items?: { cabinetId: string }[]; alarm?: { cabinetId: string }; command?: { cabinetId: string };
          batch?: { requestedById: string };
        };
        // socket.io de-duplicates a socket that is in several of the target rooms
        if (ev.type === 'cabinet.state') for (const it of ev.items ?? []) this.server?.to(this.roomsFor(it.cabinetId)).emit('cabinet.state', it);
        else if ((ev.type === 'alarm.raised' || ev.type === 'alarm.cleared') && ev.alarm) this.server?.to(this.roomsFor(ev.alarm.cabinetId)).emit(ev.type, ev.alarm);
        else if (ev.type === 'command.updated' && ev.command) this.server?.to(this.roomsFor(ev.command.cabinetId)).emit('command.updated', ev.command);
        else if (ev.type === 'batch.progress' && ev.batch) {
          const { requestedById, ...b } = ev.batch;
          this.server?.to(['all', `user:${requestedById}`]).emit('batch.progress', b);
        }
      } catch {
        /* ignore malformed */
      }
    });
  }

  /** Revoked sessions lose their sockets at once (role / scope / active changed, password reset). */
  private async onAuthEvent(ev: { type: string; userId: string; exceptSid?: string | null }) {
    if (ev.type !== 'revoke' || !this.server) return;
    for (const s of await this.server.fetchSockets()) {
      if (s.data.user?.id === ev.userId && s.data.sid !== ev.exceptSid) s.disconnect(true);
    }
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.sub?.quit().catch(() => undefined);
  }
}

@Module({ imports: [AuthModule], providers: [RealtimeGateway] })
export class RealtimeModule {}
