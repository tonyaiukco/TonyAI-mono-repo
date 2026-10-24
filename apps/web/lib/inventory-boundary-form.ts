import {
  INVENTORY_CATEGORIES,
  INVENTORY_REASON_MAX_LENGTH,
  INVENTORY_SOURCE_NAME_MAX_LENGTH,
  recordActivityTypesFor,
  textIssue,
  type InventoryApplicabilityCellInput,
  type InventoryAttributionPolicy,
  type InventoryBoundarySnapshot,
  type InventoryCategory,
  type InventoryMonth,
  type InventorySourceInput,
  type PutInventoryBoundarySubsidiaryRequest,
  type ReportingPeriod,
} from "./types";

/**
 * The boundary editor's form (LP4-03 PR C, Decisions 2026-10-24 D3–D5): one
 * subsidiary's declaration as the screen edits it, read from a version's
 * snapshot and written back as the PUT body. The round trip is lossless for
 * every body the API admits — a declaration entered through the API (cells at
 * an entity its policy does not select, a named exclusion beside its meter)
 * is shown and sent back as it is, never "tidied". The API is the authority:
 * `declarationIssues` mirrors its refusals (`inventoryDeclarationIssues` and
 * the field rules of `apps/api/src/inventory-boundary/dto/`) so a refusal is
 * worded on its field before any request, and what the API stores as a gap
 * (a missing policy or cell, `undetermined`) is reported by the API, not here.
 */

export type Applicability = "included" | "excluded" | "undetermined";

export interface SiteDraft {
  locationId: string;
  firstMonth: InventoryMonth;
  lastMonth: InventoryMonth;
}

export interface PolicyDraft {
  level: InventoryAttributionPolicy["level"];
  /** null until chosen: never defaulted, it decides every included source's obligations. */
  reportingPeriod: ReportingPeriod | null;
}

export interface CellDraft {
  applicability: Applicability;
  /** Kept while the decision is `included`, so switching back restores it; sent only when not. */
  reason: string;
}

export interface SourceDraft {
  /** The screen's own key: the stored source's id, or a new one. Never sent. */
  key: string;
  /** null: the company entity. */
  locationId: string | null;
  name: string;
  kind: "mapped" | "unsupported";
  /** mapped only */
  category: InventoryCategory | null;
  /** mapped only; null for a category with no activity types */
  activityType: string | null;
  /** unsupported only: why it maps to no category */
  unsupportedReason: string;
  /** unsupported only */
  scope: 1 | 2 | null;
  /** unsupported and included only */
  reportingPeriod: ReportingPeriod | null;
  applicability: Applicability;
  /** sent only when not included */
  reason: string;
  /** included only; null: no evidence, chosen as such; undefined: not chosen yet — never defaulted (W5) */
  evidenceReportingPeriod: ReportingPeriod | null | undefined;
}

export interface DeclarationDraft {
  firstMonth: InventoryMonth;
  lastMonth: InventoryMonth;
  sites: SiteDraft[];
  attribution: Partial<Record<InventoryCategory, PolicyDraft>>;
  /** Keyed by `cellKey`; absent: no cell (a gap the API reports). */
  cells: Record<string, CellDraft>;
  sources: SourceDraft[];
}

