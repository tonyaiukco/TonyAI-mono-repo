import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, PayloadTooLargeException } from '@nestjs/common';
import { Prisma } from '@tonyai/db';
import {
  FUEL_UPLOAD_MAX_SIZE_BYTES,
  isFileFuel,
  isFuelCardSource,
  isFuelSource,
  isFuelUsage,
  isReportingYear,
  mayAuthorRecords,
  recogniseFuel,
  type FuelFilePreviewDTO,
  type FuelPreviewAccountDTO,
  type FuelPreviewOutcome,
  type FuelSource,
  type FuelTankerDeclaration,
  type FuelTankerDeliveryDTO,
  type FuelUploadDTO,
  type FuelUsage,
} from '@tonyai/shared-types';
import type { RequestUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { errorBody } from '../common/api-error';
import { withParserDeadlineMs } from '../common/work-deadline';
import { CreateRoleRefusedError } from '../activity-records/errors';
import { PrismaService } from '../prisma/prisma.service';
import { proposeCompany } from '../fuel-accounts/propose';
import { LitreTally } from './decimal';
import { readsCompany } from './fuel-scope';
import { FUEL_PARSE_TIMEOUT_MS } from './limits';
import { organisationDedupeKey } from './dedupe-key';
import { keyReading, readFuelFile, type KeyedFuelReading } from './read-fuel-file';
import {
  planStaging,
  previewOutcome,
  type PlannedRow,
  type StagedAccount,
  type StagedCompany,
  type StoredDuplicate,
  type StagingPlan,
} from './staging';
import { FuelUploadsService } from './fuel-uploads.service';

/**
 * A fuel file read, then applied (inc28-fuel-bulk D3): the preview stores no
 * data but the audit row that marks it; the apply stores the import, the
 * accounts first seen, the rows and its audit row in one transaction, or
 * nothing. The provider file itself is never kept (C19).
 */

/** The multipart fields beside `file`, as received (all text; checked here for their own codes). */
export interface FuelFileFields {
  source?: string;
  usage?: string;
  fileSha256?: string;
  declarations?: string;
}

/** Rows inserted per statement: 45,000 rows go in ten round trips. */
const INSERT_CHUNK = 5_000;
/** A whole file's apply: tens of thousands of rows in one transaction. */
const APPLY_TX = { timeout: 120_000, maxWait: 10_000 } as const;

const MIB = 1024 * 1024;

interface ParsedUpload {
  source: FuelSource;
  usage: FuelUsage | null;
  fileName: string;
  fileSize: number;
  fileSha256: string;
  reading: KeyedFuelReading;
}

type Db = Prisma.TransactionClient;

@Injectable()
export class FuelFilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly uploads: FuelUploadsService,
  ) {}

  async preview(
    user: RequestUser,
    file: Express.Multer.File | undefined,
    fields: FuelFileFields,
  ): Promise<FuelFilePreviewDTO> {
    const upload = await this.parse(user, file, fields);
    const organisationId = user.organisationId!;
    const companies = await this.companies(this.prisma, organisationId);
    const codes = accountNames(upload.reading);
    const stored = await this.storedDuplicates(this.prisma, organisationId, upload);
    const existing = await this.prisma.fuelAccount.findMany({
      where: { organisationId, source: upload.source, code: { in: [...codes.keys()] } },
      select: { id: true, code: true, state: true, subsidiaryId: true },
    });
    const accounts = new Map<string, StagedAccount>(
      existing.map((a) => [a.code, { id: a.id, code: a.code, state: a.state as StagedAccount['state'], subsidiaryId: a.subsidiaryId }]),
    );
    const plan = planStaging({
      source: upload.source,
      userId: user.id,
      usage: upload.usage,
      declarations: null,
      reading: upload.reading,
      accounts,
      companies,
      stored,
    });

    await this.audit.record(user, {
      action: 'preview',
      entity: 'import_batch',
      entityId: null,
      diff: {
        preview: {
          source: upload.source,
          fileName: upload.fileName,
          fileSha256: upload.fileSha256,
          usage: upload.usage,
          rowsRead: upload.reading.rowsRead,
          refused: upload.reading.refused.length,
          duplicates: plan.duplicates.length,
        },
      },
    });

    return {
      source: upload.source,
      fileName: upload.fileName,
      fileSize: upload.fileSize,
      fileSha256: upload.fileSha256,
      usage: upload.usage,
      rowsRead: upload.reading.rowsRead,
      refused: upload.reading.refused,
      duplicates: plan.duplicates,
      accounts: previewAccounts(user, plan, codes, accounts, companies),
      unrecognisedNames: unrecognisedNames(plan),
      deliveries: upload.source === 'tanker' ? deliveries(upload.reading, stored) : [],
    };
  }

  async apply(user: RequestUser, file: Express.Multer.File | undefined, fields: FuelFileFields): Promise<FuelUploadDTO> {
    const expected = typeof fields.fileSha256 === 'string' ? fields.fileSha256.trim().toLowerCase() : '';
    const upload = await this.parse(user, file, fields);
    if (expected !== upload.fileSha256) {
      throw new ConflictException(
        errorBody('fuel_file_changed', 'The file applied is not the file that was read. Read it again before applying it.'),
      );
    }
    const declarations = this.parseDeclarations(fields);
    const organisationId = user.organisationId!;

    const importId = await this.prisma.$transaction(async (tx) => {
      const companies = await this.companies(tx, organisationId);
      const accounts = await this.lockAccounts(tx, user, upload, companies);
      const stored = await this.storedDuplicates(tx, organisationId, upload);
      const plan = planStaging({
        source: upload.source,
        userId: user.id,
        usage: upload.usage,
        declarations: upload.source === 'tanker' ? declarations.valid : null,
        reading: upload.reading,
        accounts: accounts.byCode,
        companies,
        stored,
      });
      if (upload.source === 'tanker') assertDeclarations(plan, declarations);

      const batch = await tx.importBatch.create({
        data: {
          organisationId,
          uploadedBy: user.id,
          subsidiaryIds: [],
          fileName: upload.fileName,
          fileFormat: 'xlsx',
          sizeBytes: upload.fileSize,
          sha256: upload.fileSha256,
          storagePath: null,
          status: 'completed',
          totalRows: upload.reading.rowsRead,
          acceptedCount: 0,
          rejectedCount: upload.reading.refused.length,
          completedAt: new Date(),
          source: upload.source,
        },
        select: { id: true },
      });

      const raced = await this.insertRows(tx, user, organisationId, batch.id, upload.source, plan.rows, accounts.idByCode);
      const storedRows = plan.rows.filter((row) => !raced.has(row.dedupeDigest));
      await tx.importBatch.update({ where: { id: batch.id }, data: { acceptedCount: storedRows.length } });

      await this.audit.record(
        user,
        {
          action: 'bulk_import',
          entity: 'import_batch',
          entityId: batch.id,
          diff: {
            fuelUpload: {
              source: upload.source,
              fileName: upload.fileName,
              fileSha256: upload.fileSha256,
              usage: upload.usage,
              declarations: upload.source === 'tanker' ? storedRows.length : undefined,
              rowsRead: upload.reading.rowsRead,
              refused: upload.reading.refused.length,
              duplicates: plan.duplicates.length + raced.size,
              stored: storedRows.length,
              accountsFirstSeen: accounts.firstSeen,
              byAccount: byAccountAudit(storedRows),
            },
          },
        },
        tx,
      );
      return batch.id;
    }, APPLY_TX);

    return this.uploads.detail(user, importId);
  }

  /** The checks every fuel upload passes before its file is read, then the read. */
  private async parse(
    user: RequestUser,
    file: Express.Multer.File | undefined,
    fields: FuelFileFields,
  ): Promise<ParsedUpload> {
    if (!mayAuthorRecords(user) || !user.organisationId) throw new CreateRoleRefusedError();
    const source = fields.source?.trim();
    if (!isFuelSource(source)) {
      throw new BadRequestException(errorBody('fuel_file_source_required', 'Choose the fuel file’s source.'));
    }
    let usage: FuelUsage | null = null;
    if (isFuelCardSource(source)) {
      const declared = fields.usage?.trim();
      if (!isFuelUsage(declared)) {
        throw new BadRequestException(errorBody('fuel_file_usage_required', 'Choose how the fuel in this file was used.'));
      }
      usage = declared;
    }
    if (!file) throw new BadRequestException(errorBody('bulk_file_missing', 'No file was uploaded.'));
    // Defence in depth: multer's own `limits.fileSize` answers first over HTTP.
    if (file.size > FUEL_UPLOAD_MAX_SIZE_BYTES) {
      const limitMb = FUEL_UPLOAD_MAX_SIZE_BYTES / MIB;
      throw new PayloadTooLargeException(
        errorBody('fuel_file_too_large', `The fuel file is larger than ${limitMb} MB.`, { limitMb }),
      );
    }
    // CSV is not offered: it has no cell types (D4).
    if (!/\.xlsx$/i.test(file.originalname ?? '')) {
      throw new BadRequestException(errorBody('bulk_file_type', 'Upload an .xlsx file.'));
    }
    const read = await withParserDeadlineMs(FUEL_PARSE_TIMEOUT_MS, () => readFuelFile(file.buffer, source));
    // Keyed here, once: nothing past this point sees a row's unkeyed hash (D5, revised).
    const reading = keyReading(read, await organisationDedupeKey(this.prisma, user.organisationId));
    return {
      source,
      usage,
      fileName: file.originalname,
      fileSize: file.size,
      fileSha256: createHash('sha256').update(file.buffer).digest('hex'),
      reading,
    };
  }

  /** A tanker file's choices (C3), parsed before the file is read; nothing is preselected or assumed. */
  private parseDeclarations(fields: FuelFileFields): Declarations {
    const result: Declarations = { valid: new Map(), named: new Set() };
    if (fields.source?.trim() !== 'tanker') return result;
    let parsed: unknown = [];
    if (typeof fields.declarations === 'string' && fields.declarations.trim() !== '') {
      try {
        parsed = JSON.parse(fields.declarations);
      } catch {
        throw new BadRequestException(errorBody('validation_failed', 'The deliveries’ choices are not valid JSON.'));
      }
    }
    if (!Array.isArray(parsed)) {
      throw new BadRequestException(errorBody('validation_failed', 'The deliveries’ choices must be a list.'));
    }
    for (const item of parsed as unknown[]) {
      const entry = (item ?? {}) as Partial<Record<keyof FuelTankerDeclaration, unknown>>;
      if (typeof entry.documentNo !== 'string' || entry.documentNo.trim() === '') {
        throw new BadRequestException(errorBody('fuel_file_declaration_unknown', 'A choice names no delivery.'));
      }
      const documentNo = entry.documentNo.trim();
      // A delivery named twice is not one choice.
      if (result.named.has(documentNo)) {
        throw new BadRequestException(
          errorBody('fuel_file_declaration_unknown', 'A delivery is named by more than one choice.'),
        );
      }
      result.named.add(documentNo);
      const { fuel, usage, year, month } = entry;
      if (
        isFileFuel(fuel) &&
        isFuelUsage(usage) &&
        typeof year === 'number' &&
        isReportingYear(year) &&
        typeof month === 'number' &&
        Number.isInteger(month) &&
        month >= 1 &&
        month <= 12
      ) {
        result.valid.set(documentNo, { documentNo, fuel, usage, year, month });
      }
    }
    return result;
  }

  /** The organisation's companies: the proposal's candidates and the mapping targets' kind. */
  private async companies(db: Pick<Db, 'subsidiary'>, organisationId: string): Promise<Map<string, StagedCompany>> {
    const rows = await db.subsidiary.findMany({
      where: { organisationId },
      select: { id: true, legalName: true, tradingName: true, control: true, nodeType: true },
    });
    return new Map(
      rows.map((c) => [
        c.id,
        {
          id: c.id,
          name: c.tradingName || c.legalName,
          names: [c.legalName, ...(c.tradingName ? [c.tradingName] : [])],
          control: c.control,
          nodeType: c.nodeType,
        },
      ]),
    );
  }

  /** The file's keys already stored and live, for the organisation and source (D5). */
  private async storedDuplicates(
    db: Pick<Db, '$queryRaw'>,
    organisationId: string,
    upload: ParsedUpload,
  ): Promise<Map<string, StoredDuplicate>> {
    const digests = upload.reading.rows.map((row) => row.dedupeDigest);
    const stored = new Map<string, StoredDuplicate>();
    for (let i = 0; i < digests.length; i += INSERT_CHUNK) {
      const chunk = digests.slice(i, i + INSERT_CHUNK);
      const rows = await db.$queryRaw<Array<{ dedupe_digest: string; holder_id: string; state: string }>>`
        SELECT dedupe_digest, holder_id::text, state FROM fuel_rows
        WHERE organisation_id = ${organisationId}::uuid AND source = ${upload.source}
          AND state <> 'withdrawn' AND dedupe_digest = ANY(${chunk}::text[])`;
      for (const row of rows) stored.set(row.dedupe_digest, { holderId: row.holder_id, state: row.state });
    }
    return stored;
  }

  /**
   * The file's accounts, stored and locked (D7): an account first seen is
   * inserted with the tool's proposal (C4); one already stored keeps its
   * mapping and shows the name last read. The upsert holds each account's row
   * until commit, so a confirmation or a change waits for this upload, and the
   * mapping read here is the one the rows are stored under.
   */
  private async lockAccounts(
    tx: Db,
    user: RequestUser,
    upload: ParsedUpload,
    companies: ReadonlyMap<string, StagedCompany>,
  ): Promise<{ byCode: Map<string, StagedAccount>; idByCode: Map<string, string>; firstSeen: Array<{ code: string; proposed: string | null }> }> {
    const names = accountNames(upload.reading);
    const candidates = [...companies.values()].filter((c) => c.nodeType !== 'sector_group');
    const codes = [...names.keys()].sort();
    const accountNameList = codes.map((code) => names.get(code)!);
    const proposals = codes.map((code) => proposeCompany(names.get(code)!, candidates));
    const rows =
      codes.length === 0
        ? []
        : await tx.$queryRaw<Array<{ id: string; code: string; state: string; subsidiary_id: string | null; inserted: boolean }>>`
        INSERT INTO fuel_accounts (id, organisation_id, source, code, name, subsidiary_id, state, created_by, created_at, updated_at)
        SELECT gen_random_uuid(), ${user.organisationId}::uuid, ${upload.source}, a.code, a.name, a.subsidiary_id,
               CASE WHEN a.subsidiary_id IS NULL THEN 'unmatched' ELSE 'proposed' END, ${user.id}::uuid, now(), now()
        FROM jsonb_to_recordset(${JSON.stringify(codes.map((code, i) => ({ code, name: accountNameList[i], subsidiary_id: proposals[i] })))}::jsonb)
          AS a(code text, name text, subsidiary_id uuid)
        ORDER BY a.code
        ON CONFLICT (organisation_id, source, code) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
        RETURNING id::text, code, state, subsidiary_id::text, (xmax = 0) AS inserted`;
    const byCode = new Map<string, StagedAccount>();
    const idByCode = new Map<string, string>();
    const firstSeen: Array<{ code: string; proposed: string | null }> = [];
    for (const row of rows) {
      byCode.set(row.code, { id: row.id, code: row.code, state: row.state as StagedAccount['state'], subsidiaryId: row.subsidiary_id });
      idByCode.set(row.code, row.id);
      if (row.inserted) firstSeen.push({ code: row.code, proposed: row.subsidiary_id });
    }
    return { byCode, idByCode, firstSeen };
  }

  /**
   * The rows, in chunks; a key another writer stored first is skipped by the
   * live-row index and reported as a duplicate (D5). A key withdrawn before is
   * stored again, naming the withdrawn row it replaces (C14).
   */
  private async insertRows(
    tx: Db,
    user: RequestUser,
    organisationId: string,
    importId: string,
    source: FuelSource,
    rows: readonly PlannedRow[],
    idByCode: ReadonlyMap<string, string>,
  ): Promise<Set<string>> {
    const inserted = new Set<string>();
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      const chunk = rows.slice(i, i + INSERT_CHUNK);
      const result = await tx.$queryRaw<Array<{ dedupe_digest: string }>>`
        INSERT INTO fuel_rows (id, organisation_id, import_batch_id, holder_id, source, dedupe_digest, fuel_account_id,
          raw_fuel, fuel, usage, litres, transaction_at, year, month, invoice_ref, file_row, state, subsidiary_id,
          replaces_id, created_at, updated_at)
        SELECT gen_random_uuid(), ${organisationId}::uuid, ${importId}::uuid, ${user.id}::uuid, ${source}, r.digest,
          r.account_id, r.raw_fuel, r.fuel, r.usage, r.litres::numeric, r.at::timestamp, r.year, r.month, r.invoice,
          r.file_row, r.state, r.subsidiary_id,
          (SELECT w.id FROM fuel_rows w
            WHERE w.organisation_id = ${organisationId}::uuid AND w.source = ${source}
              AND w.dedupe_digest = r.digest AND w.state = 'withdrawn'
            ORDER BY w.withdrawn_at DESC, w.id LIMIT 1),
          now(), now()
        FROM jsonb_to_recordset(${JSON.stringify(
          chunk.map((r) => ({
            digest: r.dedupeDigest,
            account_id: idByCode.get(r.accountCode)!,
            raw_fuel: r.rawFuel,
            fuel: r.fuel,
            usage: r.usage,
            litres: r.litres,
            at: r.transactionAt,
            year: r.year,
            month: r.month,
            invoice: r.invoiceRef,
            file_row: r.fileRow,
            state: r.state,
            subsidiary_id: r.subsidiaryId,
          })),
        )}::jsonb) AS r(digest text, account_id uuid, raw_fuel text, fuel text, usage text, litres text, at text,
          year int, month int, invoice text, file_row int, state text, subsidiary_id uuid)
        ON CONFLICT (organisation_id, source, dedupe_digest) WHERE state <> 'withdrawn' DO NOTHING
        RETURNING dedupe_digest`;
      for (const row of result) inserted.add(row.dedupe_digest);
    }
    return new Set(rows.map((r) => r.dedupeDigest).filter((digest) => !inserted.has(digest)));
  }
}

