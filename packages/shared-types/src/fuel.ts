/**
 * Fuel bulk upload (inc28-fuel-bulk, INC-2.8, INC-2.9 §3): the three provider
 * sources, the fuel-name rule, the one fuel × usage → record map, the Shell
 * half-month, the invoice reference a batch is keyed by, the row states and
 * the function that decides them, and the fuel upload's limits. The API, the
 * adapters, the database and the web read these, so a preview, a stored row
 * and a screen agree.
 *
 * No runtime import from `./index`: `index.ts` re-exports this module.
 */
import type { ActivityRecordStatus, Category, RecordApprover } from './index';
import { RECORD_INVOICE_NO_MAX_LENGTH } from './record-references';

// ── Sources ─────────────────────────────────────────────────────────────────

/**
 * The provider files a fuel upload reads (INC-2.8 §1): a Shell fuel-card
 * export, a Petrol Ofisi `SatisListesi`, a tanker deliveries file.
 */
export const FUEL_SOURCES = ['shell', 'petrol_ofisi', 'tanker'] as const;
export type FuelSource = (typeof FUEL_SOURCES)[number];

export function isFuelSource(value: unknown): value is FuelSource {
  return typeof value === 'string' && (FUEL_SOURCES as readonly string[]).includes(value);
}

/** The card sources: one usage per upload, on-road preselected on the screen (C3). */
export const FUEL_CARD_SOURCES = ['shell', 'petrol_ofisi'] as const satisfies readonly FuelSource[];
export type FuelCardSource = (typeof FUEL_CARD_SOURCES)[number];

export function isFuelCardSource(value: unknown): value is FuelCardSource {
  return typeof value === 'string' && (FUEL_CARD_SOURCES as readonly string[]).includes(value);
}

/**
 * What an import (`import_batches.source`) is: the TonyAI template, or one of
 * the fuel sources. Every import of today is `template`; the template import's
 * endpoints list and serve only those (D14).
 */
export const IMPORT_SOURCES = ['template', ...FUEL_SOURCES] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

// ── Fuels and usages ────────────────────────────────────────────────────────

/** The fuels a provider file's rows are recognised as (INC-2.8 §2; LPG and MGO "ileride"). */
export const FILE_FUELS = ['diesel', 'petrol'] as const;
export type FileFuel = (typeof FILE_FUELS)[number];

export function isFileFuel(value: unknown): value is FileFuel {
  return typeof value === 'string' && (FILE_FUELS as readonly string[]).includes(value);
}

/** The fuels the manual entry offers on the Türkiye set (INC-2.8 §8, the v2.4 variants). */
export const MANUAL_FUELS = ['diesel', 'petrol', 'lpg', 'marine_gas_oil'] as const;
export type ManualFuel = (typeof MANUAL_FUELS)[number];

/**
 * The usages a person declares (INC-2.8 §5, §8): on-road and off-road are
 * Mobile Combustion; stationary or generator is the `Fuel` category. A card
 * upload carries one; a tanker delivery and a batch carry one each.
 */
export const FUEL_USAGES = ['on_road', 'off_road', 'stationary'] as const;
export type FuelUsage = (typeof FUEL_USAGES)[number];

export function isFuelUsage(value: unknown): value is FuelUsage {
  return typeof value === 'string' && (FUEL_USAGES as readonly string[]).includes(value);
}

/** The usage the card upload's screen preselects (INC-2.8 §5). Never assumed by the API. */
export const FUEL_CARD_DEFAULT_USAGE: FuelUsage = 'on_road';

/**
 * Marine gas oil's one usage (C15): shown fixed, "Marine (vessel)", never a
 * choice, and never a usage a file or a batch declares.
 */
export const FUEL_MARINE_USAGE = 'marine' as const;
export type FuelEntryUsage = FuelUsage | typeof FUEL_MARINE_USAGE;

const foldFuelName = (raw: string): string =>
  raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ı/g, 'i')
    .toLowerCase();

const DIESEL_MARKERS = ['motorin', 'diesel', 'dizel'] as const;
const PETROL_MARKERS = ['kursunsuz', 'benzin'] as const;

