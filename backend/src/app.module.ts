import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { ConfigService } from '@nestjs/config';
import { ConfigModule } from './core/config/config.module';
import { loggerConfig } from './core/config/logger.config';
import type { Env } from './core/config/env.schema';
import { CoreModule } from './core/core.module';
import { DrizzleModule } from './core/database/drizzle.module';
import { PortsModule } from './core/ports/ports.module';
import { CorrelationIdInterceptor } from './common/interceptors/correlation-id.interceptor';
import { DomainExceptionFilter } from './common/filters/domain-exception.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { ThresholdGuard } from './common/guards/threshold.guard';
import { AdminModule } from './modules/admin/admin.module';
import { AuthModule } from './modules/auth/auth.module';
import { HealthController } from './modules/health/health.controller';
import { CatalogModule } from './modules/catalog/catalog.module';
import { CommentsModule } from './modules/comments/comments.module';
import { IssuesModule } from './modules/issues/issues.module';
import { CustomFieldsModule } from './modules/custom-fields/custom-fields.module';
import { EventsModule } from './modules/events/events.module';
import { HistoryModule } from './modules/history/history.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { SprintsModule } from './modules/sprints/sprints.module';
import { SummaryModule } from './modules/summary/summary.module';
import { UsersModule } from './modules/users/users.module';
import { WorkflowModule } from './modules/workflow/workflow.module';

/**
 * Guard order matters: JwtAuthGuard populates request.authUser, and ThresholdGuard reads it.
 * Nest runs globally registered guards in registration order, so authentication precedes
 * authorization.
 */
@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        loggerConfig({
          NODE_ENV: config.get('NODE_ENV', { infer: true }),
          LOG_LEVEL: config.get('LOG_LEVEL', { infer: true }),
        } as Env),
    }),
    PortsModule, DrizzleModule, CoreModule,
    AuthModule, CatalogModule, CommentsModule, CustomFieldsModule, EventsModule, HistoryModule, IssuesModule,
    NotificationsModule, ProjectsModule, SprintsModule, SummaryModule, UsersModule,
    WorkflowModule, AdminModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: CorrelationIdInterceptor },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: ThresholdGuard },
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
  ],
})
export class AppModule {}
