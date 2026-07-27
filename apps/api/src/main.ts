import 'reflect-metadata';
// Sentry must initialise before Nest builds the app so its instrumentation can
// patch the runtime. No-op unless SENTRY_DSN is set.
import { initSentry } from './observability/sentry';
initSentry();

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { JsonLogger } from './observability/json-logger';
import { LoggingInterceptor } from './observability/logging.interceptor';
import { HttpExceptionFilter } from './observability/http-exception.filter';

async function bootstrap() {
  const logger = new JsonLogger();
  const app = await NestFactory.create(AppModule, { logger });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  // Structured request logging + error reporting. The filter deliberately keeps
  // Nest's response body shape (the web client reads `body.message`).
  app.useGlobalInterceptors(new LoggingInterceptor(logger));
  app.useGlobalFilters(new HttpExceptionFilter(logger));

  const webOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
  app.enableCors({
    origin: webOrigin.split(','),
    credentials: true,
    // Content-Disposition is not CORS-safelisted — without exposing it, the
    // report downloads' server-chosen filenames never reach the browser.
    // x-request-id lets the client quote an id when reporting a problem.
    exposedHeaders: ['Content-Disposition', 'x-request-id'],
  });

  // Graceful shutdown: lets ReportsService.onModuleDestroy close the shared
  // Chromium instance (otherwise containers leak a zombie browser per restart).
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port);
  logger.event('info', 'api_started', {
    port,
    prefix: '/api/v1',
    sentry: Boolean(process.env.SENTRY_DSN),
  });
}

void bootstrap();
