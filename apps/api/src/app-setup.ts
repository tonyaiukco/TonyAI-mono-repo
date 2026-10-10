import type { INestApplication } from '@nestjs/common';
import { CodedValidationPipe, GLOBAL_VALIDATION_OPTIONS } from './common/coded-validation.pipe';
import { HttpExceptionFilter } from './observability/http-exception.filter';
import type { JsonLogger } from './observability/json-logger';
import { LoggingInterceptor } from './observability/logging.interceptor';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { RuntimeLimits } from './common/runtime-limits';
import { configureRuntimeHttp } from './common/runtime-http';

/**
 * Everything that decides what a request and its error look like: the
 * prefix, the validating pipe and the exception filter (LP3-01's error
 * bodies). `main.ts` and the integration suite both call it, so the bodies
 * `tenant-isolation.int.spec.ts` compares are the ones the deployed API sends.
 */
export function configureApp(
  app: INestApplication,
  logger: JsonLogger,
  options: { requestLogging?: boolean; runtimeLimits?: RuntimeLimits } = {},
): void {
  app.enableCors({
    origin: (process.env.WEB_ORIGIN ?? 'http://localhost:3000').split(','),
    credentials: true,
    exposedHeaders: ['Content-Disposition', 'x-request-id', 'Retry-After'],
  });
  configureRuntimeHttp(app as NestExpressApplication, options.runtimeLimits ?? new RuntimeLimits());
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new CodedValidationPipe(GLOBAL_VALIDATION_OPTIONS));
  if (options.requestLogging ?? true) app.useGlobalInterceptors(new LoggingInterceptor(logger));
  app.useGlobalFilters(new HttpExceptionFilter(logger));
}