/**
 * The fuel a provider's product name is (INC-2.8 §2): by rule, not by list,
 * whatever the case and the Turkish characters. A name containing MOTORİN,
 * DIESEL or DİZEL is diesel; KURŞUNSUZ or BENZİN petrol. A name matching
 * neither rule, or both, is nothing (B11): its rows wait in the tray and are
 * never guessed.
 */
export function recogniseFuel(raw: string | null | undefined): FileFuel | null {
  if (typeof raw !== 'string') return null;
  const name = foldFuelName(raw);
  const diesel = DIESEL_MARKERS.some((marker) => name.includes(marker));
  const petrol = PETROL_MARKERS.some((marker) => name.includes(marker));
  if (diesel === petrol) return null;
  return diesel ? 'diesel' : 'petrol';
}

/** Where one fuel and usage is recorded, and the units it is priced in (D6). */
export interface FuelRecordTarget {
  category: Extract<Category, 'Mobile Combustion' | 'Fuel'>;
  activityType: string;
  /** The units the pair is priced in, the first the one a new record starts on. No unit is converted. */
  units: readonly string[];
  /** Whether a card or tanker file may produce this pair: files hold litres of diesel and petrol only. */
  fromFiles: boolean;
}

const LITRES = Object.freeze(['litres'] as const);

const target = (
  category: FuelRecordTarget['category'],
  activityType: string,
  units: readonly string[],
  fromFiles: boolean,
): FuelRecordTarget => Object.freeze({ category, activityType, units, fromFiles });

/**
 * D6's table, the one map the API, the form and the adapters read. A pair
 * absent here has no factor and is never offered or estimated: LPG off-road,
 * and marine gas oil with any usage but its fixed one. No stored activity type
 * is renamed.
 */
const FUEL_RECORD_TARGETS: Readonly<Record<ManualFuel, Partial<Record<FuelEntryUsage, FuelRecordTarget>>>> =
  Object.freeze({
    diesel: {
      on_road: target('Mobile Combustion', 'on_road_diesel', LITRES, true),
      off_road: target('Mobile Combustion', 'off_road_diesel', LITRES, true),
      stationary: target('Fuel', 'diesel', LITRES, true),
    },
    petrol: {
      on_road: target('Mobile Combustion', 'on_road_petrol', LITRES, true),
      off_road: target('Mobile Combustion', 'off_road_petrol', LITRES, true),
      stationary: target('Fuel', 'petrol', LITRES, true),
    },
    lpg: {
      on_road: target('Mobile Combustion', 'on_road_lpg', LITRES, false),
      stationary: target('Fuel', 'lpg', Object.freeze(['kg'] as const), false),
    },
    // `MARINE_GAS_OIL_UNITS`, spelled out: no runtime import from `./index` (a spec pins them equal).
    marine_gas_oil: {
      marine: target('Mobile Combustion', 'marine_gas_oil', Object.freeze(['kg', 'tonnes'] as const), false),
    },
  });

const own = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);

/** The pairs of a fuel, or none for a name this build does not know (never an inherited key). */
const pairsOf = (fuel: string): Partial<Record<FuelEntryUsage, FuelRecordTarget>> =>
  own(FUEL_RECORD_TARGETS, fuel) ? FUEL_RECORD_TARGETS[fuel as ManualFuel] : {};

/** The record a fuel and usage become, or null for a pair the library does not price (D6). */
export function fuelRecordTarget(fuel: ManualFuel, usage: FuelEntryUsage): FuelRecordTarget | null {
  const pairs = pairsOf(fuel);
  return own(pairs, usage) ? pairs[usage]! : null;
}

/** The usages offered for a fuel, in D6's order (C15). Marine gas oil answers its one fixed usage. */
export function fuelUsagesFor(fuel: ManualFuel): readonly FuelEntryUsage[] {
  const pairs = pairsOf(fuel);
  return ([...FUEL_USAGES, FUEL_MARINE_USAGE] as const).filter((usage) => own(pairs, usage));
}

// ── Periods and invoices ────────────────────────────────────────────────────

/** A transaction date as the file writes it, with no time-zone shift (D4). */
export interface FuelLocalDate {
  year: number;
  /** 1–12. */
  month: number;
  /** 1–31. */
  day: number;
}

