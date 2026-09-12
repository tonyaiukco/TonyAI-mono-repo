import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ActivityRecordStatus } from '@tonyai/db';
import {
  BULK_UPLOAD_ALLOWED_EXTENSIONS,
  BULK_UPLOAD_COLUMNS,
  BULK_UPLOAD_MAX_ROWS,
  BULK_UPLOAD_MAX_SIZE_BYTES,
  canonicalPeriodValue,
  isCalculated,
  isEvidenceRequired,
  type ActivityCalculationSnapshot,
  type BulkUploadAcceptedRow,
  type BulkUploadColumn,
  type Category,
  type ReportingPeriod,
  type BulkUploadReportDTO,
  type BulkUploadRowIssue,
} from '@tonyai/shared-types';
import {
  ActivityRecordsService,
  DUPLICATE_RECORD_MESSAGE,
} from '../activity-records/activity-records.service';
import { CreateActivityRecordDto } from '../activity-records/dto/create-activity-record.dto';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { isFormulaLead } from '../common/csv-cell';
import { PrismaService } from '../prisma/prisma.service';
import { BulkUploadOptionsDto } from './dto/bulk-upload-options.dto';
import {
  extensionOf,
  parseRows,
  strictNumber,
  type ParsedRow,
} from './parse-rows';

/**
 * The options `main.ts` installs on the global ValidationPipe. Reproduced
 * because that pipe does not run inside a loop.
 *
 * Defence in depth rather than the live control: `mapRow` builds the object
 * from a fixed key list, and the header check refuses an unrecognised column
 * before that — so no unknown field is reachable here today. These options are
 * what keeps that true if `mapRow` ever learns to pass cells through. (There
 * is deliberately no test for it: nothing can currently reach the branch, and
 * a spec asserting otherwise would be asserting coverage that does not exist.)
 */
const PIPE_OPTIONS = { whitelist: true, forbidNonWhitelisted: true } as const;

/**
 * NUL rather than a printable separator, so that no value can contain the
 * separator and make one row's key collide with another's.
 *
 * Honest about its reach: a collision is not constructible today. Four of the
 * six segments come from closed vocabularies, `subsidiaryId` is checked against
 * the access set first, and every segment is required — so `locationId` is the
 * only attacker-influenced part and there is nothing for it to forge itself
 * into. There is deliberately no test for a forged key: nothing can currently
 * reach that state, and a spec asserting otherwise would assert coverage that
 * does not exist. The separator is here so the property stays true if a
 * free-text segment is ever added.
 */
const KEY_SEPARATOR = '\u0000';

const COLUMN_NAMES = new Set<string>(BULK_UPLOAD_COLUMNS);

@Injectable()
export class BulkUploadService {
  private readonly logger = new Logger(BulkUploadService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly records: ActivityRecordsService,
    private readonly audit: AuditService,
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
    // Every refusal below this line is audited before it is thrown. The
    // batch row used to be written only after the loop, which meant the one
    // event most worth keeping — a user uploading a file naming another
    // tenant's subsidiaries, or a role that may not author records trying to
    // — left NO trace at all on an append-only compliance trail.
    const rows = await this.auditedRefusal(user, file, dryRun, async () => {
      this.assertAcceptableFile(file);
      const upload = file as Express.Multer.File;
      const parsed = await parseRows(upload.buffer, upload.originalname);
      if (parsed.length === 0) {
        throw new BadRequestException('The file has no data rows.');
      }
      if (parsed.length > BULK_UPLOAD_MAX_ROWS) {
        throw new BadRequestException(
          `The file has ${parsed.length} rows; the limit is ${BULK_UPLOAD_MAX_ROWS}. Split it and upload the parts.`,
        );
      }
      this.assertEveryEntityAccessible(user.accessibleSubsidiaryIds, parsed);
      return parsed;
    });
    const upload = file as Express.Multer.File;

    const storedKeys = await this.loadStoredKeys(rows);
    const seenInFile = new Set<string>();
    const accepted: BulkUploadAcceptedRow[] = [];
    const errors: BulkUploadRowIssue[] = [];
    const warnings: BulkUploadRowIssue[] = [];

    for (const parsed of rows) {
      try {
        await this.processRow(
          user,
          parsed,
          { dryRun, seenInFile, storedKeys },
          { accepted, errors, warnings },
        );
      } catch (error) {
        // A role that may not author records cannot become one mid-file, so
        // this can only fire on the first row, before anything is written —
        // and a thousand identical "forbidden" entries would be a worse answer
        // than one 403.
        if (error instanceof ForbiddenException) throw error;
        errors.push(this.toIssue(parsed.row, error));
      }
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
      await this.audit.record(user, {
        action: 'create',
        entity: 'activity_record',
        // No single entity — the `report` rows set the precedent for this shape.
        entityId: null,
        diff: this.batchDiff(upload, dryRun, {
          totalRows: rows.length,
          acceptedCount: accepted.length,
          rejectedCount: errors.length,
        }),
      });
    } catch (error) {
      this.logger.error(
        `bulk import batch audit row failed to write (${accepted.length} records were created)`,
        error instanceof Error ? error.stack : String(error),
      );
    }

    return {
      dryRun,
      fileName: upload.originalname,
      sizeBytes: upload.size,
      totalRows: rows.length,
      accepted,
      errors,
      warnings,
    };
  }

