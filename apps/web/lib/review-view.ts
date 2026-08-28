/**
 * How long a record has been sitting, in whole days — the number the review
 * queue puts in front of a reviewer.
 *
 * Extracted out of `app/review/page.tsx` because it was a page-private
 * function and `vitest.config.ts` only collects `lib/**`, so this arithmetic
 * had no coverage in either direction: nothing would have caught it being
 * wrong, and nothing would catch it changing.
 *
 * The instant is a parameter rather than a field read off a record. The queue
 * feeds it `submittedAt` — the column is "Waiting" now, and means it. It used
 * to feed `createdAt` and be headed "Age", because nothing recorded when a
 * record was submitted; that changed with the `submitted_at` column, and the
 * caller moved rather than this function.
 *
 * Accepts null, because `submittedAt` is null on every record that was never
 * submitted — which on a freshly seeded database is all of them. The one thing
 * this must NOT do is fall back to `createdAt`: that fallback is precisely the
 * misstatement the new column exists to end, and it would be invisible.
 *
 * `now` is injectable so the arithmetic can be pinned at a fixed instant
 * instead of racing the wall clock.
 */
export function daysSince(
  iso: string | null,
  now: number = Date.now(),
): number | null {
  if (iso === null) return null;
  const then = new Date(iso).getTime();
  // `Math.max(0, NaN)` is `NaN`, so an unparseable instant used to render as
  // "NaNd" in the queue. The API contract makes that unreachable — `createdAt`
  // is a serialised Prisma `DateTime` — but a total function costs one line
  // and the alternative is a defect that only ever shows up in production.
  if (Number.isNaN(then)) return null;
  // Floored, not rounded: a record entered 47 hours ago has been waiting one
  // whole day, not two. Clamped at 0 because a client clock running behind the
  // server would otherwise report a record as negative days old.
  return Math.max(0, Math.floor((now - then) / 86_400_000));
}

/**
 * The waiting cell exactly as the review queue renders it.
 *
 * The rendered string lives here rather than in the page for the same reason
 * the arithmetic does: a formatter inside a component is a formatter no test
 * can hold to account, and this one has to decide what an unknown wait looks
 * like. An em dash, not "0d" — claiming a record arrived today when nobody
 * knows when it arrived is the one wrong answer a reviewer would act on, and
 * it is the answer every seeded record would get.
 */
export function waitingLabel(iso: string | null, now: number = Date.now()): string {
  const days = daysSince(iso, now);
  return days === null ? '—' : `${days}d`;
}
