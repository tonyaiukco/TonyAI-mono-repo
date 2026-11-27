import {
  can,
  type FuelAccountDTO,
  type FuelUploadDTO,
  type SubsidiaryDTO,
  type UserRole,
} from "@/lib/types";

/**
 * The Fuel files page's Uploads, Unmatched and Accounts tabs, as pure logic
 * (inc28-fuel-bulk D7, D8, D16): which action each row offers to whom.
 * The server decides every one again; this only keeps the screen from
 * offering what it would refuse.
 */

/** The rows of an upload that are in no batch and could change holder. */
function unbatchedRows(upload: FuelUploadDTO): number {
  return upload.rows.ready.rows + upload.rows.held.rows + upload.rows.waiting_account.rows + upload.rows.waiting_fuel.rows;
}

/** An upload's actions: forming and "try again" for its rows' holder; takeover for a masterkey who is not. */
export function uploadActions(upload: FuelUploadDTO, role: UserRole | undefined): { form: boolean; retry: boolean; takeOver: boolean } {
  return {
    form: upload.readerIsHolder && upload.processableRows > 0,
    retry: upload.readerIsHolder && upload.held.length > 0,
    takeOver: !upload.readerIsHolder && can(role, "fuel_rows.take_over") && unbatchedRows(upload) > 0,
  };
}

/** An account's actions: confirm when the server says the reader may; change, withdraw and add by hand for a masterkey. */
export function accountActions(account: FuelAccountDTO, role: UserRole | undefined): { confirm: boolean; change: boolean } {
  return {
    confirm: account.state !== "confirmed" && account.canConfirm,
    change: can(role, "fuel_account.write"),
  };
}

/** Whether the reader adds accounts by hand (the Accounts tab and the wizard's step 7). */
export function mayAddAccounts(role: UserRole | undefined): boolean {
  return can(role, "fuel_account.write");
}

/**
 * The companies an account may be mapped to: a company or an associate,
 * never a sector group (it holds no records of its own, C6). A super_admin
 * confirms only within its grants, which the server's list already is.
 */
export function mappableCompanies(companies: readonly SubsidiaryDTO[]): SubsidiaryDTO[] {
  return companies
    .filter((c) => c.nodeType !== "sector_group")
    .sort((a, b) => companyName(a).localeCompare(companyName(b)));
}

export const companyName = (c: Pick<SubsidiaryDTO, "legalName" | "tradingName">): string => c.tradingName || c.legalName;
