import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { ApproveActivityRecordDto } from './approve-activity-record.dto';
import { RejectActivityRecordDto } from './reject-activity-record.dto';

const PIPE_OPTIONS = { whitelist: true, forbidNonWhitelisted: true };
const errorsOf = (Dto: typeof ApproveActivityRecordDto | typeof RejectActivityRecordDto, body: Record<string, unknown>) =>
  validateSync(plainToInstance(Dto, body) as object, PIPE_OPTIONS);

describe('seenSubmittedAt — the submission a decision is about (BUG-R2-03 review)', () => {
  it('is optional on approve and reject', () => {
    expect(errorsOf(ApproveActivityRecordDto, {})).toHaveLength(0);
    expect(errorsOf(RejectActivityRecordDto, { varianceReason: 'x' })).toHaveLength(0);
  });

  it('takes an ISO timestamp, or null for a record never submitted', () => {
    expect(errorsOf(ApproveActivityRecordDto, { seenSubmittedAt: '2026-11-10T09:00:00.000Z' })).toHaveLength(0);
    expect(errorsOf(ApproveActivityRecordDto, { seenSubmittedAt: null })).toHaveLength(0);
    expect(errorsOf(RejectActivityRecordDto, { varianceReason: 'x', seenSubmittedAt: '2026-11-10T09:00:00Z' })).toHaveLength(0);
  });

  it.each(['yesterday', '2026-13-40T00:00:00Z', 42])('refuses %s', (value) => {
    expect(errorsOf(ApproveActivityRecordDto, { seenSubmittedAt: value }).length).toBeGreaterThan(0);
  });
});
