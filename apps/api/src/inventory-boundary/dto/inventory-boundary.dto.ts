import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsIn, IsInt, IsNotIn, IsObject, IsOptional, IsString, Matches, Max, Min,
  Validate, ValidateIf, ValidateNested, ValidatorConstraint,
  type ValidationArguments, type ValidatorConstraintInterface,
} from 'class-validator';
import {
  INVENTORY_CATEGORIES, INVENTORY_REASON_MAX_LENGTH, INVENTORY_SOURCE_NAME_MAX_LENGTH,
  recordActivityTypesFor, REPORTING_PERIODS, REPORTING_YEAR_MAX, REPORTING_YEAR_MIN, textIssue,
  type CreateInventoryBoundaryRequest, type InventoryApplicabilityCellInput,
  type InventoryApplicabilityDecision, type InventoryAttributionPolicy,
  type InventoryAttributionPolicyInput, type InventoryBoundarySiteInput, type InventoryCategory,
  type InventoryMonth, type InventorySourceInput, type InventorySourceMappingInput,
  type ListInventoryBoundariesParams, type PutInventoryBoundarySubsidiaryRequest, type ReportingPeriod,
} from '@tonyai/shared-types';
import { lowercaseUuid, UUID_SHAPE } from '../../common/parse-uuid-param.pipe';
import { integerQuery } from '../../common/reporting-context-query.dto';

/**
 * LP3-04's write path (W1; Decisions 2026-10-15 (fifth) E1, E9): the bodies
 * the boundary routes accept. Each field holds the database's own rule (PR B's
 * CHECKs), and one document check holds the rules across rows that the
 * database enforces by keys and by its guard (TA014) — so a body this file
 * admits is one the database admits, and the guard stays a backstop (E7).
 * What the database stores but a final report cannot use — a missing policy or
 * cell, an `undetermined` decision — is a gap, reported, never refused here.
 * Whether the subsidiary belongs to the caller's organisation, and each site
 * to that subsidiary (the composite key `locations(id, subsidiary_id)`), is the
 * service's check (`subsidiary_not_found`, `location_not_found`).
 */

/** The company entity's key in cells and sources (PR B's migration); never a site. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** Bounds a request; no pilot subsidiary comes near them. */
export const INVENTORY_DECLARATION_LIMITS = Object.freeze({
  sites: 500,
  attribution: INVENTORY_CATEGORIES.length,
  applicability: (500 + 1) * INVENTORY_CATEGORIES.length,
  sources: 2000,
});

/** Each list exhaustive against the contract's union. */
const ATTRIBUTION_LEVELS = Object.keys({ company: true, sites: true } satisfies Record<InventoryAttributionPolicy['level'], true>);
const APPLICABILITIES = Object.keys(
  { included: true, excluded: true, undetermined: true } satisfies Record<InventoryApplicabilityDecision['applicability'], true>,
);
const MAPPING_KINDS = Object.keys({ mapped: true, unsupported: true } satisfies Record<InventorySourceMappingInput['kind'], true>);

/** The factor library's and the boundary's free-text rule, at the CHECK's cap. */
@ValidatorConstraint({ name: 'inventoryText', async: false })
class InventoryTextConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    return textIssue(value, args.constraints[0] as number) === null;
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} ${textIssue(args.value, args.constraints[0] as number) ?? 'is not valid'}`;
  }
}

/** A site key: an id, lowercased (the database's spelling), never the nil uuid. */
function SiteId(): PropertyDecorator {
  return (target, key) => {
    Transform(lowercaseUuid)(target, key);
    Matches(UUID_SHAPE, { message: `${String(key)} must be an id` })(target, key);
    IsNotIn([NIL_UUID], { message: `${String(key)} must not be the nil uuid: it is the company entity's key` })(target, key);
  };
}

/** GET /inventory-boundaries?reportingYear= */
export class ListInventoryBoundariesQueryDto implements ListInventoryBoundariesParams {
  @Transform(integerQuery)
  @IsInt()
  @Min(REPORTING_YEAR_MIN)
  @Max(REPORTING_YEAR_MAX)
  reportingYear!: number;
}

/** POST /inventory-boundaries — the organisation, version and author are the API's (E6). */
export class CreateInventoryBoundaryDto implements CreateInventoryBoundaryRequest {
  @IsInt()
  @Min(REPORTING_YEAR_MIN)
  @Max(REPORTING_YEAR_MAX)
  reportingYear!: number;

  // Not @IsOptional: that would let `null` through as "no copy".
  @ValidateIf((o: CreateInventoryBoundaryDto) => o.copyOf !== undefined)
  @Transform(lowercaseUuid)
  @Matches(UUID_SHAPE, { message: 'copyOf must be an id' })
  copyOf?: string;
}

