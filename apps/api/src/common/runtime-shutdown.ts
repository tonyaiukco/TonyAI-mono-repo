import type { INestApplication } from '@nestjs/common';
import type { RuntimeLimits } from './runtime-limits';

/** Nest destroys providers before closing HTTP, so drain before app.close(). */
export const installRuntimeShutdown = (
  app: Pick<INestApplication, 'close'>, limits: RuntimeLimits,
  signals: Pick<NodeJS.Process, 'once' | 'off'> = process,
): void => {
  const shutdown = async () => {
    signals.off('SIGTERM', shutdown); signals.off('SIGINT', shutdown);
    await limits.settle();
    await app.close();
  };
  signals.once('SIGTERM', shutdown);
  signals.once('SIGINT', shutdown);
};
