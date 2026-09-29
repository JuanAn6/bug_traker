import { Global, Module } from '@nestjs/common';
import { MemoryCacheAdapter } from '../adapters/memory-cache.adapter';
import { CACHE_PORT } from './cache.port';

/**
 * Binds the ports to their phase-1 adapters.
 *
 * Swapping any of them — Redis for the cache, S3 for storage, Elasticsearch for search — is a
 * new class in core/adapters plus one line here. Nothing in modules/ names an adapter.
 */
@Global()
@Module({
  providers: [{ provide: CACHE_PORT, useClass: MemoryCacheAdapter }],
  exports: [CACHE_PORT],
})
export class PortsModule {}