export class InventoryBoundarySiteDto implements InventoryBoundarySiteInput {
  @SiteId()
  locationId!: string;

  @IsInt() @Min(1) @Max(12)
  firstMonth!: InventoryMonth;

  @IsInt() @Min(1) @Max(12)
  lastMonth!: InventoryMonth;
}

export class InventoryAttributionPolicyDto implements InventoryAttributionPolicyInput {
  @IsIn(INVENTORY_CATEGORIES)
  category!: InventoryCategory;

  @IsIn(ATTRIBUTION_LEVELS)
  level!: InventoryAttributionPolicy['level'];

  @IsIn(REPORTING_PERIODS)
  reportingPeriod!: ReportingPeriod;
}

/** Flat: the decision's reason rule is the document check's. */
export class InventoryApplicabilityCellDto {
  // null is the company entity.
  @ValidateIf((_o, value) => value !== null)
  @SiteId()
  locationId!: string | null;

  @IsIn(INVENTORY_CATEGORIES)
  category!: InventoryCategory;

  @IsIn(APPLICABILITIES)
  applicability!: InventoryApplicabilityDecision['applicability'];

  @IsOptional()
  @Validate(InventoryTextConstraint, [INVENTORY_REASON_MAX_LENGTH])
  reason?: string;
}

/** Flat: which fields a kind takes is the document check's. */
export class InventorySourceMappingDto {
  @IsIn(MAPPING_KINDS)
  kind!: InventorySourceMappingInput['kind'];

  @IsOptional()
  @IsIn(INVENTORY_CATEGORIES)
  category?: InventoryCategory;

  // Membership in the category's list is the document check's.
  @IsOptional()
  @IsString()
  activityType?: string | null;

  @IsOptional()
  @Validate(InventoryTextConstraint, [INVENTORY_REASON_MAX_LENGTH])
  reason?: string;
}

/** Flat: the mapping and decision rules are the document check's. */
export class InventorySourceDto {
  @ValidateIf((_o, value) => value !== null)
  @SiteId()
  locationId!: string | null;

  @Validate(InventoryTextConstraint, [INVENTORY_SOURCE_NAME_MAX_LENGTH])
  name!: string;

  @IsObject()
  @ValidateNested()
  @Type(() => InventorySourceMappingDto)
  mapping!: InventorySourceMappingDto;

  @IsOptional()
  @IsIn([1, 2])
  scope?: 1 | 2;

  @IsOptional()
  @IsIn(REPORTING_PERIODS)
  reportingPeriod?: ReportingPeriod;

  @IsIn(APPLICABILITIES)
  applicability!: InventoryApplicabilityDecision['applicability'];

  @IsOptional()
  @Validate(InventoryTextConstraint, [INVENTORY_REASON_MAX_LENGTH])
  reason?: string;

  // null: no evidence cadence (W5).
  @IsOptional()
  @IsIn(REPORTING_PERIODS)
  evidenceReportingPeriod?: ReportingPeriod | null;
}

type Row = Record<string, unknown>;

const isMonth = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 12;

const isInventoryCategory = (value: unknown): value is InventoryCategory =>
  (INVENTORY_CATEGORIES as readonly unknown[]).includes(value);

/** Each row of a list with its own index; anything else — an array
 * included — is a field error already. */
function eachRow(list: unknown, visit: (row: Row, index: number) => void): void {
  if (!Array.isArray(list)) return;
  list.forEach((row, index) => {
    if (typeof row === 'object' && row !== null && !Array.isArray(row)) visit(row as Row, index);
  });
}

/** An entity's key, as the database's `location_key`: the nil uuid for the
 * company entity, the lowercased site id otherwise; undefined when malformed. */
function entityKey(locationId: unknown): string | undefined {
  if (locationId === null) return NIL_UUID;
  return typeof locationId === 'string' ? locationId.toLowerCase() : undefined;
}

/** A reason exactly when the decision is not inclusion — a cell's and a source's. */
function decisionIssues(at: string, row: Row, issues: string[]): void {
  if (row.applicability === 'included' && row.reason !== undefined) {
    issues.push(`${at} must carry no reason when included`);
  }
  if ((row.applicability === 'excluded' || row.applicability === 'undetermined')
    && (row.reason === undefined || row.reason === null)) {
    issues.push(`${at} must name its reason when not included`);
  }
}

/**
 * The rules across a declaration's rows, each one the database holds by a key,
 * a CHECK spanning a row's columns, or its guard. Defensive about shape: a
 * malformed field is reported by its own decorator, and skipped here.
 */
