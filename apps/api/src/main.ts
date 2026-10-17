import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { IoAdapter } from '@nestjs/platform-socket.io';
import cookie from '@fastify/cookie';
import { AlarmsModule } from './alarms';
import { AuthModule } from './auth';
import { CabinetsModule } from './cabinets';
import { ProblemFilter } from './errors';
import { InfraModule } from './infra';
import { RealtimeModule } from './realtime';
import { SystemModule } from './system';
import { UsersModule } from './users';

@Module({
  imports: [InfraModule, AuthModule, CabinetsModule, AlarmsModule, UsersModule, SystemModule, RealtimeModule],
  providers: [{ provide: APP_FILTER, useClass: ProblemFilter }],
})
class AppModule {}

/** Trust X-Forwarded-For only behind a known proxy (Caddy on the VPS): TRUST_PROXY=true | IP/CIDR list | hop count. */
function trustProxy(): boolean | string | number {
  const v = process.env.TRUST_PROXY;
  if (!v || v === 'false') return false; // otherwise anyone can fake their IP and dodge the login rate limit
  if (v === 'true') return true;
  return /^\d+$/.test(v) ? Number(v) : v;
}

const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ trustProxy: trustProxy(), bodyLimit: 256 * 1024 }), {
  logger: ['error', 'warn', 'log'],
});
await app.register(cookie);
app.setGlobalPrefix('api/v1');
app.useWebSocketAdapter(new IoAdapter(app));
app.enableShutdownHooks();
const port = Number(process.env.API_PORT ?? 3000);
await app.listen(port, process.env.API_HOST ?? '0.0.0.0');
console.log(`[api] listening on :${port} (/api/v1, /socket.io)`);
