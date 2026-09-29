import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { DB_OPTIONS, DRIZZLE, DrizzleService, type DbOptions } from './drizzle.service';

/**
 * Global so repositories can inject DRIZZLE without re-importing the module everywhere.
 * The raw `db` handle is exposed alongside the service because repositories want the
 * former and only bootstrap wants the latter.
 */
@Global()
@Module({
  providers: [
    {
      provide: DB_OPTIONS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): DbOptions => ({
        url: config.get('DATABASE_URL', { infer: true }),
        poolSize: config.get('DB_POOL_SIZE', { infer: true }),
      }),
    },
    DrizzleService,
    {
      provide: DRIZZLE,
      inject: [DrizzleService],
      useFactory: (service: DrizzleService) => service.db,
    },
  ],
  exports: [DRIZZLE, DrizzleService],
})
export class DrizzleModule {}
