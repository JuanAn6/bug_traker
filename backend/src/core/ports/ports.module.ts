import { Global, Module } from '@nestjs/common';
import { InProcessEventsAdapter } from '../adapters/in-process-events.adapter';
import { InProcessQueueAdapter } from '../adapters/in-process-queue.adapter';
import { MemoryCacheAdapter } from '../adapters/memory-cache.adapter';
import { OutboxDispatcher } from '../adapters/outbox-dispatcher.service';
import { UnitOfWork } from '../database/unit-of-work';
import { CACHE_PORT } from './cache.port';
import { EVENTS_PORT } from './events.port';
import { QUEUE_PORT } from './queue.port';

/**
 * Binds the ports to their phase-1 adapters.
 *
 * Swapping any of them — Redis for the cache, S3 for storage, Elasticsearch for search,
 * BullMQ for the queue — is a new class in core/adapters plus one line here. Nothing in
 * modules/ names an adapter.
 */
@Global()
@Module({
  providers: [
    { provide: CACHE_PORT, useClass: MemoryCacheAdapter },
    { provide: EVENTS_PORT, useClass: InProcessEventsAdapter },
    { provide: QUEUE_PORT, useClass: InProcessQueueAdapter },
    UnitOfWork,
    OutboxDispatcher,
  ],
  exports: [CACHE_PORT, EVENTS_PORT, QUEUE_PORT, UnitOfWork],
})
export class PortsModule {}
