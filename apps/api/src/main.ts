import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { IoAdapter } from '@nestjs/platform-socket.io';
import compress from '@fastify/compress';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { AdminModule } from './admin';
import { AlarmConfigModule } from './alarm-config';
import { AlarmsModule } from './alarms';
import { AuthModule } from './auth';
import { CabinetsModule } from './cabinets';
import { CommandsModule } from './commands';
import { DimmingModule } from './dimming';
import { ProblemFilter } from './errors';
import { FavoritesModule } from './favorites';
import { GisModule } from './gis';
import { ReportsModule } from './reports';
import { IncidentsModule, MAX_PHOTO_BYTES } from './incidents';
import { InfraModule } from './infra';
import { LogsModule } from './logs';
import { LtidInterceptor } from './ltid';
import { RealtimeModule } from './realtime';
import { SchedulesModule } from './schedules';
import { SystemModule } from './system';
import { UsersModule } from './users';

@Module({
  imports: [InfraModule, AuthModule, CabinetsModule, CommandsModule, FavoritesModule, AlarmsModule, AlarmConfigModule, SchedulesModule, DimmingModule, IncidentsModule, GisModule, ReportsModule, AdminModule, UsersModule, LogsModule, SystemModule, RealtimeModule],
  providers: [{ provide: APP_FILTER, useClass: ProblemFilter }, { provide: APP_INTERCEPTOR, useClass: LtidInterceptor }],
})
class AppModule {}

/** Trust X-Forwarded-For only behind a known proxy (Caddy on the VPS): TRUST_PROXY=true | IP/CIDR list. */
function trustProxy(): boolean | string {
  const v = process.env.TRUST_PROXY;
  if (!v || v === 'false') return false; // otherwise anyone can fake their IP and dodge the login rate limit
  if (v === 'true') return true;
  // fastify >= 5.12 turns a hop count into "trust nobody"; fail loudly instead of silently.
  if (/^\d+$/.test(v)) throw new Error('TRUST_PROXY: hop count is not supported, use the proxy IP/CIDR (e.g. 127.0.0.1)');
  return v;
}

const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ trustProxy: trustProxy(), bodyLimit: 256 * 1024 }), {
  logger: ['error', 'warn', 'log'],
});
await app.register(cookie);
// /map/cabinets for 10k cabinets is ~3.4 MB of JSON, ~10x smaller gzipped. gzip only: brotli at its
// default quality costs far more CPU per request than it saves on top of gzip.
await app.register(compress, { encodings: ['gzip', 'deflate'], threshold: 1024 });
// incident photos (M7): one file per request, checked by magic bytes in IncidentsService
await app.register(multipart, { limits: { fileSize: MAX_PHOTO_BYTES, files: 1, fields: 5, parts: 6 } });
app.setGlobalPrefix('api/v1');
app.useWebSocketAdapter(new IoAdapter(app));
app.enableShutdownHooks();
const port = Number(process.env.API_PORT ?? 3000);
await app.listen(port, process.env.API_HOST ?? '0.0.0.0');
console.log(`[api] listening on :${port} (/api/v1, /socket.io)`);