/** Shell's half-month (C2): days 1–15 are the first, 16 to the month's end the second. */
export function shellHalfMonth(day: number): 1 | 2 {
  return day <= 15 ? 1 : 2;
}

/** The longest invoice reference stored: a batch's records carry it as `input.invoice_no` (C17). */
export const FUEL_INVOICE_REF_MAX_LENGTH = RECORD_INVOICE_NO_MAX_LENGTH;

/**
 * A Shell invoice's reference within its account (D1): the half-month of the
 * transaction date, `2025-03-1` or `2025-03-2`. Shell rows carry no invoice
 * number (INC-2.8 §1); Duman invoices each account per half-month (§6).
 */
export function shellInvoiceRef(date: FuelLocalDate): string {
  return `${date.year}-${String(date.month).padStart(2, '0')}-${shellHalfMonth(date.day)}`;
}

const SHELL_INVOICE_REF = /^(\d{4})-(0[1-9]|1[0-2])-([12])$/;

/** The year, month and half of a Shell invoice reference, or null when it is not one. */
export function parseShellInvoiceRef(ref: string): { year: number; month: number; half: 1 | 2 } | null {
  const match = SHELL_INVOICE_REF.exec(ref);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), half: match[3] === '1' ? 1 : 2 };
}

/**
 * A Petrol Ofisi invoice's reference (`Fatura Numarası`) or a tanker
 * delivery's (`EVRAK NO`): the code as written, trimmed (D4). An empty cell
 * and a reference longer than the stored limit both refuse the row, each for
 * its own reason (`fuel_reference_too_long`; the empty cell's code is the
 * adapter's: `fuel_key_missing` for a key, `fuel_cell_missing` otherwise).
 */
export type DocumentInvoiceRef = { ref: string } | { refused: 'empty' | 'too_long' };

export function documentInvoiceRef(raw: string | null | undefined): DocumentInvoiceRef {
  const ref = typeof raw === 'string' ? raw.trim() : '';
  if (ref.length === 0) return { refused: 'empty' };
  if (ref.length > FUEL_INVOICE_REF_MAX_LENGTH) return { refused: 'too_long' };
  return { ref };
}

// ── Row states ──────────────────────────────────────────────────────────────

/**
 * A stored fuel row's state (D8). `assigned` rows are in a batch; `excluded`
 * rows are an associate's, outside Scope 1 and in their invoice's rows only;
 * `withdrawn` rows are kept and count nowhere.
 */
export const FUEL_ROW_STATES = [
  'waiting_account',
  'excluded',
  'waiting_fuel',
  'ready',
  'held',
  'assigned',
  'withdrawn',
] as const;
export type FuelRowState = (typeof FUEL_ROW_STATES)[number];

/** The rows the unmatched tray holds. */
export const FUEL_TRAY_ROW_STATES = ['waiting_account', 'waiting_fuel'] as const satisfies readonly FuelRowState[];

/** The live rows of an invoice: what its stored litres add up (D13). */
export const FUEL_INVOICE_ROW_STATES = ['assigned', 'excluded'] as const satisfies readonly FuelRowState[];

/**
 * What the row's account is mapped to at this moment: no confirmed company
 * (`none`, a proposal included), an associate, or a company that holds
 * records.
 */
export type FuelAccountTarget = 'none' | 'associate' | 'records';

export interface FuelRowStateInput {
  withdrawn: boolean;
  inBatch: boolean;
  account: FuelAccountTarget;
  fuel: FileFuel | null;
  /** The refusal of the row's last formation attempt, or null. */
  holdReason: string | null;
}

/**
 * The one state function (D8), its conditions in this order whatever else is
 * true of the row: withdrawn, in a batch, no confirmed company, an associate
 * (whatever the fuel name), an unrecognised fuel name, a stored hold reason,
 * otherwise ready. A caller that re-states a row after a mapping change
 * passes no hold reason, so a held row becomes ready again.
 */
export function fuelRowState(input: FuelRowStateInput): FuelRowState {
  if (input.withdrawn) return 'withdrawn';
  if (input.inBatch) return 'assigned';
  if (input.account === 'none') return 'waiting_account';
  if (input.account === 'associate') return 'excluded';
  if (input.fuel === null) return 'waiting_fuel';
  if (input.holdReason !== null) return 'held';
  return 'ready';
}

