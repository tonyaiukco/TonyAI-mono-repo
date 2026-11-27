import {
  FUEL_BATCH_OPEN_STATUSES,
  can,
  mayDecideRecord,
  type FuelBatchDTO,
  type FuelBatchStatus,
} from "@/lib/types";

/**
 * A fuel batch's actions as the screens offer them (inc28-fuel-bulk D9, D11,
 * D13, D16). The batch is decided as one record of its author and owning
 * company is, so the review side reads the record rule (`mayDecideRecord`)
 * with the batch's approver. The server decides every step again.
 */

export interface Viewer {
  id: string;
  role: string;
}

const isOpen = (status: FuelBatchStatus) => (FUEL_BATCH_OPEN_STATUSES as readonly string[]).includes(status);

export interface BatchActions {
  submit: boolean;
  recall: boolean;
  declarations: boolean;
  files: boolean;
  withdraw: boolean;
  /** Take into review, approve, return. */
  decide: boolean;
}

export function batchActions(batch: Pick<FuelBatchDTO, "status" | "createdBy" | "approver">, viewer: Viewer | null | undefined): BatchActions {
  if (!viewer) return { submit: false, recall: false, declarations: false, files: false, withdraw: false, decide: false };
  const author = batch.createdBy === viewer.id;
  const open = isOpen(batch.status);
  return {
    submit: author && open,
    // Only a submitted batch nobody has opened; review closes recall (D9).
    recall: author && batch.status === "submitted",
    declarations: author && open,
    files: author && open,
    // The author, or a masterkey (C14): the batch and its records leave the inventory; its rows stay readable.
    withdraw: open && (author || can(viewer.role, "fuel_rows.take_over")),
    decide:
      (batch.status === "submitted" || batch.status === "under_review") &&
      can(viewer.role, "record.decide") &&
      mayDecideRecord(viewer, batch, batch.approver),
  };
}

/** The batches of a selection that a bulk submit would send: the viewer's own open ones. */
export function submittableIds(batches: readonly FuelBatchDTO[], selected: ReadonlySet<string>, viewer: Viewer | null | undefined): string[] {
  return batches.filter((b) => selected.has(b.id) && batchActions(b, viewer).submit).map((b) => b.id);
}

/** "Revised": a pending batch submitted more than once (as a record's mark). */
export function isRevised(batch: Pick<FuelBatchDTO, "status" | "submissionCount">): boolean {
  return (batch.status === "submitted" || batch.status === "under_review") && batch.submissionCount >= 2;
}

/** A batch's title: the invoice and, for a further batch of it, its sequence. */
export function batchTitle(batch: Pick<FuelBatchDTO, "invoiceRef" | "sequence">): string {
  return batch.sequence > 1 ? `${batch.invoiceRef} · #${batch.sequence}` : batch.invoiceRef;
}
