import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { validateEnv } from './env.schema';

/**
 * Validates the environment once, at boot, and fails to start on anything missing or
 * inconsistent — including DEMO_MODE being on with NODE_ENV=production, which would accept any
 * password for the seeded accounts.
 */
@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
  ],
})
export class ConfigModule {}
