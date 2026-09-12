// The decorators need the metadata shim that `main.ts` normally loads.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { PERIOD_VALUE_MAX_LENGTH } from '@tonyai/shared-types';
import { CreatePeriodLockDto } from './create-period-lock.dto';
import { CreateActivityRecordDto } from '../../activity-records/dto/create-activity-record.dto';

/**
 * A lock and a record name the same period with the same raw string — the two
 * are compared verbatim to decide whether a period is closed — so the bound on
 * `periodValue` is kept symmetric across the module edge, which is why this
 * file imports the record's DTO.
 *
 * What actually keeps the two matchable is `canonicalPeriodValue`, run on both
 * write paths before either writes: neither column can hold a string longer
 * than `September` whatever the cap says. The last case here is therefore
 * insurance against DIVERGENCE — one module deciding its own number — not the
 * mechanism. Worth having precisely because the modules are separate: nothing
 * else in the suite compares them.
 */
const VALID_LOCK = {
  subsidiaryId: '22222222-2222-2222-2222-222222220001',
  reportingYear: 2026,
  reportingPeriod: 'monthly',
  periodValue: 'January',
};

const VALID_RECORD = {
  ...VALID_LOCK,
  category: 'Electricity',
  activityValue: 1200,
  activityUnit: 'kWh',
};

function lockErrors(body: Record<string, unknown>) {
  return validateSync(
    plainToInstance(CreatePeriodLockDto, { ...VALID_LOCK, ...body }),
  );
}

function recordErrors(body: Record<string, unknown>) {
  return validateSync(
    plainToInstance(CreateActivityRecordDto, { ...VALID_RECORD, ...body }),
  );
}

describe('CreatePeriodLockDto', () => {
  it('pins the cap to a literal', () => {
    // Deriving every boundary from the constant under test is pinning it to
    // itself — a mutant that raised it to 32,000 kept the whole suite green.
    expect(PERIOD_VALUE_MAX_LENGTH).toBe(32);
  });

  it('accepts a canonical period token', () => {
    for (const periodValue of ['January', 'Q3', 'Annual']) {
      expect(lockErrors({ periodValue })).toHaveLength(0);
    }
  });

  it('refuses a periodValue past the cap', () => {
    expect(
      lockErrors({ periodValue: 'x'.repeat(PERIOD_VALUE_MAX_LENGTH) }),
    ).toHaveLength(0);
    const over = lockErrors({
      periodValue: 'x'.repeat(PERIOD_VALUE_MAX_LENGTH + 1),
    });
    expect(over).toHaveLength(1);
    expect(Object.keys(over[0].constraints ?? {})).toContain('maxLength');
  });

  it('still refuses an empty periodValue', () => {
    const empty = lockErrors({ periodValue: '' });
    expect(Object.keys(empty[0]?.constraints ?? {})).toContain('minLength');
  });

  it('accepts exactly the periodValue lengths an activity record accepts', () => {
    // The load-bearing one. Both sides are driven from the same body, so
    // raising the cap on either class alone flips one of these and fails.
    for (const length of [
      1,
      PERIOD_VALUE_MAX_LENGTH - 1,
      PERIOD_VALUE_MAX_LENGTH,
      PERIOD_VALUE_MAX_LENGTH + 1,
      PERIOD_VALUE_MAX_LENGTH * 4,
    ]) {
      const periodValue = 'x'.repeat(length);
      expect(lockErrors({ periodValue }).length === 0).toBe(
        recordErrors({ periodValue }).length === 0,
      );
    }
  });
});
