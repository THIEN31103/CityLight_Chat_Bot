// Maps every thrown error to an RFC 9457 problem response.
import { ArgumentsHost, Catch, HttpException, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { canSeeLtid, stripLtid } from '@citylight/shared';
import { ZodError } from 'zod';
import type { AuthedRequest } from './auth';
import { problem } from './infra';

export class ApiError extends HttpException {
  constructor(status: number, public readonly code: string, detail: string, params?: Record<string, string | number>) {
    super(problem(status, code, detail, params), status);
  }
}

@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(err: unknown, host: ArgumentsHost) {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const seesLtid = canSeeLtid(host.switchToHttp().getRequest<AuthedRequest>().user?.role);
    if (err instanceof ZodError) {
      const detail = err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
      return reply.status(422).type('application/problem+json').send(problem(422, 'invalid_request', detail));
    }
    if (err instanceof HttpException) {
      const status = err.getStatus();
      const body = err.getResponse();
      // Unknown route ("Cannot GET /api/v1/x") gets its own code so the web's hybrid mode can fall back to mock data.
      const unknownRoute = status === 404 && err.message.startsWith('Cannot ');
      const p =
        typeof body === 'object' && body && 'code' in body
          ? body
          : problem(status, unknownRoute ? 'route_not_found' : status === 404 ? 'not_found' : 'error', err.message);
      return reply.status(status).type('application/problem+json').send(seesLtid ? p : stripLtid(p));
    }
    console.error('[api] unhandled', err);
    return reply.status(500).type('application/problem+json').send(problem(500, 'internal_error', 'Lỗi máy chủ'));
  }
}