// ── Accounts and batches ────────────────────────────────────────────────────

/** A fuel account's mapping (D1): never seen mapped, proposed by the tool (C4), confirmed by a person. */
export const FUEL_ACCOUNT_STATES = ['unmatched', 'proposed', 'confirmed'] as const;
export type FuelAccountState = (typeof FUEL_ACCOUNT_STATES)[number];

/** A batch's lifecycle (D9): a record's statuses, and `withdrawn` for a draft or returned batch taken back (C14). */
export const FUEL_BATCH_STATUSES = ['draft', 'submitted', 'under_review', 'approved', 'rejected', 'withdrawn'] as const;
export type FuelBatchStatus = (typeof FUEL_BATCH_STATUSES)[number];

/** The statuses in which a batch's author changes it (C9, C14): its rows may join it, its files and declarations change. */
export const FUEL_BATCH_OPEN_STATUSES = ['draft', 'rejected'] as const satisfies readonly FuelBatchStatus[];

// ── Row codes ───────────────────────────────────────────────────────────────

/**
 * Why a file row is refused and never stored (B12, D4): an empty key cell,
 * another cell the column map needs, an invoice or delivery number over the
 * stored limit, a quantity that is not a positive number or Turkish-format
 * text, a transaction date that cannot be read.
 */
export const FUEL_ROW_REFUSAL_CODES = [
  'fuel_key_missing',
  'fuel_cell_missing',
  /** An invoice or delivery number longer than `FUEL_INVOICE_REF_MAX_LENGTH`. */
  'fuel_reference_too_long',
  'fuel_quantity_unreadable',
  'fuel_date_unreadable',
] as const;

/**
 * A row whose key is stored and live, or earlier in the same file (D5); the
 * second when that stored row is in no batch and held by another user, said
 * without naming them.
 */
export const FUEL_ROW_DUPLICATE_CODES = ['fuel_duplicate', 'fuel_duplicate_unbatched'] as const;

/** Why a stored row waits in the unmatched tray (D8 rows 3 and 5). */
export const FUEL_ROW_WAITING_CODES = ['fuel_account_unmatched', 'fuel_name_unmatched'] as const;

/**
 * Why a formation step held a row (D8 row 6), stored in `fuel_rows.hold_reason`:
 * outside the holder's scope (B4), or the record service's own refusal under
 * the bulk import's name. `unexpected` is a refusal the server did not
 * anticipate, as for the template import.
 */
export const FUEL_HOLD_REASONS = [
  'fuel_out_of_scope',
  'period_locked',
  'category_not_granted',
  'single_entry_period_conflict',
  'no_factor',
  'entity_closed_to_data_entry',
  'slot_holds_untyped',
  'unexpected',
] as const;
export type FuelHoldReason = (typeof FUEL_HOLD_REASONS)[number];

export function isFuelHoldReason(value: unknown): value is FuelHoldReason {
  return typeof value === 'string' && (FUEL_HOLD_REASONS as readonly string[]).includes(value);
}

/** Every code a fuel upload or a formation step names a row by; worded under `errors.bulkUploadIssues`. */
export const FUEL_ROW_ISSUE_CODES = [
  ...FUEL_ROW_REFUSAL_CODES,
  ...FUEL_ROW_DUPLICATE_CODES,
  ...FUEL_ROW_WAITING_CODES,
  ...FUEL_HOLD_REASONS,
] as const;
export type FuelRowIssueCode = (typeof FUEL_ROW_ISSUE_CODES)[number];

// ── Limits ──────────────────────────────────────────────────────────────────

/**
 * The fuel upload's limits (C18), confirmed by task 10.4's measurement of a
 * file of the documented scale (44,902 rows, 3.2 MB: read in 2.0 s, stored in
 * 4.5 s, 560 batches formed in one 17.2 s step; `apps/api/src/fuel-files/limits.ts`). The
 * template import keeps its own (`BULK_UPLOAD_MAX_ROWS`, `BULK_UPLOAD_MAX_SIZE_BYTES`).
 */
