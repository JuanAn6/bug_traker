export const QUEUE_PORT = Symbol('QUEUE_PORT');

export type JobHandler = (payload: Record<string, unknown>) => Promise<void>;

/**
 * Background work. The phase-1 adapter runs jobs in the same process on a timer; a BullMQ
 * adapter over Redis is a drop-in replacement, which is the whole reason this is a port.
 */
export interface QueuePort {
  /** Registers a recurring job. `intervalMs` rather than cron: nothing here needs a calendar. */
  schedule(name: string, intervalMs: number, handler: () => Promise<void>): void;
  enqueue(name: string, payload: Record<string, unknown>): Promise<void>;
  register(name: string, handler: JobHandler): void;
}
