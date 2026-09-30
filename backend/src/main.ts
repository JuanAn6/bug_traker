import 'reflect-metadata';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { MAX_FILE_SIZE } from './shared/config';
import { AppModule } from './app.module';
import type { Env } from './core/config/env.schema';
import { DrizzleService } from './core/database/drizzle.service';

async function bootstrap(): Promise<void> {
  // Every date-range predicate is built as a UTC instant because the frontend compares
  // toISOString().slice(0,10). A process in another zone would shift every boundary.
  process.env['TZ'] = 'UTC';

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true, bodyLimit: 2 * 1024 * 1024 }),
  );
  const config = app.get(ConfigService<Env, true>);
  const logger = new Logger('bootstrap');

  // Both plugins augment FastifyInstance via declaration merging, which makes their own
  // plugin signatures incompatible with the un-augmented instance type that Nest's register()
  // infers — a known typing limitation of @nestjs/platform-fastify, not a runtime problem.
  // The cast is confined to this helper rather than sprinkled at each call.
  const registerPlugin = async (plugin: unknown, options?: unknown): Promise<void> => {
    await app.register(
      plugin as Parameters<NestFastifyApplication['register']>[0],
      options as Parameters<NestFastifyApplication['register']>[1],
    );
  };

  await registerPlugin(fastifyCookie);
  await registerPlugin(fastifyMultipart, {
    // Enforced during the stream, so an oversized upload is cut off rather than buffered.
    limits: { fileSize: MAX_FILE_SIZE, files: 10 },
  });

  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
        // Without this, class-transformer materializes EVERY declared property as an own key
        // with value undefined — so a PATCH of {priority} would look like a patch of all
        // twenty fields, and the per-field permission whitelist would reject it.
        exposeUnsetFields: false,
      },
    }),
  );

  const origins = config.get('CORS_ORIGINS', { infer: true });
  if (origins.length) {
    // credentials:true is required for the httpOnly refresh cookie to survive `ng serve` on
    // a different port; same-origin behind XAMPP needs none of this.
    app.enableCors({ origin: origins, credentials: true });
  }

  SwaggerModule.setup(
    'api/docs',
    app,
    SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Bug Tracker API')
        .setDescription('Backend for the Angular bug tracker. Contract: the frontend Db model.')
        .setVersion('0.1.0')
        .addBearerAuth()
        .build(),
    ),
  );

  // Verifies the connection plus the two server settings that would produce wrong answers
  // rather than errors: the session timezone and the database collation.
  await app.get(DrizzleService).verify();

  app.enableShutdownHooks();
  const port = config.get('PORT', { infer: true });
  await app.listen(port, '0.0.0.0');
  logger.log(`listening on http://localhost:${port}/api — docs at /api/docs`);
  if (config.get('DEMO_MODE', { infer: true })) {
    logger.warn('DEMO_MODE is ON: seeded accounts accept any password, /admin/import is enabled.');
  }
}

void bootstrap();
