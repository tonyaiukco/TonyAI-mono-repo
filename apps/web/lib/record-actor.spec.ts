import { describe, it, expect } from 'vitest';
import { recordActorLabel } from './record-actor';

/**
 * The four states an actor column has to keep apart. Two of them are a person
 * with an account, one is a person whose account is gone, and one is nobody at
 * all — and only the last may render as an absence of any actor.
 */
describe('recordActorLabel', () => {
  it('shows the name when there is one', () => {
    expect(recordActorLabel('user-1', 'Entry User')).toEqual({
      text: 'Entry User',
      muted: false,
    });
  });

  it('shows an absence when nobody has acted', () => {
    // A record nobody has reviewed. "deleted user" here would tell a reviewer
    // that someone decided this record and then vanished.
    expect(recordActorLabel(null, null)).toEqual({ text: '—', muted: true });
  });

  it('says "unnamed user" for an account with a blank name, not "deleted user"', () => {
    // `profiles.full_name` is NOT NULL but may be empty. A blank un-muted cell
    // reads as a rendering bug, and "deleted user" would be a lie: this person
    // still has an account.
    expect(recordActorLabel('user-1', '')).toEqual({
      text: 'unnamed user',
      muted: true,
    });
    expect(recordActorLabel('user-1', '   ')).toEqual({
      text: 'unnamed user',
      muted: true,
    });
  });

  it('says "deleted user" only when an actor is known AND resolved to nothing', () => {
    // This is the one case where a person really did act. Identity is joined at
    // read time so erasure removes the name and keeps the row; the id is what
    // separates this from the two absences above.
    expect(recordActorLabel('user-1', null)).toEqual({
      text: 'deleted user',
      muted: true,
    });
  });

  it('never renders the raw id', () => {
    // The whole point: an opaque uuid on screen is what this replaces.
    for (const name of [null, ''] as const) {
      expect(recordActorLabel('8f14e45f-ceea-467a-9f8e-1f1b1e2d3c4a', name).text).not.toContain(
        '8f14e45f',
      );
    }
  });
});