export const MONTHS: readonly InventoryMonth[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

const isInventoryCategory = (value: unknown): value is InventoryCategory =>
  (INVENTORY_CATEGORIES as readonly unknown[]).includes(value);

/** A cell's key: its entity (`""` for the company entity) and its category. */
export const cellKey = (locationId: string | null, category: InventoryCategory): string =>
  `${locationId ?? ""}|${category}`;

function parseCellKey(key: string): { locationId: string | null; category: InventoryCategory } {
  const at = key.lastIndexOf("|");
  const location = key.slice(0, at);
  return { locationId: location === "" ? null : location, category: key.slice(at + 1) as InventoryCategory };
}

/** A new subsidiary's declaration: the whole year, nothing else declared. */
export function emptyDraft(): DeclarationDraft {
  return { firstMonth: 1, lastMonth: 12, sites: [], attribution: {}, cells: {}, sources: [] };
}

/** The subsidiary's declaration in a version, or null when it declares none. */
export function draftFromSnapshot(boundary: InventoryBoundarySnapshot, subsidiaryId: string): DeclarationDraft | null {
  const company = boundary.entities.find((e) => e.subsidiaryId === subsidiaryId && e.locationId === null);
  if (!company) return null;
  const attribution: DeclarationDraft["attribution"] = {};
  for (const p of boundary.attribution) {
    if (p.subsidiaryId === subsidiaryId && isInventoryCategory(p.category)) {
      attribution[p.category] = { level: p.level, reportingPeriod: p.reportingPeriod };
    }
  }
  const cells: DeclarationDraft["cells"] = {};
  for (const c of boundary.applicability) {
    if (c.subsidiaryId !== subsidiaryId || !isInventoryCategory(c.category)) continue;
    cells[cellKey(c.locationId, c.category)] = {
      applicability: c.applicability,
      reason: c.applicability === "included" ? "" : c.reason,
    };
  }
  return {
    firstMonth: company.firstMonth,
    lastMonth: company.lastMonth,
    sites: boundary.entities
      .filter((e) => e.subsidiaryId === subsidiaryId && e.locationId !== null)
      .map((e) => ({ locationId: e.locationId as string, firstMonth: e.firstMonth, lastMonth: e.lastMonth })),
    attribution,
    cells,
    sources: boundary.sources
      .filter((s) => s.entity.subsidiaryId === subsidiaryId)
      .map((s): SourceDraft => {
        const mapped = s.mapping.kind === "mapped";
        const included = s.applicability === "included";
        return {
          key: s.id,
          locationId: s.entity.locationId,
          name: s.name,
          kind: s.mapping.kind,
          category: s.mapping.kind === "mapped" && isInventoryCategory(s.mapping.category) ? s.mapping.category : null,
          activityType: s.mapping.kind === "mapped" ? s.mapping.activityType : null,
          unsupportedReason: s.mapping.kind === "unsupported" ? s.mapping.reason : "",
          scope: mapped ? null : s.scope,
          reportingPeriod: !mapped && included ? s.reportingPeriod : null,
          applicability: s.applicability,
          reason: included ? "" : s.reason,
          evidenceReportingPeriod: included ? s.evidenceReportingPeriod : undefined,
        };
      }),
  };
}

/** Free text as it is sent: no edge white space, NFC — the API's spelling. */
const clean = (text: string): string => text.trim().normalize("NFC");

/** The PUT body. Call it on a draft without `declarationIssues`; the API refuses anything else. */
export function requestFromDraft(draft: DeclarationDraft): PutInventoryBoundarySubsidiaryRequest {
  const applicability: InventoryApplicabilityCellInput[] = Object.entries(draft.cells).map(([key, cell]) => {
    const { locationId, category } = parseCellKey(key);
    return cell.applicability === "included"
      ? { locationId, category, applicability: "included" }
      : { locationId, category, applicability: cell.applicability, reason: clean(cell.reason) };
  });
  const sources = draft.sources.map((s): InventorySourceInput => {
    const decision = s.applicability === "included"
      ? { applicability: "included" as const, evidenceReportingPeriod: s.evidenceReportingPeriod ?? null }
      : { applicability: s.applicability, reason: clean(s.reason) };
    if (s.kind === "mapped") {
      return {
        locationId: s.locationId,
        name: clean(s.name),
        // An untyped category's source names no activity type (the API refuses one).
        mapping: {
          kind: "mapped",
          category: s.category as InventoryCategory,
          activityType: recordActivityTypesFor(s.category as InventoryCategory).length > 0 ? s.activityType : null,
        },
        ...decision,
      } as InventorySourceInput;
    }
    return {
      locationId: s.locationId,
      name: clean(s.name),
      mapping: { kind: "unsupported", reason: clean(s.unsupportedReason) },
      scope: s.scope as 1 | 2,
      ...(s.applicability === "included" ? { reportingPeriod: s.reportingPeriod as ReportingPeriod } : {}),
      ...decision,
    } as InventorySourceInput;
  });
  return {
    firstMonth: draft.firstMonth,
    lastMonth: draft.lastMonth,
    sites: draft.sites.map((s) => ({ ...s })),
    attribution: INVENTORY_CATEGORIES.flatMap((category) => {
      const p = draft.attribution[category];
      return p ? [{ category, level: p.level, reportingPeriod: p.reportingPeriod as ReportingPeriod }] : [];
    }),
    applicability,
    sources,
  };
}

/** One request's content, independent of row order: two bodies that declare the same are equal. */
export function declarationFingerprint(request: PutInventoryBoundarySubsidiaryRequest | null): string {
  if (request === null) return "null";
  const sorted = (rows: readonly unknown[]) => rows.map((r) => stableJson(r)).sort();
  return stableJson({
    firstMonth: request.firstMonth,
    lastMonth: request.lastMonth,
    sites: sorted(request.sites),
    attribution: sorted(request.attribution),
    applicability: sorted(request.applicability),
    sources: sorted(request.sources),
  });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The subsidiary's declaration in a version, as its PUT body would state it — what a save compares. */
export function storedDeclaration(boundary: InventoryBoundarySnapshot, subsidiaryId: string): string {
  const draft = draftFromSnapshot(boundary, subsidiaryId);
  return declarationFingerprint(draft ? requestFromDraft(draft) : null);
}

/**
 * A whole version as a confirmation freezes it — every declaration, and the
 * entities' names and geography, which an open version reads live and a
 * confirmation fixes (W7): a confirmation freezes only what the screen showed.
 * A save compares `storedDeclaration` instead, which a rename does not move.
 */
export function versionFingerprint(boundary: InventoryBoundarySnapshot): string {
  const declarations = [...boundary.subsidiaryIds].sort().map((id) => `${id}=${storedDeclaration(boundary, id)}`);
  const entities = boundary.entities
    .map((e) => stableJson([e.subsidiaryId, e.locationId, e.subsidiaryName, e.locationName, e.geographyCode]))
    .sort();
  return stableJson({ declarations, entities });
}

// --- Edits that keep the draft one the API admits -------------------------

/** A site leaves with its cells and sources: the API refuses a row at a site the body does not declare. */
export function removeSite(draft: DeclarationDraft, locationId: string): DeclarationDraft {
  return {
    ...draft,
    sites: draft.sites.filter((s) => s.locationId !== locationId),
    cells: Object.fromEntries(Object.entries(draft.cells).filter(([key]) => parseCellKey(key).locationId !== locationId)),
    sources: draft.sources.filter((s) => s.locationId !== locationId),
  };
}

/** A site joins for the subsidiary's months. */
export function addSite(draft: DeclarationDraft, locationId: string): DeclarationDraft {
  if (draft.sites.some((s) => s.locationId === locationId)) return draft;
  return { ...draft, sites: [...draft.sites, { locationId, firstMonth: draft.firstMonth, lastMonth: draft.lastMonth }] };
}

let newSourceCount = 0;
/** A new source at the company entity, mapped, included; its category and evidence cadence still to choose. */
export function newSource(locationId: string | null = null): SourceDraft {
  newSourceCount += 1;
  return {
    key: `new-${newSourceCount}`,
    locationId,
    name: "",
    kind: "mapped",
    category: null,
    activityType: null,
    unsupportedReason: "",
    scope: null,
    reportingPeriod: null,
    applicability: "included",
    reason: "",
    evidenceReportingPeriod: undefined,
  };
}

/** A mapped source's category: a typed one's activity type must be re-chosen, an untyped one's is null. */
export function withCategory(source: SourceDraft, category: InventoryCategory): SourceDraft {
  const types = recordActivityTypesFor(category);
  const keep = types.some((t) => t.value === source.activityType);
  return { ...source, category, activityType: keep ? source.activityType : null };
}

// --- The API's refusals, worded before a request ---------------------------

export const DECLARATION_ISSUE_CODES = [
  "monthsOrder",
  "siteMonthsOrder",
  "siteOutsideMonths",
  "siteNotDeclared",
  "textRequired",
  "textTooLong",
  "textInvalid",
  "categoryRequired",
  "activityTypeRequired",
  "scopeRequired",
  "cadenceRequired",
  "evidenceRequired",
  "policyRequired",
  "duplicateIncluded",
] as const;
export type DeclarationIssueCode = (typeof DECLARATION_ISSUE_CODES)[number];

export interface DeclarationIssue {
  /** The field it belongs to — `declarationField` builds each. */
  field: string;
  code: DeclarationIssueCode;
  values?: { max?: number; category?: InventoryCategory };
}

export const declarationField = {
  months: "months",
  policy: (category: InventoryCategory) => `policy:${category}`,
  site: (locationId: string) => `site:${locationId}`,
  cell: (key: string) => `cell:${key}`,
  source: (key: string, part: "name" | "reason" | "unsupportedReason" | "category" | "activityType" | "scope" | "reportingPeriod" | "evidence" | "location") =>
    `source:${key}:${part}`,
} as const;

/** A free text's refusal, after `clean`: blank, too long, or a character the API refuses. */
function textCode(text: string, max: number): Pick<DeclarationIssue, "code" | "values"> | null {
  const value = clean(text);
  if (value === "") return { code: "textRequired" };
  if (value.length > max) return { code: "textTooLong", values: { max } };
  return textIssue(value, max) === null ? null : { code: "textInvalid" };
}

/** Every refusal the API would answer `validation_failed` for, on its field; empty: the body is admitted. */
export function declarationIssues(draft: DeclarationDraft): DeclarationIssue[] {
  const issues: DeclarationIssue[] = [];
  const push = (field: string, issue: Pick<DeclarationIssue, "code" | "values"> | null) => {
    if (issue) issues.push({ field, ...issue });
  };
  const monthsOk = draft.lastMonth >= draft.firstMonth;
  if (!monthsOk) push(declarationField.months, { code: "monthsOrder" });

  const sites = new Set<string>();
  for (const site of draft.sites) {
    sites.add(site.locationId);
    if (site.lastMonth < site.firstMonth) push(declarationField.site(site.locationId), { code: "siteMonthsOrder" });
    else if (monthsOk && (site.firstMonth < draft.firstMonth || site.lastMonth > draft.lastMonth)) {
      push(declarationField.site(site.locationId), { code: "siteOutsideMonths" });
    }
  }
  const declared = (locationId: string | null) => locationId === null || sites.has(locationId);

  for (const category of INVENTORY_CATEGORIES) {
    const policy = draft.attribution[category];
    if (policy && policy.reportingPeriod === null) push(declarationField.policy(category), { code: "cadenceRequired" });
  }

  for (const [key, cell] of Object.entries(draft.cells)) {
    if (!declared(parseCellKey(key).locationId)) push(declarationField.cell(key), { code: "siteNotDeclared" });
    if (cell.applicability !== "included") push(declarationField.cell(key), textCode(cell.reason, INVENTORY_REASON_MAX_LENGTH));
  }

  const includedKeys = new Set<string>();
  for (const s of draft.sources) {
    const field = (part: Parameters<typeof declarationField.source>[1]) => declarationField.source(s.key, part);
    if (!declared(s.locationId)) push(field("location"), { code: "siteNotDeclared" });
    push(field("name"), textCode(s.name, INVENTORY_SOURCE_NAME_MAX_LENGTH));
    const included = s.applicability === "included";
    if (!included) push(field("reason"), textCode(s.reason, INVENTORY_REASON_MAX_LENGTH));
    if (included && s.evidenceReportingPeriod === undefined) push(field("evidence"), { code: "evidenceRequired" });
    if (s.kind === "unsupported") {
      push(field("unsupportedReason"), textCode(s.unsupportedReason, INVENTORY_REASON_MAX_LENGTH));
      if (s.scope === null) push(field("scope"), { code: "scopeRequired" });
      if (included && s.reportingPeriod === null) push(field("reportingPeriod"), { code: "cadenceRequired" });
      continue;
    }
    if (s.category === null) {
      push(field("category"), { code: "categoryRequired" });
      continue;
    }
    const types = recordActivityTypesFor(s.category).map((t) => t.value);
    if (types.length > 0 && (s.activityType === null || !types.includes(s.activityType))) {
      push(field("activityType"), { code: "activityTypeRequired" });
    }
    if (!included) continue;
    if (!draft.attribution[s.category]) push(field("category"), { code: "policyRequired", values: { category: s.category } });
    const includedKey = `${s.locationId ?? ""}|${s.category}|${s.activityType ?? ""}`;
    // On the activity type when the category has some, else on the category (no activity-type field is shown).
    if (includedKeys.has(includedKey)) push(field(types.length > 0 ? "activityType" : "category"), { code: "duplicateIncluded" });
    includedKeys.add(includedKey);
  }
  return issues;
}