export const FUEL_UPLOAD_MAX_ROWS = 60_000;
export const FUEL_UPLOAD_MAX_SIZE_BYTES = 32 * 1024 * 1024;
export const FUEL_TANKER_MAX_DELIVERIES = 1_000;

// ── DTOs ────────────────────────────────────────────────────────────────────
//
// Litres travel as decimal text (`"669.38"`), with the precision the file gave
// (the column is an unconstrained `numeric`): a sum of 45,000 rows is never a
// float, and no digit is rounded away. A company the reader may
// not read is never named (D14): its id and name are null, and the outcome
// says "outside your scope".

/** Rows and litres of one group of rows. */
export interface FuelRowCountDTO {
  rows: number;
  litres: string;
}

/** A fuel account as `GET /fuel-accounts` lists it (D7). */
export interface FuelAccountDTO {
  id: string;
  source: FuelSource;
  /** `Müşteri Kodu`, `Filo Kod Adı`, or the tanker file's `AÇIKLAMA`, trimmed, as written. */
  code: string;
  /** Display only (INC-2.8 §3.2). */
  name: string;
  state: FuelAccountState;
  /** The proposed or confirmed company; null when unmatched. */
  subsidiaryId: string | null;
  subsidiaryName: string | null;
  /** Whether that company is an associate (its rows are excluded). */
  subsidiaryIsAssociate: boolean;
  confirmedBy: string | null;
  confirmedByName: string | null;
  confirmedAt: string | null;
  /** The account's live rows by state; `withdrawn` rows are not counted. */
  rows: Record<Exclude<FuelRowState, 'withdrawn'>, FuelRowCountDTO>;
  /** C20: excluded rows of a company that now holds records. */
  holdsExcludedOfControlledCompany: boolean;
  /** Whether the reader may confirm the proposal (C5). */
  canConfirm: boolean;
  createdAt: string;
  updatedAt: string;
}

/** `POST /fuel-accounts` (masterkey): an account mapped by hand before any upload (B7). */
export interface CreateFuelAccountRequest {
  source: FuelSource;
  code: string;
  name: string;
  subsidiaryId: string;
}

/** `POST /fuel-accounts/:id/confirm`: the proposal, or (masterkey) another company. */
export interface ConfirmFuelAccountRequest {
  subsidiaryId: string;
}

/** `PATCH /fuel-accounts/:id` (masterkey): a change of company, or null to withdraw the mapping. */
export interface UpdateFuelAccountRequest {
  subsidiaryId: string | null;
}

/** What a file row was refused, held or kept waiting for, with its file row. */
export interface FuelRowIssueDTO {
  /** The 1-based row of the sheet. */
  row: number;
  code: FuelRowIssueCode;
}

/**
 * What a previewed file's rows of one account would become (D3, D8): enter
 * batches, be excluded (an associate's), wait for an account, wait for a fuel
 * name no rule recognises, or be held as outside the caller's scope.
 */
export const FUEL_PREVIEW_OUTCOMES = ['batches', 'excluded', 'waiting_account', 'waiting_fuel', 'outside_scope'] as const;
export type FuelPreviewOutcome = (typeof FUEL_PREVIEW_OUTCOMES)[number];

/**
 * One account of a previewed file. Its rows can split: 100 L of diesel enter
 * batches while 20 L of an unrecognised product wait in the tray, so each
 * outcome carries its own rows and litres (only outcomes with rows are listed).
 */
export interface FuelPreviewAccountDTO {
  /** Null for an account not stored yet. */
  accountId: string | null;
  code: string;
  name: string;
  /** Named only when the caller may read the company. */
  subsidiaryId: string | null;
  subsidiaryName: string | null;
  /** Whether the company is the tool's proposal rather than a confirmed mapping. */
  proposed: boolean;
  outcomes: Array<FuelRowCountDTO & { outcome: FuelPreviewOutcome }>;
}

/** A tanker delivery of a first read (C3): what it needs before the file is applied. */
export interface FuelTankerDeliveryDTO {
  /** `EVRAK NO`, as written. */
  documentNo: string;
  /** `AÇIKLAMA`, the receiving company's text. */
  receiving: string;
  litres: string;
  row: number;
  needs: 'declaration' | 'refused' | 'stored';
}

