import { describe, expect, it } from 'vitest';
import type { BulkImportAuditDiff, BulkSubmitAuditDiff } from '@tonyai/shared-types';
import { actorLabel, summariseBatch } from './audit-view';

const row = (over: Partial<Parameters<typeof actorLabel>[0]> = {}) => ({
  userId: 'user-1' as string | null,
  userFullName: 'Ada Lovelace' as string | null,
  userEmail: 'ada@tonyai.local' as string | null,
  ...over,
});

describe('actorLabel', () => {
  it('names the person when there is one', () => {
    expect(actorLabel(row())).toEqual({ text: 'Ada Lovelace', muted: false });
  });

  it('falls back to the email before giving up on a name', () => {
    expect(actorLabel(row({ userFullName: null }))).toEqual({
      text: 'ada@tonyai.local',
      muted: false,
    });
  });

  it('says "deleted user" only when a person WAS recorded', () => {
    // Identity is joined at read time, so erasing a profile leaves the opaque
    // id behind. That is a person whose account is gone.
    expect(actorLabel(row({ userFullName: null, userEmail: null }))).toEqual({
      text: 'deleted user',
      muted: true,
    });
  });

  it('says "system" when nobody performed the action', () => {
    // A `rescore` row from `pnpm anomaly:recompute`. Rendering this as a
    // deleted user asserts two untrue things on a compliance trail: that
    // someone acted, and that their account was removed afterwards.
    expect(actorLabel(row({ userId: null, userFullName: null, userEmail: null }))).toEqual({
      text: 'system',
      muted: true,
    });
  });

  it('prefers "system" over any stale identity on a null-actor row', () => {
    expect(actorLabel(row({ userId: null })).text).toBe('system');
  });
});

describe('summariseBatch', () => {
  // Typed as the API writes them, so a renamed key on either side fails here
  // instead of rendering as "—" silently.
  const imported: BulkImportAuditDiff = {
    bulk: true,
    dryRun: false,
    fileName: 'q3.csv',
    sizeBytes: 480,
    totalRows: 4,
    acceptedCount: 3,
    rejectedCount: 1,
  };
  const submitted: BulkSubmitAuditDiff = {
    bulk: true,
    requested: 3,
    received: 4,
    submittedCount: 2,
    failedCount: 1,
    recordIds: ['a', 'b'],
  };

  it('reads an apply as counts beside the file name', () => {
    expect(summariseBatch(imported)).toBe('q3.csv · 3 imported · 1 refused');
  });

  it('says a dry run WOULD import, and drops a zero refusal count', () => {
    expect(summariseBatch({ ...imported, dryRun: true, rejectedCount: 0 })).toBe(
      'q3.csv · dry run · 3 would import',
    );
  });

  it('reads a refusal with its reason, for an import and for a submit', () => {
    const importRefused: BulkImportAuditDiff = {
      bulk: true,
      dryRun: true,
      fileName: 'q3.csv',
      sizeBytes: 480,
      refused: true,
      reason: 'Your role may not create activity records',
    };
    expect(summariseBatch(importRefused)).toBe(
      'q3.csv · refused · Your role may not create activity records',
    );
    const submitRefused: BulkSubmitAuditDiff = {
      bulk: true,
      requested: 1,
      received: 1,
      refused: true,
      reason: 'Your role may not submit activity records',
    };
    expect(summariseBatch(submitRefused)).toBe(
      'refused · Your role may not submit activity records',
    );
  });

  it('reads a bulk submit as submitted-of-requested', () => {
    expect(summariseBatch(submitted)).toBe('2 of 3 submitted');
  });

  it('keys on the diff shape, not the verb — a row written before the verbs existed reads the same', () => {
    // Pre-#124 rows sit under `create`/`submit` with this exact diff.
    expect(summariseBatch({ ...imported })).toBe('q3.csv · 3 imported · 1 refused');
    expect(summariseBatch({ bulk: true, requested: 2, received: 2, submittedCount: 2, failedCount: 0, recordIds: [] })).toBe(
      '2 of 2 submitted',
    );
  });

  it('leaves out what a historic row does not carry rather than inventing a 0', () => {
    // The retry that dropped the caller text has no file name.
    expect(summariseBatch({ bulk: true, dryRun: false, sizeBytes: 1, totalRows: 1, acceptedCount: 1, rejectedCount: 0, callerTextOmitted: true })).toBe('1 imported');
    expect(summariseBatch({ bulk: true })).toBeNull();
  });
});
