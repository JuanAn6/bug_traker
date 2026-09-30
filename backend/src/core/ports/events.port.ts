export const EVENTS_PORT = Symbol('EVENTS_PORT');

/** Domain events, published only AFTER the transaction that produced them commits. */
export interface DomainEvent {
  topic: string;
  payload: Record<string, unknown>;
}

export type EventHandler = (payload: Record<string, unknown>) => void | Promise<void>;

/**
 * Delivery is at-least-once: the dispatcher claims outbox rows with a conditional UPDATE and
 * a crash between the claim and the publish replays the row. Subscribers must be idempotent.
 */
export interface EventsPort {
  publish(topic: string, payload: Record<string, unknown>): Promise<void>;
  subscribe(topic: string, handler: EventHandler): void;
}
