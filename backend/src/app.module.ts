import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ConfigModule } from './core/config/config.module';
import { CoreModule } from './core/core.module';
import { DrizzleModule } from './core/database/drizzle.module';
import { PortsModule } from './core/ports/ports.module';
import { DomainExceptionFilter } from './common/filters/domain-exception.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { ThresholdGuard } from './common/guards/threshold.guard';
import { AuthModule } from './modules/auth/auth.module';
import { HealthController } from './modules/health/health.controller';
import { CatalogModule } from './modules/catalog/catalog.module';
import { IssuesModule } from './modules/issues/issues.module';
import { WorkflowModule } from './modules/workflow/workflow.module';

/**
 * Guard order matters: JwtAuthGuard populates request.authUser, and ThresholdGuard reads it.
 * Nest runs globally registered guards in registration order, so authentication precedes
 * authorization.
 */
@Module({
  imports: [ConfigModule, PortsModule, DrizzleModule, CoreModule, AuthModule, CatalogModule, IssuesModule, WorkflowModule],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: ThresholdGuard },
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
  ],
})
export class AppModule {}
