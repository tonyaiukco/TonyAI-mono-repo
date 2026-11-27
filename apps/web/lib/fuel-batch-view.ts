import {
  FUEL_BULK_SUBMIT_MAX,
  fuelBatchCursor,
  FUEL_BATCH_OPEN_STATUSES,
  can,
  mayDecideRecord,
  type BulkSubmitFuelBatchesResultDTO,
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

/** One submission of one batch: a resubmission is another (WP9 PR B review, P1). */
export function reviewKey(batch: Pick<FuelBatchDTO, "id" | "submittedAt">): string {
  return `${batch.id}@${batch.submittedAt ?? ""}`;
}

/**
 * Whether opening this batch from the review queue takes it into review: a
 * submitted batch the viewer decides, at a submission this sheet has not
 * taken already — so a batch returned and resubmitted is taken again, and
 * one reopened at the same submission is not.
 */
export function takesIntoReview(
  batch: Pick<FuelBatchDTO, "id" | "status" | "submittedAt" | "createdBy" | "approver">,
  viewer: Viewer | null | undefined,
  taken: ReadonlySet<string>,
): boolean {
  return batch.status === "submitted" && batchActions(batch, viewer).decide && !taken.has(reviewKey(batch));
}

/**
 * A batch list loaded page by page, per filter (the review queue asks for
 * two statuses at once): each filter's batches so far and its total from
 * `/metadata` (WP9 PR B review, P2 — one upload can form hundreds).
 */
export interface PagedBatches {
  lists: FuelBatchDTO[][];
  totals: number[];
}

/** Each filter's cursor for its next page (its last batch's place), or null once its list is complete. */
export function nextCursors(paged: PagedBatches): Array<string | null> {
  return paged.lists.map((list, i) => (list.length > 0 && list.length < (paged.totals[i] ?? 0) ? fuelBatchCursor(list[list.length - 1]!) : null));
}

export function hasMoreBatches(paged: PagedBatches): boolean {
  return nextCursors(paged).some((cursor) => cursor !== null);
}

/**
 * A filter's next page added: appended, a batch already listed kept once, and
 * a page shorter than a full one ends the list (its total is what is listed),
 * so a batch that left the list meanwhile never leaves "Load more" stuck.
 */
export function withPage(paged: PagedBatches, index: number, page: readonly FuelBatchDTO[], pageSize: number): PagedBatches {
  const lists = paged.lists.map((list, i) => (i === index ? appendPage(list, page) : list));
  const totals = paged.totals.map((total, i) => (i === index && page.length < pageSize ? lists[i]!.length : total));
  return { lists, totals };
}

/** A page appended to a filter's list; a batch already listed (moved between pages) is kept once. */
export function appendPage(list: readonly FuelBatchDTO[], page: readonly FuelBatchDTO[]): FuelBatchDTO[] {
  const seen = new Set(list.map((b) => b.id));
  return [...list, ...page.filter((b) => !seen.has(b.id))];
}

/** How many batches are shown, and of how many. */
export function shownOf(paged: PagedBatches): { shown: number; total: number } {
  return {
    shown: paged.lists.reduce((n, l) => n + l.length, 0),
    total: paged.totals.reduce((n, t) => n + t, 0),
  };
}

/** A part whose answer never came: the server submits batch by batch, so some may have gone. */
export const BULK_OUTCOME_UNKNOWN = "bulk_outcome_unknown";

/**
 * A selection submitted in parts the API takes (`FUEL_BULK_SUBMIT_MAX` each),
 * every part's outcome kept, and the parts after a failed one still sent
 * (WP9 PR B review, P2 — a selection across pages can pass 200). A part that
 * answered with a refusal of the whole request (a 4xx: nothing was submitted)
 * names each batch failed with its code; one whose answer never came (a
 * network failure, a 5xx) is not known to have failed — the server submits
 * each batch in its own step — so its batches are `BULK_OUTCOME_UNKNOWN`,
 * for the screen to read their status again (third review, P2).
 */
export async function submitInParts(
  ids: readonly string[],
  submit: (part: string[]) => Promise<BulkSubmitFuelBatchesResultDTO>,
  codeOf: (error: unknown) => string | null,
  size = FUEL_BULK_SUBMIT_MAX,
): Promise<BulkSubmitFuelBatchesResultDTO> {
  const out: BulkSubmitFuelBatchesResultDTO = { submitted: [], failed: [] };
  for (let i = 0; i < ids.length; i += size) {
    const part = ids.slice(i, i + size);
    try {
      const result = await submit(part);
      out.submitted.push(...result.submitted);
      out.failed.push(...result.failed);
    } catch (error) {
      const code = codeOf(error) ?? BULK_OUTCOME_UNKNOWN;
      out.failed.push(...part.map((batchId) => ({ batchId, code })));
    }
  }
  return out;
}
