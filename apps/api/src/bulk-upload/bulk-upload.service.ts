import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ActivityRecordStatus } from '@tonyai/db';
import {
  BULK_UPLOAD_ALLOWED_EXTENSIONS,
  BULK_UPLOAD_COLUMNS,
  BULK_UPLOAD_MAX_ROWS,
  BULK_UPLOAD_MAX_SIZE_BYTES,
  BULK_UPLOAD_MESSAGE_MAX_LENGTH,
  canonicalPeriodValue,
  isCalculated,
  isEvidenceRequired,
  type ActivityCalculationSnapshot,
  type BulkImportAuditDiff,
  type BulkUploadAcceptedRow,
  type BulkUploadColumn,
  type Category,
  type ReportingPeriod,
  type BulkUploadReportDTO,
  type BulkUploadRowIssue,
  mayAuthorRecords,
  recordActivityTypesFor,
} from '@tonyai/shared-types';
import {
  ActivityRecordsService,
} from '../activity-records/activity-records.service';
import {
  CreateRoleRefusedError,
  ActivityTypeSlotConflictError,
  DuplicateActivityRecordError,
  PeriodLockedError,
} from '../activity-records/errors';
import { FactorLibraryConflictError, NoEmissionFactorError } from '../calculations/errors';
import { CreateActivityRecordDto } from '../activity-records/dto/create-activity-record.dto';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { BatchFailureLog } from '../common/batch-failure-log';
import { quoteCallerText, sanitiseCallerText } from '../common/caller-text';
import { isFormulaLead } from '../common/csv-cell';
import { canonicalUuid } from '../common/parse-uuid-param.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { StorageIntentsService, type ObjectRef } from '../storage/storage-intents.service';
import { IMPORT_SOURCES_BUCKET } from '../storage/buckets';
import { BulkUploadOptionsDto } from './dto/bulk-upload-options.dto';
import { InaccessibleEntityError } from './errors';
import {
  extensionOf,
  parseRows,
  strictNumber,
  type ParsedRow,
} from './parse-rows';
import { buildTemplateWorkbook } from './template-workbook';

/**
 * The options `main.ts` installs on the global ValidationPipe. Reproduced
 * because that pipe does not run inside a loop.
 *
 * Defence in depth: `mapRow` builds the object from a fixed key list and the
 * header check refuses an unrecognised column, so no unknown field reaches
 * here today — these options keep that true if `mapRow` ever passes cells
 * through. Untested on purpose; nothing can reach the branch.
 */
const PIPE_OPTIONS = { whitelist: true, forbidNonWhitelisted: true } as const;

/**
 * NUL rather than a printable separator, so that no value can contain the
 * separator and make one row's key collide with another's.
 *
 * A collision is not constructible today — four segments are closed
 * vocabularies, `subsidiaryId` passed the access check, and a `locationId`
 * that is not an id is refused by its row's DTO — so this is untested on
 * purpose. It keeps the property true if a free-text segment is ever added.
 */
const KEY_SEPARATOR = '\u0000';

const COLUMN_NAMES = new Set<string>(BULK_UPLOAD_COLUMNS);

/**
 * How many entities the template's reference sheet will list, per table.
 *
 * Not a product rule — a bound on one synchronous request. Generous enough
 * that no realistic tenant meets it (the largest measured was 10,200 rows at
 * 274 KB), small enough that the route's own throttle (see
 * `bulk-upload.controller.ts`) cannot pin a replica with it.
 */
const TEMPLATE_ENTITY_LIMIT = 5000;

/** The private bucket an applied import's source file is kept in. */
export { IMPORT_SOURCES_BUCKET };

/**
 * How much of the caller's own text one audit row keeps. A refusal is quoted
 * so that the longest sentence it can build still fits `AUDIT_REASON_MAX_LENGTH`
 * (the bounds are in `parse-rows.ts`): a row cut here would store half a marker.
 */
const AUDIT_FILE_NAME_MAX_LENGTH = 255;
export const AUDIT_REASON_MAX_LENGTH = 500;

@Injectable()
export class BulkUploadService {
  private readonly logger = new Logger(BulkUploadService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly records: ActivityRecordsService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly intents: StorageIntentsService,
  ) {}

