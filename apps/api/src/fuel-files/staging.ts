import {
  fuelRowState,
  recogniseFuel,
  type FileFuel,
  type FuelAccountTarget,
  type FuelPreviewOutcome,
  type FuelRowIssueDTO,
  type FuelRowState,
  type FuelSource,
  type FuelTankerDeclaration,
  type FuelUsage,
  FUEL_USAGES,
} from '@tonyai/shared-types';
import type { FuelDraftRow } from './adapters/adapter';
import type { KeyedFuelReading } from './read-fuel-file';

/**
 * What a read file's rows become (inc28-fuel-bulk D3, D5, D8): a pure plan
 * over the file, the stored accounts and the stored live rows. The preview
 * shows it; the apply re-plans it inside its transaction, under the accounts'
 * row locks, and stores it.
 */

export interface StagedAccount {
  /** Null for an account this file names first. */
  id: string | null;
  code: string;
  state: 'unmatched' | 'proposed' | 'confirmed';
  /** The proposed or confirmed company. */
  subsidiaryId: string | null;
}

export interface StagedCompany {
  id: string;
  /** The display name: trading name, else legal name. */
  name: string;
  /** Every name the proposal compares (C4): legal and trading. */
  names: readonly string[];
  control: 'controlled' | 'associate';
  nodeType: string;
}

/** A stored live row with the same key (D5). */
export interface StoredDuplicate {
  holderId: string;
  state: string;
}

export interface PlannedRow extends FuelDraftRow {
  fuel: FileFuel | null;
  usage: FuelUsage;
  year: number;
  month: number;
  state: FuelRowState;
  subsidiaryId: string | null;
  /** False for a tanker delivery previewed before its declaration: its usage is a placeholder. */
  usageDeclared: boolean;
}

export interface StagingPlan {
  rows: PlannedRow[];
  /** In-file repeats and stored keys, in file order. */
  duplicates: FuelRowIssueDTO[];
  /** A tanker file's deliveries still to be stored, each needing a declaration (C3). */
  undeclared: FuelDraftRow[];
}

/** What a confirmed mapping makes of an account's rows (D8 rows 3 and 4). */
export function accountTarget(
  account: StagedAccount | undefined,
  companies: ReadonlyMap<string, StagedCompany>,
): { target: FuelAccountTarget; subsidiaryId: string | null } {
  if (!account || account.state !== 'confirmed' || account.subsidiaryId === null) {
    return { target: 'none', subsidiaryId: null };
  }
  const company = companies.get(account.subsidiaryId);
  return {
    target: company?.control === 'associate' ? 'associate' : 'records',
    subsidiaryId: account.subsidiaryId,
  };
}

/** A stored live row in no batch, held by someone else: "stored, waiting under another upload" (D5). */
export function duplicateCode(stored: StoredDuplicate, userId: string): 'fuel_duplicate' | 'fuel_duplicate_unbatched' {
  const unbatched = ['waiting_account', 'waiting_fuel', 'ready', 'held'].includes(stored.state);
  return unbatched && stored.holderId !== userId ? 'fuel_duplicate_unbatched' : 'fuel_duplicate';
}

export interface StagingInput {
  source: FuelSource;
  userId: string;
  /** A card file's one usage. */
  usage: FuelUsage | null;
  /** A tanker file's declarations by `EVRAK NO`; absent at preview. */
  declarations: ReadonlyMap<string, FuelTankerDeclaration> | null;
  reading: KeyedFuelReading;
  accounts: ReadonlyMap<string, StagedAccount>;
  companies: ReadonlyMap<string, StagedCompany>;
  stored: ReadonlyMap<string, StoredDuplicate>;
}

export function planStaging(input: StagingInput): StagingPlan {
  const plan: StagingPlan = { rows: [], duplicates: [], undeclared: [] };
  const duplicates = [...input.reading.duplicates];
  for (const draft of input.reading.rows) {
    const stored = input.stored.get(draft.dedupeDigest);
    if (stored) {
      duplicates.push({ row: draft.fileRow, code: duplicateCode(stored, input.userId) });
      continue;
    }
    const mapping = accountTarget(input.accounts.get(draft.accountCode), input.companies);
    let fuel: FileFuel | null;
    let usage: FuelUsage;
    let year: number;
    let month: number;
    if (input.source === 'tanker') {
      const declared = input.declarations?.get(draft.invoiceRef);
      if (!declared) {
        plan.undeclared.push(draft);
        // A preview still says where the delivery goes: its state does not depend on which fuel.
        if (input.declarations !== null) continue;
      }
      fuel = declared?.fuel ?? 'diesel';
      usage = declared?.usage ?? 'on_road';
      year = declared?.year ?? 0;
      month = declared?.month ?? 0;
    } else {
      fuel = recogniseFuel(draft.rawFuel);
      usage = input.usage!;
      year = draft.year!;
      month = draft.month!;
    }
    const state = fuelRowState({
      withdrawn: false,
      inBatch: false,
      account: mapping.target,
      fuel,
      holdReason: null,
    });
    const usageDeclared = input.source !== 'tanker' || input.declarations?.get(draft.invoiceRef) !== undefined;
    plan.rows.push({ ...draft, fuel, usage, year, month, state, subsidiaryId: mapping.subsidiaryId, usageDeclared });
  }
  plan.duplicates = duplicates.sort((a, b) => a.row - b.row);
  return plan;
}

/**
 * What a planned row means on the preview for its reader (D3). `forms`: can
 * the reader's batches take a row of this company and usage — its company
 * granted and, for a standard user, the usage's category ticked; otherwise
 * formation holds it (`fuel_out_of_scope`, `category_not_granted`) and the
 * preview says so, never "batches" (WP9 PR B review, P2).
 */
export function previewOutcome(row: PlannedRow, forms: (subsidiaryId: string, usage: FuelUsage) => boolean): FuelPreviewOutcome {
  switch (row.state) {
    case 'waiting_account':
      return 'waiting_account';
    case 'excluded':
      return 'excluded';
    case 'waiting_fuel':
      return 'waiting_fuel';
    default:
      if (row.subsidiaryId === null) return 'outside_scope';
      if (row.usageDeclared) return forms(row.subsidiaryId, row.usage) ? 'batches' : 'outside_scope';
      {
        // Not yet declared: say "batches" or "outside" only when every usage agrees (fourth review, P2).
        const subsidiaryId = row.subsidiaryId;
        const takes = FUEL_USAGES.filter((usage) => forms(subsidiaryId, usage)).length;
        return takes === FUEL_USAGES.length ? 'batches' : takes === 0 ? 'outside_scope' : 'depends_on_usage';
      }
  }
}
