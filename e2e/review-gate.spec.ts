import { test, expect } from '@playwright/test';
import {
  ADMIN_EMAIL,
  APPROVER_EMAIL,
  SUB,
  approveRecord,
  createCommittedRecord,
  getAccessToken,
  login,
} from './helpers';

/**
 * WP19 — the review gate on the branch that has no invoice denominator.
 *
 * The first E2E over such a cell, and it has to write its own data: the seed
 * hard-codes `approved` on every activity record, so the state this whole
 * package is about — keyed in, sent for review, seen by nobody — does not exist
 * on a fresh database. That is also why the behaviour survived WP17 unnoticed.
 *
 * `TonyAI Mfg` is measured for the whole company rather than per site, so even
 * Natural Gas — an invoice-tracked category — lands on the yes/no branch. That
 * is the shape the decision is really about: the strict rule needs
 * `location` granularity AND an invoice category AND a year, and four of the
 * five seeded subsidiaries fail the first condition. Most of the matrix was
 * turning green on submit, not just the eight non-utility categories.
 *
 * Tuple isolation, per this suite's convention: `Mfg · Natural Gas · Q3` is
 * written by no other spec — `gates.spec` holds Mfg·Electricity,
 * `void-record.spec` holds Mfg·Fuel, and `review-queue.spec` holds Natural Gas
 * on the other three subsidiaries — so there is no 409 on create and no shared
 * anomaly baseline.
 */

const CELL = 'TonyAI Mfg Natural Gas';

test('a cell stays amber until a human accepts the data, and says why', async ({
  page,
  request,
}) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);

  await login(page, ADMIN_EMAIL);

  // Asserted, not assumed. If this pair already held something, the two
  // transitions below would not prove what they claim to.
  await expect(page.getByRole('button', { name: CELL })).toHaveAccessibleName(
    /Missing/,
  );

  // Keyed in and sent for review — the exact act round-1 DE-2 complained about:
  // "On submit for review, the data-collection status turns green immediately."
  const id = await createCommittedRecord(request, token, {
    subsidiaryId: SUB.mfg,
    category: 'Natural Gas',
    periodValue: 'Q3',
    activityValue: 41000,
  });

  await page.reload();
  const submitted = page.getByRole('button', { name: CELL });
  await expect(submitted).toHaveAccessibleName(/Partial/);
  // The unit is part of the claim: this cell has no invoice denominator, so
  // "1 awaiting review" beside a fraction counted in invoices would be read as
  // one of those.
  await expect(submitted).toHaveAccessibleName(/1 entry awaiting review/);

  // And the reason is on screen, not only in the accessible name. This branch
  // has no shortfall counters, so without this sentence the cell would be amber
  // with nothing anywhere accounting for it — the failure WP17's own review
  // caught on the invoice branch.
  await submitted.hover();
  // `.first()` because Radix renders the tooltip body twice — the visible
  // popper and an off-screen mirror it points `aria-describedby` at — so an
  // unscoped text locator is a strict-mode violation rather than a real
  // ambiguity. Asserting through the tooltip role keeps the claim ("this
  // sentence is IN the tooltip") rather than just "it exists on the page".
  await expect(page.getByRole('tooltip').first()).toContainText(
    '1 entry is keyed in but nobody has reviewed it yet',
  );

  // Accepting it is what finishes the category — by the other super_admin,
  // since nobody approves a record they created (D01).
  await approveRecord(request, await getAccessToken(request, APPROVER_EMAIL), id);

  await page.reload();
  const approved = page.getByRole('button', { name: CELL });
  await expect(approved).toHaveAccessibleName(/Complete/);
  await expect(approved).not.toHaveAccessibleName(/awaiting review/);
});
