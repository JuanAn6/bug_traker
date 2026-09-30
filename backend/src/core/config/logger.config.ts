import type { Params } from 'nestjs-pino';
import type { Env } from './env.schema';

/**
 * Structured JSON logs.
 *
 * The correlation id itself is set by CorrelationIdInterceptor, not here: under the Fastify
 * adapter `pinoHttp.genReqId` is not the hook in play — Fastify generates its own request id —
 * so setting the response header there silently did nothing.
 */
export function loggerConfig(env: Env): Params {
  const pretty = env.NODE_ENV === 'development';
  return {
    pinoHttp: {
      level: env.LOG_LEVEL,
      customProps: (request) => ({
        // Who did it, when there is a who — attached by JwtAuthGuard — and the id the interceptor
        // put on the request, so every line of a fanned-out request ties back together.
        userId: (request as { authUser?: { id: number } }).authUser?.id,
        correlationId: (request as { correlationId?: string }).correlationId,
      }),
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
          'req.body.password',
          'req.body.currentPassword',
          'req.body.newPassword',
        ],
        remove: true,
      },
      // Health checks would otherwise dominate the log.
      autoLogging: {
        ignore: (request) => request.url === '/api/health' || request.url === '/api/health/ready',
      },
      ...(pretty
        ? {
            transport: {
              target: 'pino-pretty',
              options: { singleLine: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
            },
          }
        : {}),
    },
  };
}