export function inventoryDeclarationIssues(body: object): string[] {
  const b = body as Row;
  const issues: string[] = [];
  const months = isMonth(b.firstMonth) && isMonth(b.lastMonth) ? { first: b.firstMonth, last: b.lastMonth } : null;
  if (months && months.last < months.first) issues.push('lastMonth must not precede firstMonth');

  const sites = new Set<string>();
  eachRow(b.sites, (site, i) => {
    const key = entityKey(site.locationId);
    if (key !== undefined) {
      if (sites.has(key)) issues.push(`sites[${i}] is declared twice`);
      sites.add(key);
    }
    if (!isMonth(site.firstMonth) || !isMonth(site.lastMonth)) return;
    if (site.lastMonth < site.firstMonth) {
      issues.push(`sites[${i}]: lastMonth must not precede firstMonth`);
    } else if (months && months.last >= months.first && (site.firstMonth < months.first || site.lastMonth > months.last)) {
      // Decisions 2026-10-15 (third) (5): the months a site is included in the inventory.
      issues.push(`sites[${i}] operates outside the subsidiary's months`);
    }
  });
  const declared = (key: string | undefined) => key === undefined || key === NIL_UUID || sites.has(key);

  const policies = new Set<unknown>();
  eachRow(b.attribution, (policy, i) => {
    if (policies.has(policy.category)) issues.push(`attribution[${i}] is declared twice`);
    policies.add(policy.category);
  });

  const cells = new Set<string>();
  eachRow(b.applicability, (cell, i) => {
    const at = `applicability[${i}]`;
    const key = entityKey(cell.locationId);
    if (!declared(key)) issues.push(`${at} is at a location that is not a declared site`);
    if (key !== undefined && typeof cell.category === 'string') {
      const cellKey = `${key}|${cell.category}`;
      if (cells.has(cellKey)) issues.push(`${at} is declared twice`);
      cells.add(cellKey);
    }
    decisionIssues(at, cell, issues);
  });

  const includedKeys = new Set<string>();
  eachRow(b.sources, (source, i) => {
    const at = `sources[${i}]`;
    const key = entityKey(source.locationId);
    if (!declared(key)) issues.push(`${at} is at a location that is not a declared site`);
    decisionIssues(at, source, issues);
    const included = source.applicability === 'included';
    const notIncluded = source.applicability === 'excluded' || source.applicability === 'undetermined';
    if (included && source.evidenceReportingPeriod === undefined) {
      issues.push(`${at} must state its evidence cadence (null for none) when included`);
    }
    if (notIncluded && source.evidenceReportingPeriod !== undefined) {
      issues.push(`${at} must state no evidence cadence when not included`);
    }

    const mapping = typeof source.mapping === 'object' && source.mapping !== null ? source.mapping as Row : null;
    if (mapping?.kind === 'mapped') {
      if (mapping.reason !== undefined) issues.push(`${at} must carry no unsupported reason when mapped`);
      if (source.scope !== undefined) issues.push(`${at} must send no scope when mapped: its category's is used`);
      if (source.reportingPeriod !== undefined) {
        issues.push(`${at} must send no cadence when mapped: its category's policy's is used`);
      }
      if (mapping.category === undefined || mapping.category === null) {
        issues.push(`${at} must name its category when mapped`);
      }
      if (!isInventoryCategory(mapping.category)) return;
      const category = mapping.category;
      const types = recordActivityTypesFor(category).map((t) => t.value);
      if (types.length > 0) {
        if (typeof mapping.activityType !== 'string' || !types.includes(mapping.activityType)) {
          issues.push(`${at} must name one of ${category}'s activity types`);
        }
      } else if (mapping.activityType !== null) {
        issues.push(`${at} must name a null activity type: ${category} has none`);
      }
      if (!included) return;
      // Decisions 2026-10-15 (third) (7): the cadence key points at the policy.
      if (!policies.has(category)) issues.push(`${at} has no attribution policy for ${category}: declare it first`);
      // `included_activity_key`: unique per entity and category (PR B's (4)).
      if (key !== undefined && (mapping.activityType === null || typeof mapping.activityType === 'string')) {
        const includedKey = `${key}|${category}|${mapping.activityType ?? ''}`;
        if (includedKeys.has(includedKey)) {
          issues.push(`${at} is included with the same entity, category and activity type as another source`);
        }
        includedKeys.add(includedKey);
      }
    } else if (mapping?.kind === 'unsupported') {
      if (mapping.category !== undefined) issues.push(`${at} must name no category when unsupported`);
      if (mapping.activityType !== undefined) issues.push(`${at} must name no activity type when unsupported`);
      if (mapping.reason === undefined || mapping.reason === null) {
        issues.push(`${at} must name why it is unsupported (mapping.reason)`);
      }
      if (source.scope === undefined || source.scope === null) {
        issues.push(`${at} must declare its scope (1 or 2) when unsupported`);
      }
      if (included && (source.reportingPeriod === undefined || source.reportingPeriod === null)) {
        issues.push(`${at} must declare its cadence when included`);
      }
      if (notIncluded && source.reportingPeriod !== undefined) {
        issues.push(`${at} must declare no cadence when not included`);
      }
    }
  });
  return issues;
}

