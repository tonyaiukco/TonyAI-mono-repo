import { describe, expect, it } from "vitest";
import type { FuelBatchDTO } from "@/lib/types";
import { appendPage, batchActions, batchTitle, hasMoreBatches, isRevised, nextCursors, reviewKey, shownOf, submittableIds, takesIntoReview, withPage } from "./fuel-batch-view";

const AUTHOR = { id: "u-author", role: "standard_user" };
const MASTERKEY = { id: "u-mk", role: "masterkey" };
const SUPER = { id: "u-sa", role: "super_admin" };
const AUDITOR = { id: "u-aud", role: "auditor" };

const batch = (over: Partial<FuelBatchDTO> = {}) =>
  ({ id: "b1", status: "draft", createdBy: AUTHOR.id, approver: null, submissionCount: 0, invoiceRef: "OZK-1", sequence: 1, ...over }) as FuelBatchDTO;

describe("which action each status and role is offered", () => {
  it.each([
    ["draft", { submit: true, recall: false, declarations: true, files: true, withdraw: true }],
    ["rejected", { submit: true, recall: false, declarations: true, files: true, withdraw: true }],
    ["submitted", { submit: false, recall: true, declarations: false, files: false, withdraw: false }],
    ["under_review", { submit: false, recall: false, declarations: false, files: false, withdraw: false }],
    ["approved", { submit: false, recall: false, declarations: false, files: false, withdraw: false }],
    ["withdrawn", { submit: false, recall: false, declarations: false, files: false, withdraw: false }],
  ] as const)("the author of a %s batch", (status, expected) => {
    expect(batchActions(batch({ status }), AUTHOR)).toMatchObject({ ...expected, decide: false });
  });

  it("lets a masterkey who is not the author withdraw an open batch, and nothing else of the author's", () => {
    expect(batchActions(batch(), MASTERKEY)).toEqual({ submit: false, recall: false, declarations: false, files: false, withdraw: true, decide: false });
    expect(batchActions(batch(), SUPER).withdraw).toBe(false);
  });

  it("offers the decision to the batch's approver only, never to its author or an auditor", () => {
    const pending = batch({ status: "submitted", approver: "super_admin" });
    expect(batchActions(pending, SUPER).decide).toBe(true);
    expect(batchActions(pending, MASTERKEY).decide).toBe(false);
    expect(batchActions(pending, AUDITOR).decide).toBe(false);
    expect(batchActions(batch({ status: "under_review", approver: "masterkey" }), MASTERKEY).decide).toBe(true);
    // A masterkey's own batch: decided by its author (a self-approval).
    const own = batch({ status: "submitted", createdBy: MASTERKEY.id, approver: "author" });
    expect(batchActions(own, MASTERKEY).decide).toBe(true);
    expect(batchActions(batch({ status: "approved", approver: null }), SUPER).decide).toBe(false);
  });

  it("offers nothing to no viewer", () => {
    expect(Object.values(batchActions(batch(), null)).some(Boolean)).toBe(false);
  });
});

describe("the Batches tab's selection and marks", () => {
  it("bulk-submits only the viewer's own open batches of the selection", () => {
    const list = [batch({ id: "a" }), batch({ id: "b", status: "submitted" }), batch({ id: "c", createdBy: "other" }), batch({ id: "d", status: "rejected" })];
    expect(submittableIds(list, new Set(["a", "b", "c", "d"]), AUTHOR)).toEqual(["a", "d"]);
    expect(submittableIds(list, new Set(["b"]), AUTHOR)).toEqual([]);
  });

  it("marks a resubmitted pending batch as revised", () => {
    expect(isRevised(batch({ status: "submitted", submissionCount: 2 }))).toBe(true);
    expect(isRevised(batch({ status: "submitted", submissionCount: 1 }))).toBe(false);
    expect(isRevised(batch({ status: "approved", submissionCount: 3 }))).toBe(false);
  });

  it("names a further batch of an invoice by its sequence", () => {
    expect(batchTitle(batch())).toBe("OZK-1");
    expect(batchTitle(batch({ sequence: 2 }))).toBe("OZK-1 · #2");
  });
});

describe("taking a batch into review from the queue (WP9 PR B review, P1)", () => {
  const first = "2026-11-20T10:00:00.000Z";
  const second = "2026-11-21T09:00:00.000Z";
  const pending = (over: Partial<FuelBatchDTO> = {}) => batch({ status: "submitted", approver: "super_admin", submittedAt: first, ...over });

  it("keys a submission by batch and submission time", () => {
    expect(reviewKey(pending())).not.toBe(reviewKey(pending({ submittedAt: second })));
    expect(reviewKey(pending())).not.toBe(reviewKey(pending({ id: "b2" })));
  });

  it("takes a submission once, and a resubmission of the same batch again", () => {
    const taken = new Set<string>();
    expect(takesIntoReview(pending(), SUPER, taken)).toBe(true);
    taken.add(reviewKey(pending()));
    expect(takesIntoReview(pending(), SUPER, taken)).toBe(false);
    // Returned, resubmitted: a new submission is taken although no other batch was opened between.
    expect(takesIntoReview(pending({ submittedAt: second }), SUPER, taken)).toBe(true);
  });

  it("never takes a batch the viewer does not decide, or one not submitted", () => {
    expect(takesIntoReview(pending(), AUDITOR, new Set())).toBe(false);
    expect(takesIntoReview(pending(), AUTHOR, new Set())).toBe(false);
    expect(takesIntoReview(pending({ status: "under_review" }), SUPER, new Set())).toBe(false);
  });
});

describe("a batch list past one page (WP9 PR B review, P2)", () => {
  const many = (n: number, from = 0) => Array.from({ length: n }, (_, i) => batch({ id: `b${from + i}` }));

  it("asks each filter for its next page until its total is listed", () => {
    const paged = { lists: [many(200), many(40, 500)], totals: [560, 40] };
    // The cursor is the last batch shown, so a batch leaving an earlier page never shifts the next one.
    expect(nextCursors(paged)).toEqual(["b199", null]);
    expect(hasMoreBatches(paged)).toBe(true);
    expect(shownOf(paged)).toEqual({ shown: 240, total: 600 });
    expect(hasMoreBatches({ lists: [many(560)], totals: [560] })).toBe(false);
  });

  it("appends a page, keeping a batch already listed once", () => {
    const list = appendPage(many(3), [batch({ id: "b2" }), batch({ id: "b3" })]);
    expect(list.map((b) => b.id)).toEqual(["b0", "b1", "b2", "b3"]);
  });
});

describe("a short page ends the list (QA review of the WP9 PR B fixes)", () => {
  const many = (n: number, from = 0) => Array.from({ length: n }, (_, i) => batch({ id: `b${from + i}` }));

  it("keeps offering pages while full ones come back, and stops at a short one even below the stale total", () => {
    let paged = { lists: [many(200)], totals: [401] };
    paged = withPage(paged, 0, many(200, 200), 200);
    expect(hasMoreBatches(paged)).toBe(true);
    // One batch left the list meanwhile: the last page is empty, not the one expected.
    paged = withPage(paged, 0, [], 200);
    expect(paged.totals).toEqual([400]);
    expect(hasMoreBatches(paged)).toBe(false);
  });

  it("adds a page to its own filter only", () => {
    const paged = withPage({ lists: [many(2), many(1, 50)], totals: [2, 5] }, 1, many(2, 51), 200);
    expect(paged.lists.map((l) => l.map((b) => b.id))).toEqual([["b0", "b1"], ["b50", "b51", "b52"]]);
    expect(paged.totals).toEqual([2, 3]);
  });
});
