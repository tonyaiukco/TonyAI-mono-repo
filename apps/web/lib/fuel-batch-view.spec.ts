import { describe, expect, it } from "vitest";
import type { FuelBatchDTO } from "@/lib/types";
import { batchActions, batchTitle, isRevised, submittableIds } from "./fuel-batch-view";

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