  /**
   * Import a CSV/XLSX of historical activity data.
   *
   * Synchronous and row-by-row through `ActivityRecordsService`, never a bulk
   * upsert: each row needs its own factor snapshot (immutable, and the reason
   * a historic figure can be reproduced years later), its own lifecycle gates
   * and its own audit row. A `createMany` would have none of those.
   *
   * **No transaction spans the batch**, deliberately — one could not, at this
   * row count — so a failure at row 400 leaves rows 1-399 written. That is why
   * the report lists accepted rows individually rather than counting them: a
   * partial import the caller cannot enumerate is a data-integrity incident.
   */
  async import(
    user: RequestUser,
    file: Express.Multer.File | undefined,
    options: BulkUploadOptionsDto,
  ): Promise<BulkUploadReportDTO> {
    const { dryRun } = options;
    // The DTO is what makes this a boolean over HTTP; this is what makes the
    // service refuse rather than guess for any other caller. The loop writes
    // records whenever `dryRun` is not truthy, so `''`, `0`, `null` or
    // `undefined` reaching it would mean an import nobody asked for.
    if (typeof dryRun !== 'boolean') {
      throw new BadRequestException('dryRun must be true or false.');
    }
    // Every refusal below this line is audited before it is thrown. The
    // batch row used to be written only after the loop, which meant the one
    // event most worth keeping — a user uploading a file naming another
    // tenant's subsidiaries, or a role that may not author records trying to
    // — left NO trace at all on an append-only compliance trail.
    const { rows, namedSubsidiaryIds } = await this.auditedRefusal(user, file, dryRun, async () => {
      // The role FIRST, before the file is parsed: enforced only inside the
      // loop, its 403 escaped the audited pre-flight, and a file whose every
      // row failed validation never reached it and got a 200 report back.
      // (Multer has already buffered the upload; its 413 fires before this.)
      this.assertMayImport(user);
      this.assertAcceptableFile(file);
      this.assertHasOrganisation(user);
      const upload = file as Express.Multer.File;
      const parsed = await parseRows(upload.buffer, upload.originalname);
      if (parsed.length === 0) {
        throw new BadRequestException('The file has no data rows.');
      }
      // The row cap is `parseRows`'s: it counts populated rows and throws
      // before this line, so a second check here could never fire.
      const named = await this.assertEveryEntityAccessible(
        user.accessibleSubsidiaryIds,
        parsed,
      );
      return { rows: parsed, namedSubsidiaryIds: named };
    });
    const upload = file as Express.Multer.File;

    const storedKeys = await this.loadStoredKeys(rows);
    // An APPLY gets a batch, created BEFORE the loop so every record can carry
    // its id. A dry run gets none: it must provably write nothing.
    const batchId = dryRun
      ? null
      : await this.openBatch(user, upload, rows.length, namedSubsidiaryIds);
    const seenInFile = new Set<string>();
    const accepted: BulkUploadAcceptedRow[] = [];
    const errors: BulkUploadRowIssue[] = [];
    const warnings: BulkUploadRowIssue[] = [];
    // Batch-scoped, never a field: see `BatchFailureLog`. It is what keeps the
    // unexpected branch to one log line per import instead of one per row.
    const unexpected = new BatchFailureLog('row');

    // The loop is wrapped so the batch's log line is written even when it
    // rethrows. The backstop below fires only while `accepted.length === 0`,
    // which is exactly the state a run of unexpected failures leaves behind —
    // so flushing on the way out rather than in a `finally` would drop the
    // incident most worth keeping, and silently.
    try {
      for (const parsed of rows) {
        try {
          await this.processRow(
            user,
            parsed,
            { dryRun, seenInFile, storedKeys, batchId },
            { accepted, errors, warnings },
          );
        } catch (error) {
          // A backstop now, not the gate: the role is refused in the audited
          // pre-flight above. One 403 beats a thousand identical "forbidden"
          // rows — but only while nothing has been accepted. After that it
          // would throw away the report of a partial import (no transaction
          // spans the batch) and skip the batch audit row below, so it is
          // reported on its own row like any other refusal.
          if (error instanceof CreateRoleRefusedError && accepted.length === 0) {
            throw error;
          }
          errors.push(this.toIssue(parsed.row, error, unexpected));
        }
      }
    } catch (error) {
      // The loop aborted (the role backstop): the batch says so rather than
      // staying `processing`. Records it did create are still linked to it.
      if (batchId) {
        await this.closeBatch(batchId, 'failed', accepted.length, errors.length);
      }
      throw error;
    } finally {
      // ONE line for the whole import, and only when something was unexpected.
      const failures = unexpected.entry();
      if (failures) {
        this.logger.error(`bulk import: ${failures.message}`, failures.trace);
      }
    }
    if (batchId) {
      await this.closeBatch(batchId, 'completed', accepted.length, errors.length);
    }

    // Written even on a dry run, and even when every row failed: `audit_log`
    // is append-only, and on an apply this row is the summary the per-record
    // rows cannot give.
    //
    // Caught rather than propagated, and this is the deliberate order of
    // precedence: by the time it runs, up to a thousand records are already
    // written and their OWN audit rows with them. Letting it throw would hand
    // the caller a 500 with no report — a partial import nobody can enumerate,
    // which is the exact failure this module's design exists to prevent.
    try {
      await this.recordBatch(
        user,
        this.batchDiff(upload, dryRun, {
          totalRows: rows.length,
          acceptedCount: accepted.length,
          rejectedCount: errors.length,
          ...(batchId ? { batchId } : {}),
        }),
        batchId,
      );
    } catch (error) {
      this.logger.error(
        `bulk import batch audit row failed to write (${accepted.length} records were created)`,
        error instanceof Error ? error.stack : String(error),
      );
    }

    return {
      dryRun,
      fileName: this.shownFileName(upload),
      sizeBytes: upload.size,
      totalRows: rows.length,
      accepted,
      errors: errors.map((issue) => this.bounded(issue)),
      warnings: warnings.map((issue) => this.bounded(issue)),
      batchId,
    };
  }

