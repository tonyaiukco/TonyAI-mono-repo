import { installRuntimeShutdown } from './common/runtime-shutdown';
import 'reflect-metadata';
import { initSentry } from './observability/sentry';
import { assertAuthConfig } from './auth/token-verifier';
import { bootFactorPolicy } from './calculations/factor-policy';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { JsonLogger } from './observability/json-logger';
import { configureApp } from './app-setup';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configurePool, readRuntimeConfig } from './common/runtime-config';
import { RuntimeLimits } from './common/runtime-limits';

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
  const runtime = readRuntimeConfig();
  configurePool(runtime);
  const logger = new JsonLogger();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger });
  // Prefix, validation, structured request logging and error reporting; every
  // error body carries a code (LP3-01).
  configureApp(app, logger, { runtimeLimits: app.get(RuntimeLimits) });

  installRuntimeShutdown(app, app.get(RuntimeLimits));

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
