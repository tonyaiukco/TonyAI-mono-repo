import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@tonyai/db';
import {
  can,
  FUEL_ROW_STATES,
  isFuelHoldReason,
  isFuelSource,
  mayAuthorRecords,
  type FuelHoldReason,
  type FuelRowCountDTO,
  type FuelRowState,
  type FuelSource,
  type FuelTrayDTO,
  type FuelUploadDTO,
  FUEL_UPLOAD_PAGE,
  parseFuelUploadCursor,
  type FuelWithdrawableDTO,
  type TakeOverFuelRowsRequest,
  type WithdrawFuelRowsRequest,
} from '@tonyai/shared-types';
import type { RequestUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { errorBody, ResourceNotFoundError } from '../common/api-error';
import { actorDisplayName, resolveProfiles } from '../common/resolve-profiles';
import { PrismaService } from '../prisma/prisma.service';
import { sumDecimals } from './decimal';
import { lockActor } from './lock-actor';
import { fuelRowScopeSql, fuelUploadScopeWhere, readsCompany, readsWholeOrganisation } from './fuel-scope';

/**
 * An applied fuel upload and its rows (inc28-fuel-bulk D8, D13, D14): the
 * uploads list and summary, the unmatched tray, a withdrawal of unbatched
 * rows, and a masterkey's takeover. Counts read the reader's current scope.
 */

/** The live rows no batch holds yet: a withdrawal or a takeover acts on these (C14, C8). */
const UNBATCHED_STATES = ['waiting_account', 'waiting_fuel', 'ready', 'held', 'excluded'] as const;
const REASON_MAX_LENGTH = 1_000;

type CountRow = { import_batch_id: string; state: string; hold_reason: string | null; rows: number; litres: string };

const emptyCount = (): FuelRowCountDTO => ({ rows: 0, litres: '0' });

@Injectable()
export class FuelUploadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(user: RequestUser, after?: string): Promise<FuelUploadDTO[]> {
    this.assertOrganisation(user);
    const cursor = after ? parseFuelUploadCursor(after) : null;
    if (after && !cursor) return [];
    // The next page after an upload's place, as the list showed it (newest
    // first, the id breaking ties; the API writes the time to the millisecond).
    const where: Prisma.ImportBatchWhereInput = cursor
      ? { AND: [fuelUploadScopeWhere(user), { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }] }
      : fuelUploadScopeWhere(user);
    const imports = await this.prisma.importBatch.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: FUEL_UPLOAD_PAGE,
    });
    return this.summaries(user, imports);
  }

  async detail(user: RequestUser, id: string): Promise<FuelUploadDTO> {
    const found = await this.visibleUpload(user, id);
    const [summary] = await this.summaries(user, [found]);
    return summary!;
  }

  /** `GET /fuel-files/tray`: the rows waiting for an account or a fuel name, in the reader's scope (D14). */
  async tray(user: RequestUser): Promise<FuelTrayDTO> {
    this.assertOrganisation(user);
    const scope = fuelRowScopeSql(user, 'r');
    const accounts = await this.prisma.$queryRaw<
      Array<{
        account_id: string;
        source: string;
        code: string;
        name: string;
        state: string;
        subsidiary_id: string | null;
        control: string | null;
        legal_name: string | null;
        trading_name: string | null;
        rows: number;
        litres: string;
      }>
    >`
      SELECT a.id::text AS account_id, a.source, a.code, a.name, a.state, a.subsidiary_id::text,
             s.control::text, s.legal_name, s.trading_name, count(*)::int AS rows, sum(r.litres)::text AS litres
      FROM fuel_rows r
      JOIN fuel_accounts a ON a.id = r.fuel_account_id
      LEFT JOIN subsidiaries s ON s.id = a.subsidiary_id
      WHERE r.state = 'waiting_account' AND ${scope}
      GROUP BY a.id, s.id
      ORDER BY a.source, a.code`;
    const names = await this.prisma.$queryRaw<
      Array<{ source: string; raw_fuel: string; account_id: string; code: string; rows: number; litres: string }>
    >`
      SELECT r.source, r.raw_fuel, a.id::text AS account_id, a.code, count(*)::int AS rows, sum(r.litres)::text AS litres
      FROM fuel_rows r
      JOIN fuel_accounts a ON a.id = r.fuel_account_id
      WHERE r.state = 'waiting_fuel' AND ${scope}
      GROUP BY r.source, r.raw_fuel, a.id
      ORDER BY r.source, r.raw_fuel, a.code`;
    return {
      accounts: accounts.map((a) => {
        const proposed = a.state === 'proposed' ? a.subsidiary_id : null;
        const named = readsCompany(user, proposed);
        return {
          accountId: a.account_id,
          source: a.source as FuelSource,
          code: a.code,
          name: a.name,
          rows: a.rows,
          litres: a.litres,
          proposedSubsidiaryId: named ? proposed : null,
          proposedSubsidiaryName: named ? a.trading_name || a.legal_name : null,
          canConfirm: mayConfirm(user, proposed, a.control),
        };
      }),
      fuelNames: names.map((n) => ({
        source: n.source as FuelSource,
        rawName: n.raw_fuel,
        accountId: n.account_id,
        accountCode: n.code,
        rows: n.rows,
        litres: n.litres,
      })),
    };
  }

  /**
   * `POST /fuel-files/:id/withdraw-rows` (C14, D13): the upload's live rows in
   * no batch (excluded ones included) of one account, or those waiting for one
   * raw fuel name, are withdrawn — kept, out of every sum, with who, when and why. The holder
   * withdraws the rows it holds; a masterkey any.
   */
  async withdrawRows(user: RequestUser, id: string, request: WithdrawFuelRowsRequest): Promise<FuelUploadDTO> {
    const reason = typeof request.reason === 'string' ? request.reason.trim() : '';
    if (reason.length === 0 || reason.length > REASON_MAX_LENGTH) {
      throw new BadRequestException(errorBody('validation_failed', 'A withdrawal needs a reason.'));
    }
    const accountId = request.accountId ?? null;
    const rawFuelName = request.rawFuelName ?? null;
    if ((accountId === null) === (rawFuelName === null)) {
      throw new BadRequestException(errorBody('validation_failed', 'Name one account or one fuel name.'));
    }
    const upload = await this.visibleUpload(user, id, { asHolder: true });
    const anyHolder = can(user.role, 'fuel_rows.take_over');
    if (!anyHolder && !mayAuthorRecords(user)) throw new ForbiddenException();

    await this.prisma.$transaction(async (tx) => {
      // The role that decided whose rows may go, re-read at the write (WP9 PR B review, P1).
      await lockActor(tx, user);
      const rows = await tx.$queryRaw<Array<{ code: string; state: string; rows: number; litres: string }>>`
        WITH withdrawn AS (
          UPDATE fuel_rows r
          SET withdrawn_state = r.state, state = 'withdrawn', withdrawn_by = ${user.id}::uuid, withdrawn_at = now(),
              withdrawn_reason = ${reason}, updated_at = now()
          WHERE r.import_batch_id = ${upload.id}::uuid AND r.organisation_id = ${user.organisationId}::uuid
            AND r.fuel_batch_id IS NULL AND r.state = ANY(${[...UNBATCHED_STATES]}::text[])
            AND (${anyHolder} OR r.holder_id = ${user.id}::uuid)
            AND (${accountId}::uuid IS NULL OR r.fuel_account_id = ${accountId}::uuid)
            -- A fuel name withdraws the rows waiting for that name only, never
            -- one still waiting for an account or excluded under an associate
            -- (QA review of the WP9 PR B fixes, P2).
            AND (${rawFuelName}::text IS NULL OR (r.raw_fuel = ${rawFuelName}::text AND r.state = 'waiting_fuel'))
          RETURNING r.fuel_account_id, r.withdrawn_state, r.litres
        )
        SELECT a.code, w.withdrawn_state AS state, count(*)::int AS rows, sum(w.litres)::text AS litres
        FROM withdrawn w JOIN fuel_accounts a ON a.id = w.fuel_account_id
        GROUP BY a.code, w.withdrawn_state ORDER BY a.code, w.withdrawn_state`;
      await this.audit.record(
        user,
        {
          action: 'retract',
          entity: 'import_batch',
          entityId: upload.id,
          diff: { fuelRowsWithdrawn: { accountId, rawFuelName, reason, byAccount: rows } },
        },
        tx,
      );
    });
    return this.detail(user, id);
  }

  /**
   * `GET /fuel-files/:id/withdrawable`: what `withdrawRows` would withdraw for
   * this caller, by account and by waiting fuel name — the same predicate, so
   * a choice offered is one the withdrawal accepts.
   */
  async withdrawable(user: RequestUser, id: string): Promise<FuelWithdrawableDTO> {
    const upload = await this.visibleUpload(user, id, { asHolder: true });
    const anyHolder = can(user.role, 'fuel_rows.take_over');
    if (!anyHolder && !mayAuthorRecords(user)) return { accounts: [], fuelNames: [] };
    const mayWithdraw = Prisma.sql`r.import_batch_id = ${upload.id}::uuid AND r.organisation_id = ${user.organisationId}::uuid
      AND r.fuel_batch_id IS NULL AND r.state = ANY(${[...UNBATCHED_STATES]}::text[])
      AND (${anyHolder} OR r.holder_id = ${user.id}::uuid)`;
    // An account's name only when the reader reads every row listed under it;
    // its code and counts are the caller's own file's (security review of the fixes, P2).
    const accounts = await this.prisma.$queryRaw<Array<{ id: string; code: string; name: string | null; rows: number; litres: string; excluded: number }>>`
      SELECT a.id::text, a.code, CASE WHEN bool_and(${fuelRowScopeSql(user, 'r')}) THEN a.name END AS name,
             count(*)::int AS rows, sum(r.litres)::text AS litres,
             -- Excluded (a mapping decision, not the file's content) counted only where the caller reads the row.
             count(*) FILTER (WHERE r.state = 'excluded' AND ${fuelRowScopeSql(user, 'r')})::int AS excluded
      FROM fuel_rows r JOIN fuel_accounts a ON a.id = r.fuel_account_id
      WHERE ${mayWithdraw}
      GROUP BY a.id, a.code, a.name ORDER BY a.code`;
    const fuelNames = await this.prisma.$queryRaw<Array<{ raw_fuel: string; rows: number; litres: string }>>`
      SELECT r.raw_fuel, count(*)::int AS rows, sum(r.litres)::text AS litres
      FROM fuel_rows r
      WHERE ${mayWithdraw} AND r.state = 'waiting_fuel' AND r.raw_fuel IS NOT NULL
      GROUP BY r.raw_fuel ORDER BY r.raw_fuel`;
    return {
      accounts: accounts.map((a) => ({ accountId: a.id, code: a.code, name: a.name, rows: a.rows, litres: sumDecimals([a.litres]), excluded: a.excluded })),
      fuelNames: fuelNames.map((f) => ({ rawName: f.raw_fuel, rows: f.rows, litres: sumDecimals([f.litres]) })),
    };
  }

  /**
   * `POST /fuel-files/:id/take-over` (masterkey, C8): the caller becomes the
   * holder of the upload's live unbatched rows (one account's, if named); held
   * rows are ready again (D8). The audit row names the upload, its uploader,
   * the rows and litres.
   */
  async takeOver(user: RequestUser, id: string, request: TakeOverFuelRowsRequest): Promise<FuelUploadDTO> {
    if (!can(user.role, 'fuel_rows.take_over')) throw new ForbiddenException();
    const upload = await this.visibleUpload(user, id);
    const accountId = request.accountId ?? null;
    await this.prisma.$transaction(async (tx) => {
      // Still a masterkey, still enabled, at the write (WP9 PR B review, P1).
      await lockActor(tx, user);
      const rows = await tx.$queryRaw<Array<{ holder: string; rows: number; litres: string }>>`
        WITH before AS (
          SELECT id, holder_id FROM fuel_rows
          WHERE import_batch_id = ${upload.id}::uuid AND organisation_id = ${user.organisationId}::uuid
            AND fuel_batch_id IS NULL AND state = ANY(${[...UNBATCHED_STATES]}::text[])
            AND (${accountId}::uuid IS NULL OR fuel_account_id = ${accountId}::uuid)
          FOR UPDATE
        ), taken AS (
          UPDATE fuel_rows r
          SET holder_id = ${user.id}::uuid,
              state = CASE WHEN r.state = 'held' THEN 'ready' ELSE r.state END,
              hold_reason = NULL, updated_at = now()
          FROM before b WHERE r.id = b.id AND r.fuel_batch_id IS NULL
          RETURNING b.holder_id, r.litres
        )
        SELECT holder_id::text AS holder, count(*)::int AS rows, sum(litres)::text AS litres
        FROM taken GROUP BY holder_id ORDER BY holder_id`;
      await this.audit.record(
        user,
        {
          action: 'take_over',
          entity: 'import_batch',
          entityId: upload.id,
          diff: { fuelRowsTakenOver: { uploadedBy: upload.uploadedBy, accountId, fromHolders: rows } },
        },
        tx,
      );
    });
    return this.detail(user, id);
  }

  /**
   * A fuel upload the reader may see (D14): masterkey and auditor any of the
   * organisation's; others their own uploads, or (`asHolder`) one whose rows
   * they hold. A template import, another organisation's or any other id is
   * not found.
   */
  async visibleUpload(
    user: RequestUser,
    id: string,
    options: { asHolder?: boolean } = {},
  ): Promise<{ id: string; uploadedBy: string; source: string; fileName: string; sizeBytes: number; sha256: string; createdAt: Date; totalRows: number; acceptedCount: number | null; rejectedCount: number | null }> {
    this.assertOrganisation(user);
    const holderClause: Prisma.ImportBatchWhereInput[] = options.asHolder
      ? [{ fuelRows: { some: { holderId: user.id, fuelBatchId: null } } }]
      : [];
    const found = await this.prisma.importBatch.findFirst({
      where: {
        id,
        organisationId: user.organisationId!,
        source: { not: 'template' },
        OR: [fuelUploadScopeWhere(user), ...holderClause],
      },
    });
    if (!found) throw new ResourceNotFoundError('fuel_file_not_found');
    return found;
  }

  private assertOrganisation(user: RequestUser): void {
    if (!user.organisationId) throw new ResourceNotFoundError('fuel_file_not_found');
  }

  private async summaries(
    user: RequestUser,
    imports: ReadonlyArray<{ id: string; uploadedBy: string; source: string; fileName: string; sizeBytes: number; sha256: string; createdAt: Date; totalRows: number; acceptedCount: number | null; rejectedCount: number | null }>,
  ): Promise<FuelUploadDTO[]> {
    if (imports.length === 0) return [];
    const ids = imports.map((i) => i.id);
    const scope = fuelRowScopeSql(user, 'r');
    const counts = await this.prisma.$queryRaw<CountRow[]>`
      SELECT r.import_batch_id::text, r.state, r.hold_reason, count(*)::int AS rows, sum(r.litres)::text AS litres
      FROM fuel_rows r
      WHERE r.import_batch_id = ANY(${ids}::uuid[]) AND ${scope}
      GROUP BY r.import_batch_id, r.state, r.hold_reason`;
    const mine = await this.prisma.$queryRaw<Array<{ import_batch_id: string; ready: number; held: number }>>`
      SELECT import_batch_id::text,
             count(*) FILTER (WHERE state = 'ready')::int AS ready,
             count(*)::int AS held
      FROM fuel_rows
      WHERE import_batch_id = ANY(${ids}::uuid[]) AND holder_id = ${user.id}::uuid AND fuel_batch_id IS NULL
        AND state = ANY(${['ready', 'held', 'waiting_account', 'waiting_fuel']}::text[])
      GROUP BY import_batch_id`;
    const profiles = await resolveProfiles(this.prisma, imports.map((i) => i.uploadedBy));
    return imports.map((upload) => {
      const rows = Object.fromEntries(FUEL_ROW_STATES.map((state) => [state, emptyCount()])) as Record<FuelRowState, FuelRowCountDTO>;
      const held = new Map<FuelHoldReason, FuelRowCountDTO>();
      for (const count of counts.filter((c) => c.import_batch_id === upload.id)) {
        const state = count.state as FuelRowState;
        rows[state] = addCount(rows[state], count);
        if (state === 'held' && isFuelHoldReason(count.hold_reason)) {
          held.set(count.hold_reason, addCount(held.get(count.hold_reason) ?? emptyCount(), count));
        }
      }
      const holder = mine.find((m) => m.import_batch_id === upload.id);
      const accepted = upload.acceptedCount ?? 0;
      const refused = upload.rejectedCount ?? 0;
      return {
        id: upload.id,
        source: (isFuelSource(upload.source) ? upload.source : 'shell') as FuelSource,
        fileName: upload.fileName,
        fileSize: upload.sizeBytes,
        fileSha256: upload.sha256,
        uploadedBy: upload.uploadedBy,
        uploadedByName: actorDisplayName(upload.uploadedBy, profiles),
        createdAt: upload.createdAt.toISOString(),
        rowsRead: upload.totalRows,
        rowsRefused: refused,
        rowsDuplicate: Math.max(0, upload.totalRows - accepted - refused),
        rows,
        processableRows: holder?.ready ?? 0,
        held: [...held.entries()].map(([reason, count]) => ({ reason, ...count })),
        readerIsHolder: (holder?.held ?? 0) > 0,
      };
    });
  }
}

function addCount(total: FuelRowCountDTO, count: { rows: number; litres: string }): FuelRowCountDTO {
  // Two plain decimals from the database: summed there when one group, here when a state has several reasons.
  return { rows: total.rows + count.rows, litres: addDecimalText(total.litres, count.litres) };
}

function addDecimalText(a: string, b: string): string {
  return sumDecimals([a, b]);
}

/**
 * Whether the reader may confirm an account's proposal (C5, B6): a masterkey
 * any account; a super_admin a proposal naming a company it is granted that
 * is not an associate.
 */
export function mayConfirm(user: RequestUser, proposedSubsidiaryId: string | null, control: string | null): boolean {
  if (can(user.role, 'fuel_account.write')) return true;
  if (!can(user.role, 'fuel_account.confirm_granted')) return false;
  return proposedSubsidiaryId !== null && control !== 'associate' && readsCompany(user, proposedSubsidiaryId);
}

export { readsWholeOrganisation };
