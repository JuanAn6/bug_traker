import { Controller, Get, Req, Res } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { EVENTS_PORT, type EventsPort } from '../../core/ports/events.port';
import type { AuthUser } from '../auth/auth.types';

/** Every 25s: under the 30s most proxies use before closing an idle connection. */
const HEARTBEAT_MS = 25_000;

/**
 * Server-sent events.
 *
 * SSE rather than WebSockets because everything here is one-directional — "this issue changed",
 * "you were assigned something" — and SSE needs no protocol upgrade, no library on either side,
 * and reconnects on its own. The frontend has no client for this yet; the endpoint exists so the
 * events already produced by the outbox have somewhere to go.
 *
 * Scaling past one instance means giving EventsPort a Redis backing, not changing this.
 */
@Controller('events')
export class EventsController {
  constructor(@Inject(EVENTS_PORT) private readonly events: EventsPort) {}

  @Get()
  stream(
    @CurrentUser() user: AuthUser,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): void {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Nginx buffers responses by default, which would hold every event until the buffer fills.
      'x-accel-buffering': 'no',
    });

    const send = (event: string, data: unknown): void => {
      if (reply.raw.writableEnded) return;
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send('ready', { userId: user.id, at: new Date().toISOString() });

    const forward = (topic: string) => (payload: Record<string, unknown>) => {
      // A client only hears about what it is entitled to. `userId` on the payload means the event
      // is addressed to one person; anything else is a broadcast about an issue, and the client
      // still has to fetch it — which is where the visibility rules apply.
      if (typeof payload['userId'] === 'number' && payload['userId'] !== user.id) return;
      send(topic, payload);
    };

    for (const topic of ['issue.*', 'note.*', 'sprint.*', 'project.*', 'workflow.changed']) {
      this.events.subscribe(topic, forward(topic));
    }

    // Keeps intermediaries from dropping an idle connection, and lets the client notice a dead
    // one: a comment line is a no-op for EventSource.
    const heartbeat = setInterval(() => {
      if (reply.raw.writableEnded) return;
      reply.raw.write(': ping\n\n');
    }, HEARTBEAT_MS);
    heartbeat.unref();

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      reply.raw.end();
    });
  }
}
