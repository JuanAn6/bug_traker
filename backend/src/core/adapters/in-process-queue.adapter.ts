import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { JobHandler, QueuePort } from '../ports/queue.port';

/**
 * Phase-1 queue: setInterval plus direct invocation.
 *
 * `enqueue` runs the handler on the next tick rather than truly deferring it, so a job that
 * throws surfaces in the caller's log instead of vanishing. With BullMQ this becomes a real
 * queue with retries; nothing outside core/adapters changes.
 */
@Injectable()
export class InProcessQueueAdapter implements QueuePort, OnModuleDestroy {
  private readonly logger = new Logger(InProcessQueueAdapter.name);
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly handlers = new Map<string, JobHandler>();

  schedule(name: string, intervalMs: number, handler: () => Promise<void>): void {
    const timer = setInterval(() => {
      void handler().catch((e: unknown) => {
        this.logger.error(`job ${name} failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    }, intervalMs);
    // Must not hold the process open: a scheduled job is never a reason to refuse to exit.
    timer.unref();
    this.timers.push(timer);
  }

  register(name: string, handler: JobHandler): void {
    this.handlers.set(name, handler);
  }

  async enqueue(name: string, payload: Record<string, unknown>): Promise<void> {
    const handler = this.handlers.get(name);
    if (!handler) {
      this.logger.warn(`no handler registered for job ${name}`);
      return;
    }
    await handler(payload);
  }

  onModuleDestroy(): void {
    for (const timer of this.timers) clearInterval(timer);
  }
}
