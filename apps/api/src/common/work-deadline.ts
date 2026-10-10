import { performance } from 'node:perf_hooks';
import { AsyncLocalStorage } from 'node:async_hooks';
import { BadRequestException } from '@nestjs/common';
import { readRuntimeConfig } from './runtime-config';

export class WorkDeadline {
  private readonly end: number;
  constructor(durationMs: number, private readonly now = () => performance.now()) {
    this.end = now() + durationMs;
  }
  get expired(): boolean { return this.now() >= this.end; }
}

const parserScope = new AsyncLocalStorage<WorkDeadline>();
export const withParserDeadline = <T>(work: () => T): T =>
  parserScope.run(new WorkDeadline(readRuntimeConfig().IMPORT_PARSE_TIMEOUT_MS), work);
export const checkParserDeadline = (): void => {
  if (parserScope.getStore()?.expired) throw new BadRequestException('File parsing exceeded its time budget.');
};
