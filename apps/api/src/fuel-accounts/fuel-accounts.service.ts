import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@tonyai/db';
import {
  can,
  isFuelSource,
  type ConfirmFuelAccountRequest,
  type CreateFuelAccountRequest,
  type FuelAccountDTO,
  type FuelAccountState,
  type FuelRowCountDTO,
  type FuelRowState,
  type FuelSource,
  type UpdateFuelAccountRequest,
} from '@tonyai/shared-types';
import type { RequestUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { errorBody, ResourceNotFoundError } from '../common/api-error';
import { actorDisplayName, resolveProfiles } from '../common/resolve-profiles';
import { PrismaService } from '../prisma/prisma.service';
import { fuelAccountScopeSql, fuelRowScopeSql, readsCompany } from '../fuel-files/fuel-scope';
import { lockActor } from '../fuel-files/lock-actor';
import { mayConfirm } from '../fuel-files/fuel-uploads.service';

/**
 * Fuel accounts and their mappings (inc28-fuel-bulk D7, C5, C14, C20). Every
 * writer of a mapping takes the account's row `FOR UPDATE`, re-reads its actor
 * and the target inside the write, writes the mapping, and re-states the
 * account's live unbatched rows by the one state function in the same
 * transaction. Staging and batch formation read the mapping under the same
 * row's lock, so a change and a batch never cross.
 */

type Db = Prisma.TransactionClient;
const CODE_MAX_LENGTH = 64;
const NAME_MAX_LENGTH = 200;
const LIST_LIMIT = 1_000;
const LIVE_STATES = ['waiting_account', 'excluded', 'waiting_fuel', 'ready', 'held', 'assigned'] as const;

interface LockedAccount {
  id: string;
  source: string;
  code: string;
  state: FuelAccountState;
  subsidiary_id: string | null;
}

interface Target {
  id: string;
  associate: boolean;
}

export class FuelAccountTargetForbiddenError extends ForbiddenException {
  constructor() {
    super(errorBody('fuel_account_target_forbidden', 'You cannot map this account to that company.'));
  }
}

export class FuelAccountTargetInvalidError extends UnprocessableEntityException {
  constructor() {
    super(
      errorBody(
        'fuel_account_target_invalid',
        'A fuel account can be mapped only to a company of this organisation, not to a sector group.',
      ),
    );
  }
}

@Injectable()
export class FuelAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(user: RequestUser): Promise<FuelAccountDTO[]> {
    const scope = user.organisationId ? fuelAccountScopeSql(user, 'a') : null;
    if (scope === null) throw new ForbiddenException();
    const ids = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT a.id::text FROM fuel_accounts a WHERE ${scope} ORDER BY a.source, a.code LIMIT ${LIST_LIMIT}`;
    return this.dtos(user, ids.map((r) => r.id));
  }

  /** `POST /fuel-accounts` (masterkey, B7): an account mapped by hand, confirmed by its making. */
  async create(user: RequestUser, request: CreateFuelAccountRequest): Promise<FuelAccountDTO> {
    if (!can(user.role, 'fuel_account.write') || !user.organisationId) throw new ForbiddenException();
    const source = request.source;
    const code = typeof request.code === 'string' ? request.code.trim() : '';
    const name = typeof request.name === 'string' ? request.name.trim() : '';
    if (!isFuelSource(source) || code.length === 0 || code.length > CODE_MAX_LENGTH || name.length > NAME_MAX_LENGTH) {
      throw new BadRequestException(errorBody('validation_failed', 'Give the account’s source and code.'));
    }
    const id = await this.prisma.$transaction(async (tx) => {
      await this.lockActor(tx, user);
      const target = await this.lockTarget(tx, user, request.subsidiaryId);
      const [row] = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO fuel_accounts (id, organisation_id, source, code, name, subsidiary_id, state, confirmed_by,
          confirmed_at, created_by, created_at, updated_at)
        VALUES (gen_random_uuid(), ${user.organisationId}::uuid, ${source}, ${code}, ${name.length > 0 ? name : code},
          ${target.id}::uuid, 'confirmed', ${user.id}::uuid, now(), ${user.id}::uuid, now(), now())
        ON CONFLICT (organisation_id, source, code) DO NOTHING
        RETURNING id::text`;
      if (!row) {
        throw new ConflictException(errorBody('fuel_account_exists', 'An account with this source and code already exists.'));
      }
      await this.audit.record(
        user,
        { action: 'create', entity: 'fuel_account', entityId: row.id, diff: { source, code, before: null, after: { subsidiaryId: target.id } } },
        tx,
      );
      return row.id;
    });
    const [dto] = await this.dtos(user, [id]);
    return dto!;
  }

  /**
   * `POST /fuel-accounts/:id/confirm` (C5): a masterkey to any company or
   * associate; a super_admin only the proposal, naming a company it is granted
   * that holds records. A confirmed account's company is changed with PATCH.
   */
  async confirm(user: RequestUser, id: string, request: ConfirmFuelAccountRequest): Promise<FuelAccountDTO> {
    if (!can(user.role, 'fuel_account.confirm_granted') || !user.organisationId) throw new ForbiddenException();
    await this.prisma.$transaction(async (tx) => {
      await this.lockActor(tx, user);
      const account = await this.lockAccount(tx, user, id);
      if (account.state === 'confirmed') {
        if (account.subsidiary_id === request.subsidiaryId) return;
        throw new ConflictException(
          errorBody('fuel_account_exists', 'This account is already mapped; change its company instead.'),
        );
      }
      const target = await this.lockTarget(tx, user, request.subsidiaryId);
      if (!can(user.role, 'fuel_account.write')) {
        // A super_admin: the proposal only, to its own company, never an associate (B6).
        if (account.state !== 'proposed' || account.subsidiary_id !== target.id || target.associate) {
          throw new FuelAccountTargetForbiddenError();
        }
        await this.lockGrant(tx, user, target.id);
      }
      await this.writeMapping(tx, user, account, target, 'confirm');
    });
    const [dto] = await this.dtos(user, [id]);
    return dto!;
  }

  /**
   * `PATCH /fuel-accounts/:id` (masterkey): a change of company, or null to
   * withdraw the mapping — refused while a live row of the account is in a
   * batch or excluded (C14), stating how many.
   */
  async update(user: RequestUser, id: string, request: UpdateFuelAccountRequest): Promise<FuelAccountDTO> {
    if (!can(user.role, 'fuel_account.write') || !user.organisationId) throw new ForbiddenException();
    await this.prisma.$transaction(async (tx) => {
      await this.lockActor(tx, user);
      const account = await this.lockAccount(tx, user, id);
      const [inUse] = await tx.$queryRaw<Array<{ rows: number }>>`
        SELECT count(*)::int AS rows FROM fuel_rows
        WHERE fuel_account_id = ${account.id}::uuid AND state IN ('assigned', 'excluded')`;
      if ((inUse?.rows ?? 0) > 0) {
        throw new ConflictException(
          errorBody('fuel_account_in_use', `${inUse!.rows} rows of this account are in batches or excluded.`, {
            rows: inUse!.rows,
          }),
        );
      }
      const target = request.subsidiaryId === null ? null : await this.lockTarget(tx, user, request.subsidiaryId);
      await this.writeMapping(tx, user, account, target, 'update');
    });
    const [dto] = await this.dtos(user, [id]);
    return dto!;
  }

  /** The mapping, its audit row, and the account's live unbatched rows re-stated by D8's table. */
  private async writeMapping(
    tx: Db,
    user: RequestUser,
    account: LockedAccount,
    target: Target | null,
    action: 'confirm' | 'update',
  ): Promise<void> {
    if (target === null) {
      await tx.$executeRaw`
        UPDATE fuel_accounts SET state = 'unmatched', subsidiary_id = NULL, confirmed_by = NULL, confirmed_at = NULL,
          updated_at = now()
        WHERE id = ${account.id}::uuid`;
    } else {
      await tx.$executeRaw`
        UPDATE fuel_accounts SET state = 'confirmed', subsidiary_id = ${target.id}::uuid, confirmed_by = ${user.id}::uuid,
          confirmed_at = now(), updated_at = now()
        WHERE id = ${account.id}::uuid`;
    }
    const restated = await restateAccountRows(tx, account.id, target);
    await this.audit.record(
      user,
      {
        action,
        entity: 'fuel_account',
        entityId: account.id,
        diff: {
          source: account.source,
          code: account.code,
          before: { state: account.state, subsidiaryId: account.subsidiary_id },
          after: { state: target === null ? 'unmatched' : 'confirmed', subsidiaryId: target?.id ?? null },
          restated,
        },
      },
      tx,
    );
  }

  /** The actor as it stands now: same role and organisation, not disabled. */
  private lockActor(tx: Db, user: RequestUser): Promise<void> {
    return lockActor(tx, user);
  }

  /** A super_admin's grant of the target, read under its lock. */
  private async lockGrant(tx: Db, user: RequestUser, subsidiaryId: string): Promise<void> {
    const [grant] = await tx.$queryRaw<Array<{ ok: number }>>`
      SELECT 1 AS ok FROM user_subsidiary_access
      WHERE user_id = ${user.id}::uuid AND subsidiary_id = ${subsidiaryId}::uuid
        AND organisation_id = ${user.organisationId}::uuid
      FOR SHARE`;
    if (!grant) throw new FuelAccountTargetForbiddenError();
  }

  /** The account's row `FOR UPDATE`, if the reader may read it; otherwise not found. */
  private async lockAccount(tx: Db, user: RequestUser, id: string): Promise<LockedAccount> {
    const [account] = await tx.$queryRaw<LockedAccount[]>`
      SELECT id::text, source, code, state, subsidiary_id::text FROM fuel_accounts
      WHERE id = ${id}::uuid AND organisation_id = ${user.organisationId}::uuid
      FOR UPDATE`;
    if (!account) throw new ResourceNotFoundError('fuel_account_not_found');
    if (!can(user.role, 'fuel_account.read_all') && !readsCompany(user, account.subsidiary_id)) {
      throw new ResourceNotFoundError('fuel_account_not_found');
    }
    return account;
  }

  /** A mapping's target, re-read under a share lock: a company of the organisation that holds records, or an associate. */
  private async lockTarget(tx: Db, user: RequestUser, subsidiaryId: unknown): Promise<Target> {
    if (typeof subsidiaryId !== 'string' || !/^[0-9a-f-]{36}$/i.test(subsidiaryId)) throw new FuelAccountTargetInvalidError();
    const [node] = await tx.$queryRaw<Array<{ node_type: string; control: string }>>`
      SELECT node_type::text, control::text FROM subsidiaries
      WHERE id = ${subsidiaryId}::uuid AND organisation_id = ${user.organisationId}::uuid
      FOR SHARE`;
    if (!node || node.node_type === 'sector_group') throw new FuelAccountTargetInvalidError();
    return { id: subsidiaryId, associate: node.control === 'associate' };
  }

  async dtos(user: RequestUser, ids: readonly string[]): Promise<FuelAccountDTO[]> {
    if (ids.length === 0) return [];
    const accounts = await this.prisma.fuelAccount.findMany({
      where: { id: { in: [...ids] }, organisationId: user.organisationId! },
      include: { subsidiary: { select: { legalName: true, tradingName: true, control: true } } },
    });
    const counts = await this.prisma.$queryRaw<Array<{ fuel_account_id: string; state: string; rows: number; litres: string }>>`
      SELECT r.fuel_account_id::text, r.state, count(*)::int AS rows, sum(r.litres)::text AS litres
      FROM fuel_rows r WHERE r.fuel_account_id = ANY(${[...ids]}::uuid[]) AND r.state <> 'withdrawn'
        -- Only the rows the reader reads: an account's totals never count
        -- another uploader's rows the reader cannot see (WP9 PR B review, P2).
        AND ${fuelRowScopeSql(user, 'r')}
      GROUP BY r.fuel_account_id, r.state`;
    const profiles = await resolveProfiles(this.prisma, accounts.map((a) => a.confirmedBy));
    const order = new Map(ids.map((id, i) => [id, i]));
    return accounts
      .sort((a, b) => order.get(a.id)! - order.get(b.id)!)
      .map((a) => {
        const rows = Object.fromEntries(LIVE_STATES.map((s) => [s, { rows: 0, litres: '0' }])) as Record<
          Exclude<FuelRowState, 'withdrawn'>,
          FuelRowCountDTO
        >;
        for (const c of counts.filter((c) => c.fuel_account_id === a.id)) {
          rows[c.state as Exclude<FuelRowState, 'withdrawn'>] = { rows: c.rows, litres: c.litres };
        }
        const named = readsCompany(user, a.subsidiaryId);
        const control = a.subsidiary?.control ?? null;
        return {
          id: a.id,
          source: a.source as FuelSource,
          code: a.code,
          name: a.name,
          state: a.state as FuelAccountState,
          subsidiaryId: named ? a.subsidiaryId : null,
          subsidiaryName: named && a.subsidiary ? a.subsidiary.tradingName || a.subsidiary.legalName : null,
          subsidiaryIsAssociate: control === 'associate',
          confirmedBy: a.confirmedBy,
          confirmedByName: actorDisplayName(a.confirmedBy, profiles),
          confirmedAt: a.confirmedAt?.toISOString() ?? null,
          rows,
          // C20: excluded rows stay excluded after the company is ticked controlled.
          holdsExcludedOfControlledCompany: rows.excluded.rows > 0 && control === 'controlled',
          canConfirm: a.state !== 'confirmed' && mayConfirm(user, a.state === 'proposed' ? a.subsidiaryId : null, control),
          createdAt: a.createdAt.toISOString(),
          updatedAt: a.updatedAt.toISOString(),
        };
      });
  }
}