  /**
   * The downloadable import template, built for what THIS caller can reach.
   *
   * Tenant-scoped like everything else: the reference sheet lists the
   * subsidiaries in `accessibleSubsidiaryIds` and their locations, and nothing
   * else — the template is how a user learns which entity ids exist, so
   * building it from an unscoped query would hand one tenant another's
   * register.
   *
   * No role gate. Downloading it writes nothing and discloses nothing a
   * `GET /subsidiaries` does not already return to every role — verified field
   * by field: both of those endpoints return a strict superset, and neither
   * carries a role gate.
   *
   * The `select` below is the load-bearing part of that claim. It deliberately
   * omits every personal-data column the two entities carry —
   * `designatedPerson`, `contactEmail`, `contactPhone`, `authorizedPerson`,
   * `address` — because this artifact is a file people email around, and
   * `audit_log` is not where a KVKK/GDPR erasure request can reach it. Adding
   * a reporting contact here for convenience would silently reclassify the
   * download; if that ever happens, this route needs a role gate and an audit
   * row, in the class `reports/` already sits in.
   */
  async template(user: RequestUser): Promise<Buffer> {
    const [subsidiaries, locations] = await Promise.all([
      this.prisma.subsidiary.findMany({
        where: { id: { in: user.accessibleSubsidiaryIds } },
        select: {
          id: true,
          legalName: true,
          tradingName: true,
          geographyCode: true,
        },
        orderBy: { legalName: 'asc' },
        take: TEMPLATE_ENTITY_LIMIT,
      }),
      this.prisma.location.findMany({
        where: { subsidiaryId: { in: user.accessibleSubsidiaryIds } },
        select: {
          id: true,
          subsidiaryId: true,
          name: true,
          geographyCode: true,
        },
        orderBy: { name: 'asc' },
        // Bounded: measured at 10,000 locations the build is 169 ms and 46 MB,
        // and this route is throttled per user (see the controller). The cap keeps the worst
        // case off a shared replica; the sheet says when it has bitten, which
        // is the part that must never be silent — a register that quietly
        // omits a site is worse than one that admits it is truncated.
        take: TEMPLATE_ENTITY_LIMIT,
      }),
    ]);
    return buildTemplateWorkbook({
      subsidiaries,
      locations,
      truncated:
        subsidiaries.length === TEMPLATE_ENTITY_LIMIT ||
        locations.length === TEMPLATE_ENTITY_LIMIT,
    });
  }

  // -- one row ---------------------------------------------------------------

  private async processRow(
    user: RequestUser,
    parsed: ParsedRow,
    context: {
      dryRun: boolean;
      seenInFile: Set<string>;
      storedKeys: Set<string>;
      batchId: string | null;
    },
    out: {
      accepted: BulkUploadAcceptedRow[];
      errors: BulkUploadRowIssue[];
      warnings: BulkUploadRowIssue[];
    },
  ): Promise<void> {
    const { row, cells } = parsed;
    // A row's warnings are published only together with the row itself: they
    // describe a row that is, or would be, imported — which is what the
    // contract's warning codes already say they are. Pushed eagerly, a refused
    // row carried "needs an evidence file before it can be submitted", and the
    // verdict told a user importing one row of ten that five rows needed
    // attention (measured).
    const rowWarnings: BulkUploadRowIssue[] = [];

    // FLAG, never neutralise and never refuse. Prefixing an apostrophe on the
    // way IN would store it, re-neutralise it on the next export and corrupt
    // the user's text permanently; refusing would reject "-15% after a line
    // shutdown", which leads with `-` and is an ordinary variance reason.
    // There is no rendering context on ingest, so the value is inert here.
    if (isFormulaLead(cells.varianceReason ?? '')) {
      rowWarnings.push({
        row,
        column: 'varianceReason',
        code: 'formula_lead',
        message:
          'This reason starts with a character a spreadsheet reads as a formula. It is stored exactly as written and neutralised on export.',
      });
    }

    const mapped = this.mapRow(cells);
    if ('issue' in mapped) {
      out.errors.push({ row, ...mapped.issue });
      return;
    }

    const dto = plainToInstance(CreateActivityRecordDto, mapped.dto);
    const failures = validateSync(dto as object, PIPE_OPTIONS);
    if (failures.length > 0) {
      const first = failures[0];
      out.errors.push({
        row,
        column: this.asColumn(first.property),
        code: 'invalid',
        message:
          Object.values(first.constraints ?? {})[0] ??
          `${first.property} is not valid.`,
      });
      return;
    }

    // LP3-03, owner decision (b) of 2026-10-04: a file cannot carry an
    // activity type until LP4-02's contract change adds the column, so a row in
    // a typed category (Fuel, Mobile Combustion, Refrigerants) is refused as the
    // record service would refuse it (`activity_type_required`) — HERE, before
    // the duplicate check, which would otherwise answer for it ("edit the
    // existing record") about a row that could never be written.
    const activityType = dto.activityType ?? null;
    const types = recordActivityTypesFor(dto.category);
    if (types.length > 0 && activityType === null) {
      out.errors.push({
        row,
        column: this.asColumn('category'),
        code: 'invalid',
        message:
          `A ${dto.category} record must name its activity type (${types.map((t) => t.value).join(', ')}), ` +
          `and a bulk file cannot carry one yet. Enter ${dto.category} rows on Data Entry.`,
      });
      return;
    }

    // The canonical spelling IS the slot's identity. When the value names no
    // period of this granularity the duplicate check is meaningless, so it is
    // skipped and the service raises the 400 it already raises for everyone.
    const canonical = canonicalPeriodValue(dto.reportingPeriod, dto.periodValue);
    if (canonical !== null) {
      const key = this.slotKey(
        dto.subsidiaryId,
        dto.locationId ?? null,
        dto.reportingYear,
        dto.reportingPeriod,
        canonical,
        dto.category,
        activityType,
      );
      if (context.seenInFile.has(key)) {
        out.errors.push({
          row,
          column: null,
          code: 'duplicate_in_file',
          message:
            'Another row in this file already reports this entity, period and category.',
        });
        return;
      }
      context.seenInFile.add(key);
      if (context.storedKeys.has(key)) {
        out.errors.push({
          row,
          column: null,
          code: 'duplicate_existing',
          message:
            'A record already exists for this entity, period and category. Edit it instead of importing it again.',
        });
        return;
      }
    }

    // Free to know, and the other half of "can this row ever be submitted?".
    // `submit` refuses these categories without an attached file, and bulk
    // upload cannot attach one — so a user importing 500 electricity rows
    // would otherwise see no warnings at all and meet the wall later.
    if (isEvidenceRequired(dto.category)) {
      rowWarnings.push({
        row,
        column: 'category',
        code: 'evidence_required',
        message: `${dto.category} records need an evidence file before they can be submitted for review, and a bulk import cannot attach one.`,
      });
    }

    if (context.dryRun) {
      const preview = await this.records.previewCreate(user, dto);
      this.warnIfUnsubmittable(
        row,
        preview.verdict.anomalous,
        dto.varianceReason,
        rowWarnings,
      );
      out.accepted.push({
        row,
        recordId: null,
        ...this.identityOf(dto, preview.periodValue),
        tCo2e: this.figureOf(preview.calculation),
        anomalous: preview.verdict.anomalous,
      });
      out.warnings.push(...rowWarnings);
      return;
    }

    const created = await this.records.create(
      user,
      dto,
      context.batchId ? { importBatchId: context.batchId } : undefined,
    );
    this.warnIfUnsubmittable(
      row,
      created.anomalyFlag,
      created.varianceReason,
      rowWarnings,
    );
    out.accepted.push({
      row,
      recordId: created.id,
      ...this.identityOf(dto, created.periodValue),
      tCo2e: this.figureOf(created.calculation),
      anomalous: created.anomalyFlag,
    });
    out.warnings.push(...rowWarnings);
  }

