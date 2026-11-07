// One gate for every JSON response: a new endpoint or column cannot leak an LTID by forgetting a check.
// Files written straight to the reply (xlsx, csv) skip interceptors: the columns with stored text use scrubLtid themselves.
import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { map } from 'rxjs';
import { canSeeLtid, stripLtid } from '@citylight/shared';
import type { AuthedRequest } from './auth';

@Injectable()
export class LtidInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler) {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    return canSeeLtid(req.user?.role) ? next.handle() : next.handle().pipe(map((body) => stripLtid(body)));
  }
}