/**
 * D8's re-statement after a mapping is written: every live unbatched row of
 * the account takes the mapping's company and its state from the table —
 * excluded under an associate, waiting for a fuel name no rule recognised,
 * otherwise ready (a held row becomes ready again). With no mapping, every
 * such row waits for an account. Answers the rows and litres by new state.
 */
export async function restateAccountRows(
  tx: Pick<Db, '$queryRaw'>,
  accountId: string,
  target: Target | null,
): Promise<Array<{ state: string; rows: number; litres: string }>> {
  return tx.$queryRaw<Array<{ state: string; rows: number; litres: string }>>`
    WITH restated AS (
      UPDATE fuel_rows
      SET subsidiary_id = ${target?.id ?? null}::uuid,
          state = CASE
            WHEN ${target === null} THEN 'waiting_account'
            WHEN ${target?.associate ?? false} THEN 'excluded'
            WHEN fuel IS NULL THEN 'waiting_fuel'
            ELSE 'ready' END,
          hold_reason = NULL, updated_at = now()
      WHERE fuel_account_id = ${accountId}::uuid AND fuel_batch_id IS NULL
        AND state IN ('waiting_account', 'waiting_fuel', 'ready', 'held', 'excluded')
      RETURNING state, litres
    )
    SELECT state, count(*)::int AS rows, sum(litres)::text AS litres FROM restated GROUP BY state ORDER BY state`;
}