  /**
   * The one thing a dry run can say that a validation pass cannot.
   *
   * An anomalous figure with no variance reason imports perfectly well and can
   * then never be submitted — `submit` requires the explanation and
   * re-evaluates the verdict. Without this warning a user imports a thousand
   * rows and finds out half are stuck only when they try to send them for
   * review.
   */
  private warnIfUnsubmittable(
    row: number,
    anomalous: boolean,
    varianceReason: string | null | undefined,
    warnings: BulkUploadRowIssue[],
  ): void {
    if (!anomalous || varianceReason?.trim()) return;
    warnings.push({
      row,
      column: 'varianceReason',
      code: 'would_block_submit',
      message:
        'This figure deviates from its baseline and carries no variance reason, so it cannot be submitted for review until one is added.',
    });
  }

  // -- batch pre-flight ------------------------------------------------------

  /**
   * The rule the record service applies to every write, thrown as the class
   * it throws — checked here as well so that the refusal happens inside
   * `auditedRefusal`, before the file is read, rather than from inside the
   * loop.
   */
  private assertMayImport(user: RequestUser): void {
    if (!mayAuthorRecords(user)) {
      throw new CreateRoleRefusedError();
    }
  }

  /**
   * A batch belongs to an organisation. A caller with none cannot author
   * records in the first place; refused here, as a role refusal, so the batch
   * never has to hold a null owner.
   */
  private assertHasOrganisation(user: RequestUser): void {
    if (!user.organisationId) throw new CreateRoleRefusedError();
  }

  private assertAcceptableFile(file: Express.Multer.File | undefined): void {
    if (!file) throw new BadRequestException('No file was uploaded.');
    // Defence in depth, and unreachable over HTTP: multer's own
    // `limits.fileSize` fires first and Nest turns it into a 413. Kept because
    // this service is also called from the spec, and because a future caller
    // that skips the interceptor would otherwise have no size rule at all.
    if (file.size > BULK_UPLOAD_MAX_SIZE_BYTES) {
      throw new BadRequestException(
        `The file is larger than the ${Math.round(
          BULK_UPLOAD_MAX_SIZE_BYTES / 1024 / 1024,
        )} MB limit.`,
      );
    }
    const extension = extensionOf(file.originalname ?? '');
    const extensionOk =
      extension !== null &&
      (BULK_UPLOAD_ALLOWED_EXTENSIONS as readonly string[]).includes(extension);
    // The EXTENSION is the gate, and the declared MIME type is not consulted.
    // It is client-controlled, so it buys no security; and browsers disagree
    // about spreadsheets — Windows sends `.csv` as `application/vnd.ms-excel`
    // and sometimes `application/octet-stream` — so requiring an exact match
    // refuses an ordinary "Save as CSV". A renamed file gets as far as the
    // parser, which is what actually refuses something that is not a
    // spreadsheet.
    if (!extensionOk) {
      throw new BadRequestException(
        `Upload a ${BULK_UPLOAD_ALLOWED_EXTENSIONS.join(' or ')} file.`,
      );
    }
  }