@ValidatorConstraint({ name: 'inventoryDeclaration', async: false })
class InventoryDeclarationConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    return inventoryDeclarationIssues(args.object).length === 0;
  }

  defaultMessage(args: ValidationArguments): string {
    return inventoryDeclarationIssues(args.object).join('; ');
  }
}

/** Each list's direct elements are rows: objects, never arrays (Codex B9
 * P2 — an inner array passed `@ValidateNested` whole, its rows unchecked). */
const ROW_MESSAGE = 'each $property entry must be an object';

/** PUT /inventory-boundaries/:id/subsidiaries/:subsidiaryId — the whole
 * declaration (E1); every list present, an empty one meaning none. */
export class PutInventoryBoundarySubsidiaryDto {
  // The document check rides on the first field, as `ReportingContextQueryDto`'s does.
  @IsInt() @Min(1) @Max(12)
  @Validate(InventoryDeclarationConstraint)
  firstMonth!: InventoryMonth;

  @IsInt() @Min(1) @Max(12)
  lastMonth!: InventoryMonth;

  @IsArray()
  @ArrayMaxSize(INVENTORY_DECLARATION_LIMITS.sites)
  @IsObject({ each: true, message: ROW_MESSAGE })
  @ValidateNested({ each: true })
  @Type(() => InventoryBoundarySiteDto)
  sites!: readonly InventoryBoundarySiteDto[];

  @IsArray()
  @ArrayMaxSize(INVENTORY_DECLARATION_LIMITS.attribution)
  @IsObject({ each: true, message: ROW_MESSAGE })
  @ValidateNested({ each: true })
  @Type(() => InventoryAttributionPolicyDto)
  attribution!: readonly InventoryAttributionPolicyDto[];

  @IsArray()
  @ArrayMaxSize(INVENTORY_DECLARATION_LIMITS.applicability)
  @IsObject({ each: true, message: ROW_MESSAGE })
  @ValidateNested({ each: true })
  @Type(() => InventoryApplicabilityCellDto)
  applicability!: readonly InventoryApplicabilityCellDto[];

  @IsArray()
  @ArrayMaxSize(INVENTORY_DECLARATION_LIMITS.sources)
  @IsObject({ each: true, message: ROW_MESSAGE })
  @ValidateNested({ each: true })
  @Type(() => InventorySourceDto)
  sources!: readonly InventorySourceDto[];
}

/*
 * Parity with the contract. `implements` cannot hold a class to a union it
 * flattens, nor notice an optional member it forgot, so two checks per pair:
 * the class declares exactly the contract's keys, and every value of the
 * contract's type is one its fields accept. Either failing is a compile error.
 */
type KeysOf<T> = T extends unknown ? keyof T : never;
type SameKeys<Contract, Dto> =
  [Exclude<KeysOf<Contract>, keyof Dto>, Exclude<keyof Dto, KeysOf<Contract>>] extends [never, never] ? true : false;
type Accepts<Dto, Contract> = [Contract] extends [Dto] ? true : false;
const _parity: [
  SameKeys<ListInventoryBoundariesParams, ListInventoryBoundariesQueryDto>,
  SameKeys<CreateInventoryBoundaryRequest, CreateInventoryBoundaryDto>,
  SameKeys<InventoryBoundarySiteInput, InventoryBoundarySiteDto>,
  SameKeys<InventoryAttributionPolicyInput, InventoryAttributionPolicyDto>,
  SameKeys<InventoryApplicabilityCellInput, InventoryApplicabilityCellDto>,
  SameKeys<InventorySourceMappingInput, InventorySourceMappingDto>,
  SameKeys<InventorySourceInput, InventorySourceDto>,
  SameKeys<PutInventoryBoundarySubsidiaryRequest, PutInventoryBoundarySubsidiaryDto>,
  Accepts<InventoryApplicabilityCellDto, InventoryApplicabilityCellInput>,
  Accepts<InventorySourceMappingDto, InventorySourceMappingInput>,
  Accepts<InventorySourceDto, InventorySourceInput>,
  Accepts<PutInventoryBoundarySubsidiaryDto, PutInventoryBoundarySubsidiaryRequest>,
] = [true, true, true, true, true, true, true, true, true, true, true, true];
void _parity;