/** One delivery's declaration (C3): nothing preselected, every field required. */
export interface FuelTankerDeclaration {
  documentNo: string;
  fuel: FileFuel;
  usage: FuelUsage;
  year: number;
  /** 1–12. */
  month: number;
}

/** `POST /fuel-files/preview`: stores no data (D3). */
export interface FuelFilePreviewDTO {
  source: FuelSource;
  fileName: string;
  fileSize: number;
  /** Lowercase hex SHA-256; the apply names it (`fuel_file_changed`). */
  fileSha256: string;
  /** A card file's declared usage; null for a tanker file. */
  usage: FuelUsage | null;
  rowsRead: number;
  refused: FuelRowIssueDTO[];
  /** Duplicates of a stored row or of an earlier row of the file. */
  duplicates: FuelRowIssueDTO[];
  accounts: FuelPreviewAccountDTO[];
  /** Raw fuel names no rule recognises, per account (its code), with their rows and litres. */
  unrecognisedNames: Array<FuelRowCountDTO & { accountCode: string; rawName: string }>;
  /** A tanker file's deliveries; empty for a card file. */
  deliveries: FuelTankerDeliveryDTO[];
}

/**
 * `POST /fuel-files` multipart fields beside `file` (D3). `declarations` is a
 * JSON array of `FuelTankerDeclaration`, for a tanker file only.
 */
export interface ApplyFuelFileFields {
  source: FuelSource;
  usage?: FuelUsage;
  fileSha256: string;
  declarations?: string;
}

/** An applied fuel upload (an import of a fuel source) and where its rows stand. */
export interface FuelUploadDTO {
  /** The import's id (`import_batches.id`). */
  id: string;
  source: FuelSource;
  fileName: string;
  fileSize: number;
  fileSha256: string;
  uploadedBy: string;
  uploadedByName: string | null;
  createdAt: string;
  /** The import's `total_rows`, `rejected_count`, and the rest that were not stored: `total − accepted − rejected`. */
  rowsRead: number;
  rowsRefused: number;
  rowsDuplicate: number;
  /** The upload's live rows by state (the reader's scope; `withdrawn` apart). */
  rows: Record<FuelRowState, FuelRowCountDTO>;
  /** Ready rows a formation step of the reader can process now (D8). */
  processableRows: number;
  /** Held rows by their reason. */
  held: Array<FuelRowCountDTO & { reason: FuelHoldReason }>;
  /** Whether the reader holds rows of it (forms batches, tries again). */
  readerIsHolder: boolean;
}

/** `POST /fuel-files/:id/form-batches` (D8). The page calls again while `processableRows` > 0. */
export interface FormFuelBatchesRequest {
  /** Make the reader's held rows ready again first. */
  retryHeld?: boolean;
}

export interface FormFuelBatchesResultDTO {
  /** Batches inserted by this step. */
  formedBatches: number;
  /** Open batches whose rows this step joined (C9). */
  joinedBatches: number;
  processableRows: number;
  held: Array<FuelRowCountDTO & { reason: FuelHoldReason }>;
  waiting: Array<FuelRowCountDTO & { reason: (typeof FUEL_ROW_WAITING_CODES)[number] }>;
}

/** `POST /fuel-files/:id/withdraw-rows` (C14): by account or by raw fuel name, with a reason. */
export interface WithdrawFuelRowsRequest {
  accountId?: string;
  rawFuelName?: string;
  reason: string;
}

/**
 * `GET /fuel-files/:id/withdrawable`: the upload's live rows in no batch that
 * the caller may withdraw (`POST /fuel-files/:id/withdraw-rows`) — its own
 * held rows, or a masterkey's any — by account, and by raw fuel name for the
 * rows waiting for one. Excluded rows are among them: an associate's account
 * later made a controlled company is withdrawn and the file uploaded again
 * (C20; WP9 PR B review, P2).
 */
export interface FuelWithdrawableDTO {
  /** `name`: null when some of the rows lie outside what the caller reads (its company not granted). */
  accounts: Array<FuelRowCountDTO & { accountId: string; code: string; name: string | null; excluded: number }>;
  fuelNames: Array<FuelRowCountDTO & { rawName: string }>;
}