  /**
   * A file naming an entity this user cannot reach — a subsidiary, or a
   * location of a subsidiary they cannot reach — is refused WHOLE.
   *
   * Not a row error, deliberately: ids come from a generated template, so a
   * foreign id means the wrong file — the wrong tenant's export, or the wrong
   * template — and importing the 900 rows that happen to match would be a
   * worse outcome than refusing all 1,000. The offending ROW NUMBERS are named
   * because the user needs them; the ids disclose nothing a single create does
   * not, since an inaccessible id and a non-existent one are indistinguishable
   * here exactly as they are there.
   */
  private async assertEveryEntityAccessible(
    accessibleSubsidiaryIds: string[],
    rows: ParsedRow[],
  ): Promise<string[]> {
    // The guard's ids are what Prisma returned — lowercase — and
    // `canonicalUuid` lowercases the cell, so this compares like with like.
    // Only a cell that IS an id can name a foreign entity. A blank one is a
    // missing value, and one in any other spelling is refused as `invalid` on
    // its own row by the DTO — refusing the whole file for a typo told the
    // user their entity "does not exist or is not yours".
    const accessible = new Set(accessibleSubsidiaryIds);
    const locationIds = [
      ...new Set(
        rows
          .map((r) => canonicalUuid(r.cells.locationId.trim()))
          .filter((id): id is string => id !== null),
      ),
    ];
    // Scoped by the access set, so a location of another tenant and one that
    // does not exist are both simply absent — the same refusal, no oracle.
    const reachable =
      locationIds.length === 0
        ? []
        : await this.prisma.location.findMany({
            where: { id: { in: locationIds }, subsidiaryId: { in: accessibleSubsidiaryIds } },
            select: { id: true, subsidiaryId: true },
          });
    const locationOwner = new Map(reachable.map((l) => [l.id, l.subsidiaryId]));

    const offending: number[] = [];
    const named = new Set<string>();
    for (const r of rows) {
      const subsidiaryId = canonicalUuid(r.cells.subsidiaryId.trim());
      const locationId = canonicalUuid(r.cells.locationId.trim());
      const foreignSubsidiary = subsidiaryId !== null && !accessible.has(subsidiaryId);
      const foreignLocation = locationId !== null && !locationOwner.has(locationId);
      if (foreignSubsidiary || foreignLocation) {
        offending.push(r.row);
        continue;
      }
      if (subsidiaryId !== null) named.add(subsidiaryId);
      if (locationId !== null) named.add(locationOwner.get(locationId) as string);
    }
    if (offending.length === 0) return [...named].sort();
    const shown = offending.slice(0, 10).join(', ');
    const suffix =
      offending.length > 10 ? ` (+${offending.length - 10} more)` : '';
    // The reason only. The consequence is the client's to state: the panel
    // prints "Nothing was imported." under EVERY whole-file refusal.
    throw new InaccessibleEntityError(
      `Row(s) ${shown}${suffix} name a reporting entity that does not exist or is not yours.`,
    );
  }

  /**
   * Every reporting slot already taken, for the entities and years this file
   * touches — one query, not one per row.
   *
   * `voided` is excluded because the uniqueness index excludes it
   * (`WHERE status <> 'voided'`): a withdrawn figure does not hold its slot,
   * and treating it as if it did would refuse the restatement meant to replace
   * it.
   *
   * This exists because the preview CANNOT see a conflict — Postgres raises it
   * on the insert — so without it a dry run reports a thousand clean rows and
   * the apply comes back with conflicts.
   *
   * Both sides of the comparison are lowercase: Prisma returns the stored
   * spelling of a `uuid` column, the query below asks by `canonicalUuid` of
   * the cell, and the in-file key is built from the DTO, whose transform
   * lowercases the id.
   */
  private async loadStoredKeys(rows: ParsedRow[]): Promise<Set<string>> {
    const subsidiaryIds = [
      ...new Set(
        rows
          .map((r) => canonicalUuid(r.cells.subsidiaryId.trim()))
          // Only ids. A blank or misspelt cell is refused on its own row by
          // the DTO; sent to Postgres it is not a uuid, and this query runs
          // OUTSIDE every catch — one such cell raised P2023 and came back as
          // a 500 with no report. Every id here already passed the access
          // check in the pre-flight.
          .filter((id): id is string => id !== null),
      ),
    ];
    const years = [
      ...new Set(
        rows
          .map((r) => strictNumber(r.cells.reportingYear))
          // Clamped to the DTO's own range before it reaches Prisma. This
          // query runs OUTSIDE the per-row try/catch, and `strictNumber`
          // accepts any digit string, so `99999999999` used to surface as a
          // ConversionError -> 500 with no report and no audit row, from one
          // cell in one row. Out-of-range years simply match nothing, and the
          // DTO refuses them as `invalid` on their own row.
          .filter(
            (y): y is number =>
              y !== null && Number.isInteger(y) && y >= 2000 && y <= 2100,
          ),
      ),
    ];
    if (subsidiaryIds.length === 0 || years.length === 0) return new Set();

    const stored = await this.prisma.activityRecord.findMany({
      where: {
        subsidiaryId: { in: subsidiaryIds },
        reportingYear: { in: years },
        status: { not: ActivityRecordStatus.voided },
      },
      select: {
        subsidiaryId: true,
        locationId: true,
        reportingYear: true,
        reportingPeriod: true,
        periodValue: true,
        category: true,
        activityType: true,
      },
      // The two `IN` lists are a cross-product: a 1,000-row file naming many
      // entities and many years matches far more (entity, year) combinations
      // than the 1,000 slots it actually claims. Bounded so one cheap request
      // cannot pull a tenant's whole history into memory once real history
      // lands. Overflow only costs a false-negative pre-check — the insert
      // still refuses the duplicate.
      take: BULK_UPLOAD_MAX_ROWS * 10,
    });
    return new Set(
      stored.map((r) =>
        this.slotKey(
          r.subsidiaryId,
          r.locationId,
          r.reportingYear,
          r.reportingPeriod,
          r.periodValue,
          r.category,
          r.activityType,
        ),
      ),
    );
  }

