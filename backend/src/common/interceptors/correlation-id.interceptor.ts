import { randomUUID } from 'node:crypto';
import {
  type CallHandler, type ExecutionContext, Injectable, type NestInterceptor,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Observable } from 'rxjs';

/**
 * Puts a correlation id on the request and echoes it back.
 *
 * Not done through `pinoHttp.genReqId`: under the Fastify adapter that hook is not the one in
 * play — Fastify generates its own request id — so the header was never being set. Doing it here
 * is explicit and works regardless of which logger sits underneath.
 *
 * An incoming `x-request-id` is honoured so a trace survives a proxy hop, and the value is
 * returned to the caller so they can quote it in a bug report.
 */
@Injectable()
export class CorrelationIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest & { correlationId?: string }>();
    const reply = http.getResponse<FastifyReply>();

    const incoming = request.headers['x-request-id'];
    const id = (Array.isArray(incoming) ? incoming[0] : incoming)?.slice(0, 128) || randomUUID();

    request.correlationId = id;
    void reply.header('x-request-id', id);
    return next.handle();
  }
}