interface Declarations {
  valid: Map<string, FuelTankerDeclaration>;
  /** Every delivery a choice names, valid or not. */
  named: Set<string>;
}

/** Every delivery to be stored has its four choices, and no choice names another (C3). */
function assertDeclarations(plan: StagingPlan, declarations: Declarations): void {
  const first = plan.undeclared[0];
  if (first) {
    throw new BadRequestException(
      errorBody(
        'fuel_file_declarations_incomplete',
        `The delivery on row ${first.fileRow} has no fuel, usage, year or month chosen.`,
        { row: first.fileRow },
      ),
    );
  }
  const toStore = new Set([...plan.rows.map((row) => row.invoiceRef), ...plan.undeclared.map((row) => row.invoiceRef)]);
  for (const documentNo of declarations.named) {
    if (!toStore.has(documentNo)) {
      throw new BadRequestException(
        errorBody('fuel_file_declaration_unknown', 'A choice names a delivery that this file does not store.'),
      );
    }
  }
}

/** Each account's name as last read, in the file's order (fuel-account-mapping "One code under two names"). */
function accountNames(reading: KeyedFuelReading): Map<string, string> {
  const names = new Map<string, string>();
  for (const row of reading.rows) names.set(row.accountCode, row.accountName);
  return names;
}

function previewAccounts(
  user: RequestUser,
  plan: StagingPlan,
  names: ReadonlyMap<string, string>,
  accounts: ReadonlyMap<string, StagedAccount>,
  companies: ReadonlyMap<string, StagedCompany>,
): FuelPreviewAccountDTO[] {
  const candidates = [...companies.values()].filter((c) => c.nodeType !== 'sector_group');
  const outcomes = new Map<string, Map<FuelPreviewOutcome, LitreTally>>();
  for (const row of plan.rows) {
    const byOutcome = outcomes.get(row.accountCode) ?? new Map<FuelPreviewOutcome, LitreTally>();
    outcomes.set(row.accountCode, byOutcome);
    const outcome = previewOutcome(row, user.accessibleSubsidiaryIds);
    const tally = byOutcome.get(outcome) ?? new LitreTally();
    byOutcome.set(outcome, tally);
    tally.add(row.litres);
  }
  return [...outcomes.entries()].map(([code, byOutcome]) => {
    const account = accounts.get(code);
    const companyId = account ? account.subsidiaryId : proposeCompany(names.get(code) ?? '', candidates);
    const named = readsCompany(user, companyId);
    return {
      accountId: account?.id ?? null,
      code,
      name: names.get(code) ?? code,
      subsidiaryId: named ? companyId : null,
      subsidiaryName: named ? (companies.get(companyId!)?.name ?? null) : null,
      proposed: account ? account.state === 'proposed' : companyId !== null,
      outcomes: [...byOutcome.entries()].map(([outcome, tally]) => ({ outcome, ...tally.toDTO() })),
    };
  });
}