  // -- audit -----------------------------------------------------------------

  /**
   * Run the pre-flight, and if it refuses for a reason that says something
   * about the CALLER, write the refusal down before the exception leaves.
   *
   * `audit_log` is append-only and has no correction path, which is exactly why
   * the events worth keeping are the ones nobody chose to record: a file naming
   * another tenant's subsidiaries, a role that may not author records. Those
   * are written under `bulk_import` with `refused: true`. A malformed file — an
   * unrecognised header, a wrong extension, an empty one, too many rows, one
   * whose bytes are not UTF-8 (the byte cap is multer's, before any of this
   * runs) — is a 400 that touched
   * nothing and says nothing about the caller. Auditing those filled the
   * trail with caller-controlled text at the throttle's rate (measured: 37
   * audit rows for 5 records), so they are refused and not recorded.
   */
  private async auditedRefusal<T>(
    user: RequestUser,
    file: Express.Multer.File | undefined,
    dryRun: boolean,
    preflight: () => Promise<T>,
  ): Promise<T> {
    try {
      return await preflight();
    } catch (error) {
      if (!this.isAuditedRefusal(error)) throw error;
      try {
        await this.recordBatch(
          user,
          this.batchDiff(file, dryRun, {
            refused: true,
            // The two audited reasons are a constant and "Row(s) N, M …" —
            // no caller text today. Cleaned and bounded anyway, like the
            // filename, so a future refusal that quotes a cell cannot reach
            // the row raw.
            reason: sanitiseCallerText(
              error instanceof Error ? error.message : 'unknown',
              AUDIT_REASON_MAX_LENGTH,
            ),
          }),
        );
      } catch (auditError) {
        // Never let the bookkeeping replace the user's actual error.
        this.logger.error(
          'bulk import refusal could not be audited',
          auditError instanceof Error ? auditError.stack : String(auditError),
        );
      }
      throw error;
    }
  }

  /**
   * The two refusals that are about the caller rather than about the file.
   */
  private isAuditedRefusal(error: unknown): boolean {
    return (
      error instanceof CreateRoleRefusedError ||
      error instanceof InaccessibleEntityError
    );
  }

  /**
   * Write one batch row. No retry: both callers swallow a failed write by
   * design — the bookkeeping must never replace the user's answer — and log
   * it, so a write that fails is a bug to see there, not to write around.
   */
  private async recordBatch(
    user: RequestUser,
    diff: BulkImportAuditDiff,
    batchId: string | null = null,
  ): Promise<void> {
    await this.audit.record(user, {
      action: 'bulk_import',
      // An apply points at the batch it created; a dry run or a refusal has
      // no batch and no single entity (the `report` rows' precedent).
      ...(batchId
        ? { entity: 'import_batch', entityId: batchId }
        : { entity: 'activity_record', entityId: null }),
      diff,
    });
  }

  // -- batch -------------------------------------------------------------------

