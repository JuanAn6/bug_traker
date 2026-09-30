import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { UnitOfWork } from '../database/unit-of-work';
import { EVENTS_PORT, type EventsPort } from '../ports/events.port';
import { QUEUE_PORT, type QueuePort } from '../ports/queue.port';

const POLL_MS = 250;
const BATCH = 100;
const PRUNE_MS = 3_600_000;

/**
 * Drains the outbox and publishes each row through EventsPort.
 *
 * Polling rather than pushing on purpose: the producer is a transaction that has not committed
 * yet when it writes the row, so it has nothing meaningful to signal. 250 ms is well under any
 * human-visible latency and the query is an indexed lookup on a table that is normally empty.
 */
@Injectable()
export class OutboxDispatcher implements OnApplicationBootstrap {
  private readonly logger = new Logger(OutboxDispatcher.name);
  private running = false;

  constructor(
    private readonly uow: UnitOfWork,
    @Inject(EVENTS_PORT) private readonly events: EventsPort,
    @Inject(QUEUE_PORT) private readonly queue: QueuePort,
  ) {}

  onApplicationBootstrap(): void {
    this.queue.schedule('outbox.drain', POLL_MS, () => this.drain());
    this.queue.schedule('outbox.prune', PRUNE_MS, () => this.uow.pruneOutbox());
  }

  async drain(): Promise<void> {
    // A slow batch must not have a second drain running over it.
    if (this.running) return;
    this.running = true;
    try {
      const rows = await this.uow.claimOutbox(BATCH);
      for (const row of rows) {
        try {
          await this.events.publish(row.topic, JSON.parse(row.payload) as Record<string, unknown>);
        } catch (e) {
          // The row is already marked dispatched, so a publish failure is logged rather than
          // retried: delivery is at-least-once, not exactly-once, and subscribers are
          // idempotent. Losing an in-process notification is not worth a redelivery storm.
          this.logger.error(
            `publishing ${row.topic} failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    } catch (e) {
      this.logger.error(`outbox drain failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.running = false;
    }
  }
}