/** `POST /fuel-files/:id/take-over` (masterkey, C8): optionally one account's rows only. */
export interface TakeOverFuelRowsRequest {
  accountId?: string;
}

/** `GET /fuel-files/tray`: the rows waiting for an account or a fuel name, in the reader's scope. */
export interface FuelTrayDTO {
  accounts: Array<
    FuelRowCountDTO & {
      accountId: string;
      source: FuelSource;
      code: string;
      name: string;
      /** The tool's proposal, named only when the reader may read it. */
      proposedSubsidiaryId: string | null;
      proposedSubsidiaryName: string | null;
      canConfirm: boolean;
    }
  >;
  fuelNames: Array<FuelRowCountDTO & { source: FuelSource; rawName: string; accountId: string; accountCode: string }>;
}

/** A batch as the lists and its sheet read it (D10). */
export interface FuelBatchDTO {
  id: string;
  source: FuelSource;
  subsidiaryId: string;
  subsidiaryName: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  /** `Fatura Numarası`, the Shell half-month (`2025-03-1`) or `EVRAK NO`. */
  invoiceRef: string;
  /** 1 for an invoice's first batch; a further batch of it counts on (C9). */
  sequence: number;
  /** Whether the invoice has another live batch (C9, "this invoice has other batches"). */
  hasSiblings: boolean;
  usage: FuelUsage;
  category: Extract<Category, 'Mobile Combustion' | 'Fuel'>;
  status: FuelBatchStatus;
  /** The holder who formed it: its records' author (C8). */
  createdBy: string;
  createdByName: string | null;
  /** The uploaders of the imports its rows came from (C8), read apart from the author. */
  uploaders: Array<{ id: string; name: string | null }>;
  /** The reporting company TA025 derived from the author; null when it is the batch's own company (C11). */
  reportingSubsidiaryId: string | null;
  reportingSubsidiaryName: string | null;
  /** Who decides it (D10); null unless submitted or under review. */
  approver: RecordApprover | null;
  submittedAt: string | null;
  submissionCount: number;
  reviewedBy: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  varianceReason: string | null;
  withdrawnBy: string | null;
  withdrawnAt: string | null;
  withdrawnReason: string | null;
  rowCount: number;
  litres: string;
  /** Sum of its live records' figures; null when none is calculated. */
  tCo2e: number | null;
  evidenceCount: number;
  createdAt: string;
  updatedAt: string;
}

/** One record of a batch on its sheet: each keeps its own status after a void or a lock. */
export interface FuelBatchRecordDTO {
  id: string;
  reportingYear: number;
  /** 1–12. */
  month: number;
  activityType: string;
  status: ActivityRecordStatus;
  litres: string;
  tCo2e: number | null;
}

/** `GET /fuel-batches/:id`. */
export interface FuelBatchDetailDTO extends FuelBatchDTO {
  records: FuelBatchRecordDTO[];
  evidence: Array<{ id: string; fileName: string }>;
}

/** A row of a batch (`GET /fuel-batches/:id/rows`, paged). No card number, station or plate is stored. */
export interface FuelBatchRowDTO {
  id: string;
  /** The import it was first stored by. */
  importId: string;
  row: number;
  /** As the file wrote it, no time zone (`2025-03-31T23:50:00`); null for a tanker delivery. */
  transactionAt: string | null;
  year: number;
  month: number;
  rawFuel: string | null;
  fuel: FileFuel | null;
  litres: string;
  state: FuelRowState;
}

/** `GET /fuel-batches` and `/metadata` filters (D10). */
export interface FuelBatchFilters {
  status?: FuelBatchStatus;
  subsidiaryId?: string;
  /** The batches the caller decides (the review queue's default). */
  awaitingMyDecision?: boolean;
  /** The caller's own batches (the Fuel files page's Batches tab). */
  mine?: boolean;
  /**
   * `GET /fuel-batches` only: `fuelBatchCursor` of the last batch already
   * loaded; the next page starts right after it in the list's order
   * (`FUEL_BATCH_PAGE` a page; `/metadata` answers the total). It carries
   * that batch's sort values as the page showed them, so a batch that leaves
   * an earlier page, or is recalled, never makes a later page skip one or end
   * early (WP9 PR B review, P2: one upload can form hundreds).
   */
  after?: string;
}