  /**
   * Keep the source file, then create the batch row — before any record, so
   * each can carry the id. The file goes first: if the row cannot be written
   * the object is removed and the request fails before a single record exists;
   * the other order could leave a batch claiming a file that is not there.
   * The key holds no part of the caller's file name (it can carry personal
   * data); the name lives on the row and rides on the download URL.
   *
   * The same recoverable protocol as an evidence upload (LP1-02): an `upload`
   * intent commits before the bytes go up and the batch row's transaction
   * adopts it, so a failure at any step leaves an intent the sweeper finishes
   * — never an unlogged object (the removal used to be a swallowed
   * `.catch(() => undefined)`). Retention is D21's: kept while the tenant is
   * active, no user delete; offboarding deletes it (LP4-01).
   */
  private async openBatch(
    user: RequestUser,
    upload: Express.Multer.File,
    totalRows: number,
    subsidiaryIds: string[],
  ): Promise<string> {
    const id = randomUUID();
    const format = extensionOf(upload.originalname ?? '') === '.xlsx' ? 'xlsx' : 'csv';
    const storagePath = `${user.organisationId}/${id}/source.${format}`;
    const ref: ObjectRef = { bucket: IMPORT_SOURCES_BUCKET, path: storagePath };
    const intentId = await this.intents.beginUpload(ref, {
      reason: 'import.source',
      organisationId: user.organisationId,
    });
    try {
      await this.storage.upload(
        IMPORT_SOURCES_BUCKET,
        storagePath,
        upload.buffer,
        format === 'xlsx'
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'text/csv',
      );
    } catch (error) {
      await this.intents.abandonUpload(intentId, ref, error, { organisationId: user.organisationId });
      throw error;
    }
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.intents.adoptUpload(tx, intentId);
        await tx.importBatch.create({
          data: {
            id,
            organisationId: user.organisationId as string,
            uploadedBy: user.id,
            subsidiaryIds,
            fileName: this.shownFileName(upload),
            fileFormat: format,
            sizeBytes: upload.size,
            sha256: createHash('sha256').update(upload.buffer).digest('hex'),
            storagePath,
            totalRows,
          },
        });
      });
    } catch (error) {
      await this.intents.abandonUpload(intentId, ref, error, { organisationId: user.organisationId });
      throw error;
    }
    return id;
  }

  /**
   * Record how the batch ended. A failure here is logged, never thrown: the
   * records are written, and the batch staying `processing` is the honest
   * "interrupted" state its readers already handle.
   */
  private async closeBatch(
    id: string,
    status: 'completed' | 'failed',
    acceptedCount: number,
    rejectedCount: number,
  ): Promise<void> {
    try {
      await this.prisma.importBatch.update({
        where: { id },
        data: { status, acceptedCount, rejectedCount, completedAt: new Date() },
      });
    } catch (error) {
      this.logger.error(
        `import batch ${id} could not be closed as ${status}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * What goes in the audit row's `diff`.
   *
   * The filename is bounded. It is caller-controlled (busboy allows ~16 KB in
   * a part header), it routinely carries a person's name, and `audit_log` has
   * no delete path — so an unbounded one is un-erasable personal data under
   * KVKK/GDPR, sized by the uploader.
   */
  private batchDiff(
    file: Express.Multer.File | undefined,
    dryRun: boolean,
    outcome:
      | { refused: true; reason: string }
      | {
          totalRows: number;
          acceptedCount: number;
          rejectedCount: number;
          batchId?: string;
        },
  ): BulkImportAuditDiff {
    return {
      bulk: true,
      dryRun,
      fileName: this.shownFileName(file),
      sizeBytes: file?.size ?? 0,
      ...outcome,
    };
  }

  /**
   * The upload's name as the API repeats it, by ONE rule for both of its
   * readers: the report the import panel renders, and the audit row.
   */
  private shownFileName(file: Express.Multer.File | undefined): string {
    return sanitiseCallerText(file?.originalname, AUDIT_FILE_NAME_MAX_LENGTH);
  }

  /**
   * An issue as the report carries it: its sentence cleaned and bounded by the
   * caller-text rule, whoever wrote the sentence. A sentence that quotes a
   * value quotes it at its source (`quoteCallerText`); this bounds the ones
   * other services wrote and `toIssue` passes through verbatim — the calc
   * engine's unit sentences among them. It runs on the finished lists, after
   * each failure has been classified. Warnings go through it too, though all
   * of them are fixed text today: untested on purpose, it keeps the property
   * true if a warning ever quotes a cell.
   */
  private bounded(issue: BulkUploadRowIssue): BulkUploadRowIssue {
    return {
      ...issue,
      message: sanitiseCallerText(
        issue.message,
        BULK_UPLOAD_MESSAGE_MAX_LENGTH,
        '…',
      ),
    };
  }

  // -- helpers ---------------------------------------------------------------

  /**
   * What the row IS, for a client that has to render a preview.
   *
   * `periodValue` is the server's canonical spelling rather than the file's, so
   * the preview shows what will actually be stored — a file writing
   * `" JANUARY "` lands as `January`, and a preview echoing the input would
   * quietly disagree with the record.
   *
   * The two ids are lowercase for the same reason — a file naming a site
   * `A0EE…` gets back the `a0ee…` the record holds.
   */
  private identityOf(
    dto: CreateActivityRecordDto,
    canonicalPeriod: string,
  ): {
    subsidiaryId: string;
    locationId: string | null;
    reportingYear: number;
    reportingPeriod: ReportingPeriod;
    periodValue: string;
    category: Category;
  } {
    return {
      subsidiaryId: dto.subsidiaryId,
      locationId: dto.locationId ?? null,
      reportingYear: dto.reportingYear,
      reportingPeriod: dto.reportingPeriod,
      periodValue: canonicalPeriod,
      category: dto.category,
    };
  }

  /**
   * The seven columns of the `NULLS NOT DISTINCT` uniqueness index, in order
   * — the activity type last (LP3-03), NULL as the empty segment, which no
   * activity type can be.
   *
   * A formatter, deliberately: every segment must arrive in the spelling the
   * database stores, because that is what the index compares. Both feeds
   * already do — the file's ids through the DTO's `lowercaseUuid` and its
   * `periodValue` through `canonicalPeriodValue`, the stored rows straight
   * from Prisma. Canonicalising again HERE would make the dedupe pass even
   * if the boundary regressed, which is exactly the coverage the specs would
   * then stop giving.
   */
  private slotKey(
    subsidiaryId: string,
    locationId: string | null,
    reportingYear: number,
    reportingPeriod: string,
    periodValue: string,
    category: string,
    activityType: string | null,
  ): string {
    return [
      subsidiaryId,
      locationId ?? '',
      String(reportingYear),
      reportingPeriod,
      periodValue,
      category,
      activityType ?? '',
    ].join(KEY_SEPARATOR);
  }

  /**
   * Cells to a DTO shape, with the numeric parse done HERE.
   *
   * Not via `@Type(() => Number)` on the DTO: that would fix the CSV case by
   * breaking the live HTTP one, where it turns `''`, `null` and `[]` into `0`
   * — a blank consumption cell silently becoming a reported zero.
   *
   * Both refusals quote the cell through `quoteCallerText`, never whole. One
   * XLSX shared string can back this cell on every row, and a blank entity id
   * does not stop a row getting this far: a thousand rows quoting one
   * 32,000-character string made a 32,092,008-byte report (measured).
   */
  private mapRow(
    cells: Record<BulkUploadColumn, string>,
  ):
    | { dto: Record<string, unknown> }
    | { issue: Omit<BulkUploadRowIssue, 'row'> } {
    const reportingYear = strictNumber(cells.reportingYear);
    if (reportingYear === null) {
      return {
        issue: {
          column: 'reportingYear',
          code: 'invalid',
          message: `"${quoteCallerText(cells.reportingYear)}" is not a whole year.`,
        },
      };
    }
    const activityValue = strictNumber(cells.activityValue);
    if (activityValue === null) {
      return {
        issue: {
          column: 'activityValue',
          code: 'invalid',
          message: `"${quoteCallerText(cells.activityValue)}" is not a number. Use a plain figure with no thousands separator.`,
        },
      };
    }
    const locationId = cells.locationId.trim();
    const varianceReason = cells.varianceReason.trim();
    return {
      dto: {
        subsidiaryId: cells.subsidiaryId.trim(),
        // Blank means the whole company, which is a real reporting entity —
        // not a missing value.
        ...(locationId === '' ? {} : { locationId }),
        reportingYear,
        reportingPeriod: cells.reportingPeriod.trim(),
        periodValue: cells.periodValue.trim(),
        category: cells.category.trim(),
        activityValue,
        activityUnit: cells.activityUnit.trim(),
        ...(varianceReason === '' ? {} : { varianceReason }),
      },
    };
  }

  private figureOf(calculation: ActivityCalculationSnapshot): number | null {
    // `null`, never 0: a category tracked but not calculated (Water) has no
    // figure, and 0 is a reported quantity.
    return isCalculated(calculation) ? calculation.tCo2e : null;
  }

  private asColumn(property: string): BulkUploadColumn | null {
    return COLUMN_NAMES.has(property) ? (property as BulkUploadColumn) : null;
  }

  /**
   * One row issue per failure, classified by the exception's CLASS.
   *
   * The record service throws typed refusals (`activity-records/errors.ts`,
   * `calculations/errors.ts`); this reads none of their sentences, so a
   * reworded one cannot turn a duplicate into a locked period.
   */
  private toIssue(
    row: number,
    error: unknown,
    unexpected: BatchFailureLog,
  ): BulkUploadRowIssue {
    // By CLASS, never by sentence. A `ConflictException` that is neither a
    // duplicate nor a lock falls through to `unexpected` and is logged as
    // one; any other `NotFoundException` is the record service saying the
    // row's entity is not this caller's to name.
    // Every coverage refusal is a `NoEmissionFactorError`, whatever its code
    // (`placeholder_refused`, `no_conversion`, …): the issue codes are an
    // exhaustive map on the web, so the sentence says which. A factor library
    // contradicting itself (`ambiguous_factor`, `factor_scope_mismatch`) is the
    // same answer to the uploader — this row cannot be priced yet — and a known
    // refusal, not an unexpected failure.
    if (error instanceof NoEmissionFactorError || error instanceof FactorLibraryConflictError) {
      return { row, column: null, code: 'no_factor', message: error.message };
    }
    if (error instanceof NotFoundException) {
      return {
        row,
        column: null,
        code: 'not_found',
        message:
          'The reporting entity on this row does not exist or is not yours.',
      };
    }
    if (error instanceof DuplicateActivityRecordError || error instanceof ActivityTypeSlotConflictError) {
      return {
        row,
        column: null,
        code: 'duplicate_existing',
        message: error.message,
      };
    }
    if (error instanceof PeriodLockedError) {
      return { row, column: null, code: 'period_locked', message: error.message };
    }
    if (error instanceof BadRequestException) {
      const response = error.getResponse();
      const message =
        typeof response === 'string'
          ? response
          : ((response as { message?: string | string[] }).message ??
            error.message);
      return {
        row,
        column: null,
        code: 'invalid',
        message: Array.isArray(message) ? message.join('; ') : String(message),
      };
    }
    // Never the raw error text — it can carry a query, a path or a column the
    // caller has no business seeing. Folded into the batch's one log line,
    // reported as a refusal.
    unexpected.add(row, error);
    return {
      row,
      column: null,
      code: 'unexpected',
      message: 'This row could not be imported. It was not written.',
    };
  }
}
