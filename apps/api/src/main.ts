import 'reflect-metadata';
import { initSentry } from './observability/sentry';
import { assertAuthConfig } from './auth/token-verifier';
import { bootFactorPolicy } from './calculations/factor-policy';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { JsonLogger } from './observability/json-logger';
import { configureApp } from './app-setup';

async function bootstrap() {
  // Sentry first, before Nest builds the app — a no-op unless SENTRY_DSN is
  // set (and @sentry/nestjs is only loaded then; see observability/sentry.ts).
  await initSentry();
  // Refuse to start on an auth misconfiguration instead of 401-ing every
  // request with an indistinguishable "invalid token".
  assertAuthConfig();
  // Likewise on a placeholder-factor flag set where it must not be (K3): read
  // once, here, before any module can price a record.
  const factorPolicy = bootFactorPolicy();
  const logger = new JsonLogger();
  const app = await NestFactory.create(AppModule, { logger });
  // Prefix, validation, structured request logging and error reporting; every
  // error body carries a code (LP3-01).
  configureApp(app, logger);

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
  // Stated at every boot, so "placeholders are off here" is a log line an
  // operator can point at rather than an absence of evidence (LP3-03, K3).
  logger.event('info', 'factor_policy', {
    allowPlaceholderFactors: factorPolicy.allowPlaceholders,
    calculatesFrom: factorPolicy.allowPlaceholders
      ? 'authoritative, placeholder and fixture releases'
      : 'authoritative releases only',
  });
}

void bootstrap();