/** `GET /fuel-batches` answers at most this many batches a call. */
export const FUEL_BATCH_PAGE = 200;

const ISO_MS = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z';
const UUID_TEXT = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** An ISO instant as the API writes it, and only a real one: 2025-02-30 is no instant (third review, P2). */
function instantOf(text: string): Date | null {
  const date = new Date(text);
  return !Number.isNaN(date.getTime()) && date.toISOString() === text ? date : null;
}

/** `GET /fuel-files` answers at most this many uploads a call, newest first; `?after=` the next page. */
export const FUEL_UPLOAD_PAGE = 100;

/** An upload's place in its list (newest first): its creation and id, as the list answered them. */
export function fuelUploadCursor(upload: { id: string; createdAt: string }): string {
  return `${upload.createdAt}~${upload.id}`;
}

/** A cursor's shape: an ISO instant and an id. */
export const FUEL_UPLOAD_CURSOR_SHAPE = new RegExp(`^${ISO_MS}~${UUID_TEXT}$`, 'i');

/** A cursor as `fuelUploadCursor` writes it; null for anything else (the API answers 400). */
export function parseFuelUploadCursor(cursor: string): { createdAt: Date; id: string } | null {
  if (!FUEL_UPLOAD_CURSOR_SHAPE.test(cursor)) return null;
  const [createdText, id] = cursor.split('~') as [string, string];
  const createdAt = instantOf(createdText);
  return createdAt ? { createdAt, id: id.toLowerCase() } : null;
}

/** `POST /fuel-batches/bulk-submit` takes at most this many batches a call; the screen sends more in parts. */
export const FUEL_BULK_SUBMIT_MAX = 200;

/** A batch's place in either list order: its creation, its submission and its id, as the list answered them. */
export function fuelBatchCursor(batch: { id: string; createdAt: string; submittedAt: string | null }): string {
  return `${batch.createdAt}~${batch.submittedAt ?? ''}~${batch.id}`;
}

/** A cursor's shape: two ISO instants (the second may be empty) and an id. */
export const FUEL_BATCH_CURSOR_SHAPE = new RegExp(`^${ISO_MS}~(?:${ISO_MS})?~${UUID_TEXT}$`, 'i');

/** A cursor as `fuelBatchCursor` writes it; null for anything else (the API answers 400). */
export function parseFuelBatchCursor(cursor: string): { createdAt: Date; submittedAt: Date | null; id: string } | null {
  if (!FUEL_BATCH_CURSOR_SHAPE.test(cursor)) return null;
  const [createdText, submittedText, id] = cursor.split('~') as [string, string, string];
  const createdAt = instantOf(createdText);
  const submittedAt = submittedText === '' ? null : instantOf(submittedText);
  if (!createdAt || (submittedText !== '' && !submittedAt)) return null;
  return { createdAt, submittedAt, id: id.toLowerCase() };
}

export interface FuelBatchMetadataDTO {
  total: number;
}

/**
 * `PATCH /fuel-batches/:id/declarations` (author; draft or returned; D13):
 * the usage, and for a tanker batch its fuel, year and month.
 */
export interface UpdateFuelBatchDeclarationsRequest {
  usage: FuelUsage;
  fuel?: FileFuel;
  year?: number;
  month?: number;
}

/** `POST /fuel-batches/:id/submit`: the flagged fuels' one reason (D12). */
export interface SubmitFuelBatchRequest {
  varianceReason?: string;
}

/** `POST /fuel-batches/:id/withdraw` (C14). */
export interface WithdrawFuelBatchRequest {
  reason: string;
}

/**
 * `POST /fuel-batches/bulk-submit`: several batches, each its own step; the
 * answer names each refusal. A batch's review, approval and return take the
 * record's bodies (`StartReviewInput`, `ApproveInput`, `RejectInput`), naming
 * the batch's submission.
 */
export interface BulkSubmitFuelBatchesRequest {
  batchIds: string[];
}

export interface BulkSubmitFuelBatchesResultDTO {
  submitted: string[];
  failed: Array<{ batchId: string; code: string }>;
}
