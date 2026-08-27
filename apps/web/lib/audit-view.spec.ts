import { describe, expect, it } from 'vitest';
import { actorLabel } from './audit-view';

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