  // -- one row ---------------------------------------------------------------

  private async processRow(
    user: RequestUser,
    parsed: ParsedRow,
    context: {
      dryRun: boolean;
      seenInFile: Set<string>;
      storedKeys: Set<string>;
    },
    out: {
      accepted: BulkUploadAcceptedRow[];
      errors: BulkUploadRowIssue[];
      warnings: BulkUploadRowIssue[];
    },
  ): Promise<void> {
    const { row, cells } = parsed;

    // FLAG, never neutralise and never refuse. Prefixing an apostrophe on the
    // way IN would store it, re-neutralise it on the next export and corrupt
    // the user's text permanently; refusing would reject "-15% after a line
    // shutdown", which leads with `-` and is an ordinary variance reason.
    // There is no rendering context on ingest, so the value is inert here.
    if (isFormulaLead(cells.varianceReason ?? '')) {
      out.warnings.push({
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
      out.warnings.push({
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
        out.warnings,
      );
      out.accepted.push({
        row,
        recordId: null,
        ...this.identityOf(dto, preview.periodValue),
        tCo2e: this.figureOf(preview.calculation),
        anomalous: preview.verdict.anomalous,
      });
      return;
    }

    const created = await this.records.create(user, dto);
    this.warnIfUnsubmittable(
      row,
      created.anomalyFlag,
      created.varianceReason,
      out.warnings,
    );
    out.accepted.push({
      row,
      recordId: created.id,
      ...this.identityOf(dto, created.periodValue),
      tCo2e: this.figureOf(created.calculation),
      anomalous: created.anomalyFlag,
    });
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
    // spreadsheet. (An earlier version required BOTH, while the contract's own
    // comment promised EITHER.)
    if (!extensionOk) {
      throw new BadRequestException(
        `Upload a ${BULK_UPLOAD_ALLOWED_EXTENSIONS.join(' or ')} file.`,
      );
    }
  }

  /**
   * A file naming an entity this user cannot reach is refused WHOLE.
   *
   * Not a row error, deliberately: ids come from a generated template, so a
   * foreign id means the wrong file — the wrong tenant's export, or the wrong
   * template — and importing the 900 rows that happen to match would be a
   * worse outcome than refusing all 1,000. The offending ROW NUMBERS are named
   * because the user needs them; the ids disclose nothing a single create does
   * not, since an inaccessible id and a non-existent one are indistinguishable
   * here exactly as they are there.
   */
  private assertEveryEntityAccessible(
    accessibleSubsidiaryIds: string[],
    rows: ParsedRow[],
  ): void {
    const accessible = new Set(accessibleSubsidiaryIds);
    const offending = rows
      // A BLANK cell is a missing value, not a foreign entity. Refusing the
      // whole file over one told the user their reporting entity "does not
      // exist or is not yours", which is both wrong and unfindable; the DTO's
      // `@MinLength(1)` reports it as `invalid` on its own row instead.
      .filter((r) => {
        const id = r.cells.subsidiaryId.trim();
        return id !== '' && !accessible.has(id);
      })
      .map((r) => r.row);
    if (offending.length === 0) return;
    const shown = offending.slice(0, 10).join(', ');
    const suffix =
      offending.length > 10 ? ` (+${offending.length - 10} more)` : '';
    throw new BadRequestException(
      `Row(s) ${shown}${suffix} name a reporting entity that does not exist or is not yours. Nothing was imported.`,
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
   */
  private async loadStoredKeys(rows: ParsedRow[]): Promise<Set<string>> {
    const subsidiaryIds = [
      ...new Set(rows.map((r) => r.cells.subsidiaryId.trim())),
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
        ),
      ),
    );
  }

  // -- audit -----------------------------------------------------------------

  /**
   * Run the pre-flight, and if it refuses, write the refusal down before the
   * exception leaves.
   *
   * `audit_log` is append-only and has no correction path, which is exactly why
   * the events worth keeping are the ones nobody chose to record: a file naming
   * another tenant's subsidiaries, a role that may not author records, a
   * 50,000-row file. None of those reached the batch audit row, because that
   * row was written after the loop the refusal prevented.
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
      try {
        await this.audit.record(user, {
          action: 'create',
          entity: 'activity_record',
          entityId: null,
          diff: this.batchDiff(file, dryRun, {
            refused: true,
            reason: error instanceof Error ? error.message : 'unknown',
          }),
        });
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
   * What goes in the audit row's `diff`.
   *
   * The filename is truncated. It is caller-controlled (busboy allows ~16 KB
   * in a part header), it routinely carries a person's name, and `audit_log`
   * has no delete path — so an untruncated one is un-erasable personal data
   * under KVKK/GDPR, sized by the uploader.
   */
  private batchDiff(
    file: Express.Multer.File | undefined,
    dryRun: boolean,
    extra: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      bulk: true,
      dryRun,
      fileName: (file?.originalname ?? '').slice(0, 255),
      sizeBytes: file?.size ?? 0,
      ...extra,
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

  /** The six columns of the `NULLS NOT DISTINCT` uniqueness index, in order. */
  private slotKey(
    subsidiaryId: string,
    locationId: string | null,
    reportingYear: number,
    reportingPeriod: string,
    periodValue: string,
    category: string,
  ): string {
    return [
      subsidiaryId,
      locationId ?? '',
      String(reportingYear),
      reportingPeriod,
      periodValue,
      category,
    ].join(KEY_SEPARATOR);
  }

  /**
   * Cells to a DTO shape, with the numeric parse done HERE.
   *
   * Not via `@Type(() => Number)` on the DTO: that would fix the CSV case by
   * breaking the live HTTP one, where it turns `''`, `null` and `[]` into `0`
   * — a blank consumption cell silently becoming a reported zero.
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
          message: `"${cells.reportingYear}" is not a whole year.`,
        },
      };
    }
    const activityValue = strictNumber(cells.activityValue);
    if (activityValue === null) {
      return {
        issue: {
          column: 'activityValue',
          code: 'invalid',
          message: `"${cells.activityValue}" is not a number. Use a plain figure with no thousands separator.`,
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
   * Map what the record service threw onto a row issue.
   *
   * The two `ConflictException`s are told apart by their message — a real
   * coupling, made safe by importing the thrower's own constant rather than
   * retyping it. An earlier version matched the substring "already exists"
   * and a spec "pinned" it against a literal the spec itself owned, so
   * rewording the service left the whole suite green.
   */
  private toIssue(row: number, error: unknown): BulkUploadRowIssue {
    if (error instanceof NotFoundException) {
      // The calc engine throws NotFound for factor COVERAGE, which is the
      // archetypal bulk-import failure: importing 2019-2020 history for a
      // category whose factor library starts in 2021. Reporting that as an
      // access problem sent the user hunting for a permissions bug that does
      // not exist. Its own message is precise and echoes only their input.
      if (error.message.toLowerCase().includes('emission factor')) {
        return { row, column: null, code: 'no_factor', message: error.message };
      }
      return {
        row,
        column: null,
        code: 'not_found',
        message:
          'The reporting entity on this row does not exist or is not yours.',
      };
    }
    if (error instanceof ConflictException) {
      // Compared against the thrower's OWN constant, not a retyped substring.
      // The two conflicts (a taken slot, a closed period) are otherwise
      // indistinguishable, and a reworded message would silently start
      // telling users to unlock a period that was never locked.
      const duplicate = error.message === DUPLICATE_RECORD_MESSAGE;
      return {
        row,
        column: null,
        code: duplicate ? 'duplicate_existing' : 'period_locked',
        message: error.message,
      };
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
    // caller has no business seeing. Logged in full, reported as a refusal.
    this.logger.error(
      `bulk import row ${row} failed unexpectedly: ${String(error)}`,
      error instanceof Error ? error.stack : undefined,
    );
    return {
      row,
      column: null,
      code: 'unexpected',
      message: 'This row could not be imported. It was not written.',
    };
  }
}