/** Raw fuel names no rule recognises, per account (a card file's rows only). */
function unrecognisedNames(plan: StagingPlan): FuelFilePreviewDTO['unrecognisedNames'] {
  const groups = new Map<string, { accountCode: string; rawName: string; tally: LitreTally }>();
  for (const row of plan.rows) {
    if (row.rawFuel === null || recogniseFuel(row.rawFuel) !== null) continue;
    const key = JSON.stringify([row.accountCode, row.rawFuel]);
    const group = groups.get(key) ?? { accountCode: row.accountCode, rawName: row.rawFuel, tally: new LitreTally() };
    groups.set(key, group);
    group.tally.add(row.litres);
  }
  return [...groups.values()].map((g) => ({ accountCode: g.accountCode, rawName: g.rawName, ...g.tally.toDTO() }));
}

/** A tanker file's deliveries of a first read, each with what it needs (C3). */
function deliveries(reading: KeyedFuelReading, stored: ReadonlyMap<string, StoredDuplicate>): FuelTankerDeliveryDTO[] {
  return reading.rows.map((row) => ({
    documentNo: row.invoiceRef,
    receiving: row.accountName,
    litres: row.litres,
    row: row.fileRow,
    needs: stored.has(row.dedupeDigest) ? 'stored' : 'declaration',
  }));
}

/** The upload's audit statement per account: rows and litres stored, by state; excluded ones apart (C10). */
function byAccountAudit(rows: readonly PlannedRow[]): Array<{ code: string; state: string; rows: number; litres: string }> {
  const groups = new Map<string, { code: string; state: string; tally: LitreTally }>();
  for (const row of rows) {
    const key = JSON.stringify([row.accountCode, row.state]);
    const group = groups.get(key) ?? { code: row.accountCode, state: row.state, tally: new LitreTally() };
    groups.set(key, group);
    group.tally.add(row.litres);
  }
  return [...groups.values()].map((g) => ({ code: g.code, state: g.state, ...g.tally.toDTO() }));
}

export type { ParsedUpload };
