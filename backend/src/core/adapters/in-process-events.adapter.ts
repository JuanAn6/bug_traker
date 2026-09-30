import { Injectable, Logger } from '@nestjs/common';
import type { EventHandler, EventsPort } from '../ports/events.port';

/**
 * Phase-1 events: an in-memory subscriber list.
 *
 * A handler that throws is logged and swallowed. Publishing happens after the commit, so a
 * failing subscriber must not be able to undo a write that already succeeded — and the outbox
 * row is the durable record either way.
 */
@Injectable()
export class InProcessEventsAdapter implements EventsPort {
  private readonly logger = new Logger(InProcessEventsAdapter.name);
  private readonly handlers = new Map<string, EventHandler[]>();

  async publish(topic: string, payload: Record<string, unknown>): Promise<void> {
    // Exact topic plus wildcard prefix ('issue.*' hears 'issue.updated').
    const matched = [
      ...(this.handlers.get(topic) ?? []),
      ...(this.handlers.get(`${topic.split('.')[0]}.*`) ?? []),
    ];
    for (const handler of matched) {
      try {
        await handler(payload);
      } catch (e) {
        this.logger.error(`subscriber for ${topic} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  subscribe(topic: string, handler: EventHandler): void {
    const list = this.handlers.get(topic);
    if (list) list.push(handler);
    else this.handlers.set(topic, [handler]);
  }
}
