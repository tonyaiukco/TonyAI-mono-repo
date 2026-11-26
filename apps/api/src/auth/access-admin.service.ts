import { createHash, randomUUID } from 'node:crypto';
import { ResourceNotFoundError } from '../common/api-error';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InvitationStatus, Prisma, UserRole as DbUserRole } from '@tonyai/db';
import {
  ACCESS_ASSIGNABLE_ROLES,
  INVITABLE_ROLES,
  ROLE_CHANGE_TARGETS,
  can,
  holdsRecords,
  isCategory,
  isLocale,
  isUserRole,
  singleEntryConflicts,
  type Capability,
  type Category,
  type CentralReporterGrantInput,
  type GrantKind,
  type SingleEntryAccessRow,
  type ConsentKind,
  type Locale,
  type UserAccessGrantDTO,
  type UserRole,
} from '@tonyai/shared-types';
import { AuditService } from '../audit/audit.service';
import { createDefaultSubsidiary } from '../subsidiaries/default-subsidiary';
import { subsidiaryNotAssignable, treeTriggerRefusal } from '../subsidiaries/tree-errors';
import {
  CentralReporterNeedsMainEntityError,
  SingleEntryConflictError,
  accessTriggerRefusal,
} from '../central-reporting/central-reporting-errors';
import { PrismaService } from '../prisma/prisma.service';
import {
  AccessRoleMismatchError,
  AccountDisabledError,
  EmailUnavailableError,
  InvitationClosedError,
  InviteRefusalsExhaustedError,
  OwnAccountError,
  StandardUserSingleCompanyError,
  UserDisabledError,
} from './access-errors';
import type { RequestUser } from './auth.types';

/** What an administrator invites (LP4-01) — validated by the DTO, re-checked here. */
export interface InviteMember {
  email: string;
  fullName: string;
  role: UserRole;
  language: Locale;
  /** The companies granted, and for a standard user their categories. */
  access: UserAccessGrantDTO[];
}

/** What a self-service registration creates — validated by the DTO, re-checked here. */
export interface RegisterOrganisation {
  email: string;
  fullName: string;
  jobTitle: string;
  companyName: string;
  language: Locale;
  consentVersion: string;
}

/** The consent a registration records. */
export const REGISTRATION_CONSENT_KIND: ConsentKind = 'kvkk_registration';
/** What a registered organisation is born with (owner decision 2026-11-11):
 *  the pilot runs on Türkiye's factors. Other values are the operator's. */
export const REGISTRATION_ORGANISATION_DEFAULTS = Object.freeze({
  country: 'TR',
  geographyCode: 'TR',
  reportingCurrency: 'TRY',
});
/** What the audit rows of a registration name as their origin. */
const REGISTRATION_SOURCE = 'auth:registration';

/** The outcome of a disable or enable: whether anything changed. */
export interface EnabledChange {
  changed: boolean;
}

/**
 * The one boundary through which a tenant's roles and subsidiary grants change
 * (LP1-03, F06/F07). LP4-01's onboarding screens and invitation flow call it;
 * nothing else writes `profiles.role` or `user_subsidiary_access`.
 *
 * The rules, each enforced here and — where the database can — again below:
 *  - Who administers whom follows INC-2.6 §6 (design Decision 9): a
 *    `masterkey` invites super_admins (with their companies) and auditors,
 *    changes roles, disables and enables accounts; a `super_admin` invites
 *    standard users into its own companies and sets their company and
 *    categories there. Nobody is made a masterkey here (ruling R1). There is
 *    no cross-tenant administrator: every lookup is bounded by the actor's
 *    own organisation, and an id from another tenant answers 404, exactly as
 *    an id that does not exist (no existence oracle).
 *  - A grant joins a profile and a subsidiary of the SAME organisation — the
 *    composite foreign keys on `user_subsidiary_access` refuse anything else,
 *    whoever writes it.
 *  - A profile never changes organisation (D17): the runtime database role may
 *    UPDATE only `profiles.role`, so not even a bug here could move one.
 *  - Nobody changes their own role, so an organisation is never left without a
 *    `masterkey` by its last one, and nobody promotes themselves.
 *  - A super_admin acts only inside its own grants, re-read under the lock: a
 *    company outside them answers as unknown, and a target's grants outside
 *    them are neither returned nor touched.
 *  - A standard user is assigned one company (ruling R6): an added company
 *    that would leave them holding more than one is refused, counted over all
 *    their grants; withdrawals and category changes always pass.
 *  - The actor is re-read under a per-organisation lock, so an administrator
 *    demoted a moment ago cannot act on the stale role their request was
 *    authenticated with, and two administrators cannot demote each other at
 *    once.
 *  - Only super_admin and standard_user accounts hold grants, and only a
 *    standard user's names categories. Any role change withdraws every grant,
 *    each withdrawal audited: the two granted roles read a grant differently
 *    (every category, or the ticked ones), so nothing is carried.
 *  - Every change writes its audit row in the same transaction.
 *  - LP4-01: an invitation creates its profile, grants and invitation row here
 *    in one transaction (the database first; Auth and the email follow, in
 *    `users/`). Nobody disables their own account, and a disabled actor is
 *    refused under the lock — so an organisation always keeps an active
 *    `masterkey`: the actor, who is one and is never the target.
 *
 * Organisations and first administrators come from two places (owner decision
 * 2026-11-11, replacing D18's "the operator only"): the operator
 * (`pnpm onboarding provision`, on the owner's connection, not through this
 * service) and self-service registration — `registerOrganisation` and
 * `reopenRegistration` below, the two methods here with no actor, called only
 * by the registration service after it has checked the registration code.
 */
@Injectable()
export class AccessAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Changes the role of `profileId`, a member of the actor's organisation
   * other than the actor — a masterkey's power only (INC-2.6 §6, ruling R4).
   * Never to `masterkey` (ruling R1). Every grant the account holds is
   * withdrawn in the same transaction, each audited.
   */
  async setRole(actor: RequestUser, rawProfileId: string, role: UserRole): Promise<void> {
    const organisationId = assertActorMay(actor, 'users.set_role');
    const profileId = canonicalId(rawProfileId);
    if (!isUserRole(role)) throw new BadRequestException('Unknown role');
    if (!(ROLE_CHANGE_TARGETS as readonly string[]).includes(role)) {
      throw new ForbiddenException('Nobody is made a masterkey in the product.');
    }
    if (profileId === actor.id) throw new OwnAccountError('role');
    await this.prisma.$transaction(async (tx) => {
      const admin = await lockAndReadActor(tx, actor, organisationId, 'users.set_role');
      const target = await findMember(tx, organisationId, profileId);
      if (target.role === role) return;
      await tx.profile.update({ where: { id: profileId }, data: { role } });
      await this.audit.record(
        admin,
        { action: 'update', entity: 'profile', entityId: profileId, diff: { before: { role: target.role }, after: { role } } },
        tx,
      );
      // One statement, so the audit names exactly the grants it removed — a
      // subsidiary deleted (or a grant added by the seed) between a read and
      // a delete would otherwise be audited without being removed, or the
      // reverse (`security-rls` round 2).
      const grants = await tx.$queryRaw<{ subsidiaryId: string; kind: string; categories: string[] }[]>`
        DELETE FROM user_subsidiary_access
        WHERE user_id = ${profileId}::uuid AND organisation_id = ${organisationId}::uuid
        RETURNING subsidiary_id::text AS "subsidiaryId", kind, categories`;
      grants.sort((x, y) => x.subsidiaryId.localeCompare(y.subsidiaryId));
      for (const { subsidiaryId, kind, categories } of grants) {
        await this.audit.record(
          admin,
          {
            action: 'delete',
            entity: 'subsidiary_access',
            entityId: profileId,
            // A central reporter grant's row names its kind and the categories
            // it held, as every withdrawal of one does (design D6).
            diff: kind === 'central_reporter'
              ? { subsidiaryId, reason: `role changed from ${target.role} to ${role}`, kind, categories: sortedCategories(categories) }
              : { subsidiaryId, reason: `role changed from ${target.role} to ${role}` },
          },
          tx,
        );
      }
    });
  }

  /**
   * Sets a granted account's access to exactly `access` WITHIN the actor's
   * scope (an access screen's whole selection): a masterkey a super_admin's
   * companies, a super_admin a standard user's company and categories inside
   * its own grants. Grants outside the actor's scope are neither read back
   * nor touched. Each grant added, withdrawn or re-categorised is audited on
   * its own; nothing changed writes nothing.
   */
  async replaceSubsidiaryAccess(actor: RequestUser, rawProfileId: string, access: UserAccessGrantDTO[]): Promise<void> {
    const organisationId = assertActorMay(actor, 'users.set_access');
    const profileId = canonicalId(rawProfileId);
    await mapAccessRefusals(this.prisma.$transaction(async (tx) => {
      const admin = await lockAndReadActor(tx, actor, organisationId, 'users.set_access');
      const target = await findMember(tx, organisationId, profileId);
      assertMaySetAccessOf(admin, target.role, access.length > 0);
      if (!can(target.role, 'scope.granted')) return; // an organisation-wide role, nothing asked: nothing held
      const wanted = normaliseAccess(access, target.role);
      await assertSubsidiaries(tx, organisationId, wanted.map((g) => g.subsidiaryId), admin.scope);
      const heldAll = await tx.userSubsidiaryAccess.findMany({
        where: { userId: profileId, organisationId },
        select: { subsidiaryId: true, categories: true, kind: true },
      });
      const inScope = (id: string) => admin.scope === null || admin.scope.has(id);
      // A scoped actor asking nothing of an account it does not administer
      // (grants, none inside its companies) learns nothing about it either:
      // answered as an unknown account, as its users list hides it (owner's
      // review, P1). Withdrawing its own last visible grant is a different
      // request — that grant is in scope — and is allowed. A central reporter
      // row inside its companies is one it sees (task 3.1), so an empty save
      // of such an account is answered, and changes nothing.
      if (admin.scope !== null && wanted.length === 0 && heldAll.length > 0 && !heldAll.some((g) => inScope(g.subsidiaryId))) {
        throw new ResourceNotFoundError('user_not_found');
      }
      // This request writes `assigned` rows only (design D6): a central
      // reporter grant's rows are neither counted, removed, widened nor
      // re-labelled here — only the masterkey's grant request changes them.
      const assignedAll = heldAll.filter((g) => g.kind !== 'central_reporter');
      const grantRows = heldAll.filter((g) => g.kind === 'central_reporter');
      const held = assignedAll.filter((g) => inScope(g.subsidiaryId));
      const wantedById = new Map(wanted.map((g) => [g.subsidiaryId, g.categories]));
      const heldById = new Map(held.map((g) => [g.subsidiaryId, sortedCategories(g.categories)]));
      const removed = held.map((g) => g.subsidiaryId).filter((id) => !wantedById.has(id)).sort();
      const added = wanted.filter((g) => !heldById.has(g.subsidiaryId));
      const recategorised = can(target.role, 'scope.categories')
        ? wanted.filter((g) => heldById.has(g.subsidiaryId) && !sameList(heldById.get(g.subsidiaryId)!, g.categories))
        : [];
      // One company per standard user (ruling R6), counted over ALL their
      // assigned companies — those the actor cannot see included, a central
      // reporter grant's not. Only an ADDED company is refused: an account
      // carried over with several is edited down, not up.
      const assignedAfter = assignedAll.length - removed.length + added.length;
      if (grantRows.length > 0) {
        // B2: a grant holder keeps exactly one main company outside the grant.
        // Naming a grant company beside the main company is an added second
        // company, as for anyone; any other way of losing the one main
        // company — withdrawn, or moved into the grant — is this refusal.
        const grantIds = new Set(grantRows.map((g) => g.subsidiaryId));
        const namesGrantCompany = added.some((g) => grantIds.has(g.subsidiaryId));
        if (namesGrantCompany && assignedAfter > 1) throw new StandardUserSingleCompanyError();
        if (namesGrantCompany || assignedAfter !== 1) throw new CentralReporterNeedsMainEntityError();
      }
      if (can(target.role, 'scope.categories') && added.length > 0 && assignedAfter > 1) {
        throw new StandardUserSingleCompanyError();
      }
      // Single entry (§4.2): nothing this change opens to the account may be
      // open to the other party at the same company.
      if (can(target.role, 'scope.categories') && (added.length > 0 || recategorised.length > 0)) {
        await assertSingleEntry(tx, organisationId, profileId, target.role, wanted.map((g) => ({ ...g, kind: 'assigned' as const })), admin.scope);
      }
      if (removed.length) {
        await tx.userSubsidiaryAccess.deleteMany({
          where: { userId: profileId, organisationId, subsidiaryId: { in: removed } },
        });
      }
      for (const subsidiaryId of removed) {
        await this.audit.record(
          admin,
          { action: 'delete', entity: 'subsidiary_access', entityId: profileId, diff: { subsidiaryId } },
          tx,
        );
      }
      await createGrants(tx, profileId, organisationId, added);
      for (const grant of added) {
        await this.audit.record(admin, grantCreatedRow(profileId, grant, target.role), tx);
      }
      for (const { subsidiaryId, categories } of recategorised) {
        await tx.userSubsidiaryAccess.update({
          where: { userId_subsidiaryId: { userId: profileId, subsidiaryId } },
          data: { categories },
        });
        await this.audit.record(
          admin,
          {
            action: 'update',
            entity: 'subsidiary_access',
            entityId: profileId,
            diff: { subsidiaryId, before: { categories: heldById.get(subsidiaryId) }, after: { categories } },
          },
          tx,
        );
      }
    }));
  }

  /**
   * A standard user's central reporter grant (INC-2.6 §1, §4.1, §6; design
   * D6), the whole of it: one category list over the companies named, beside
   * the account's one main company. A masterkey's power only
   * (`central_reporter.grant`). Each named company becomes a grant company —
   * an assigned one converted in place (C7: a carried-over account's), a
   * standing grant company re-categorised, any other created; each standing
   * grant company not named is withdrawn; no company withdraws the grant.
   * Exactly one assigned company must be left (B2), and nothing may open a
   * category to both parties (§4.2). One audit row per company changed, with
   * the kind and the categories before and after; nothing changed writes
   * nothing.
   */
  async setCentralReporterGrant(actor: RequestUser, rawProfileId: string, input: CentralReporterGrantInput): Promise<void> {
    const organisationId = assertActorMay(actor, 'central_reporter.grant');
    const profileId = canonicalId(rawProfileId);
    const grant = normaliseGrant(input);
    await mapAccessRefusals(this.prisma.$transaction(async (tx) => {
      const admin = await lockAndReadActor(tx, actor, organisationId, 'central_reporter.grant');
      const target = await findMember(tx, organisationId, profileId);
      if (target.role !== 'standard_user') throw new AccessRoleMismatchError();
      // The masterkey's own organisation, companies that hold records only.
      await assertSubsidiaries(tx, organisationId, grant.subsidiaryIds, null);
      const heldRows = await tx.userSubsidiaryAccess.findMany({
        where: { userId: profileId, organisationId },
        select: { subsidiaryId: true, categories: true, kind: true },
      });
      const held = new Map(heldRows.map((g) => [g.subsidiaryId, { kind: kindOf(g.kind), categories: sortedCategories(g.categories) }]));
      const named = new Set(grant.subsidiaryIds);
      const assignedLeft = heldRows.filter((g) => kindOf(g.kind) === 'assigned' && !named.has(g.subsidiaryId));
      if (grant.subsidiaryIds.length > 0 && assignedLeft.length !== 1) throw new CentralReporterNeedsMainEntityError();

      const proposed = [
        ...assignedLeft.map((g) => ({ subsidiaryId: g.subsidiaryId, categories: sortedCategories(g.categories), kind: 'assigned' as const })),
        ...grant.subsidiaryIds.map((subsidiaryId) => ({ subsidiaryId, categories: grant.categories, kind: 'central_reporter' as const })),
      ];
      await assertSingleEntry(tx, organisationId, profileId, target.role, proposed, null);

      const changes: { subsidiaryId: string; before: GrantRowState | null; after: GrantRowState | null }[] = [];
      for (const subsidiaryId of grant.subsidiaryIds) {
        const before = held.get(subsidiaryId) ?? null;
        const after: GrantRowState = { kind: 'central_reporter', categories: grant.categories };
        if (before && before.kind === after.kind && sameList(before.categories, after.categories)) continue;
        changes.push({ subsidiaryId, before, after });
      }
      for (const [subsidiaryId, before] of held) {
        if (before.kind === 'central_reporter' && !named.has(subsidiaryId)) changes.push({ subsidiaryId, before, after: null });
      }
      changes.sort((x, y) => x.subsidiaryId.localeCompare(y.subsidiaryId));
      // Withdrawals first, then conversions and re-categorisations, then new
      // rows: the order in which no step needs a row another step removes.
      const withdrawn = changes.filter((c) => c.after === null).map((c) => c.subsidiaryId);
      if (withdrawn.length) {
        await tx.userSubsidiaryAccess.deleteMany({ where: { userId: profileId, organisationId, subsidiaryId: { in: withdrawn } } });
      }
      for (const c of changes) {
        if (c.after === null || c.before === null) continue;
        await tx.userSubsidiaryAccess.update({
          where: { userId_subsidiaryId: { userId: profileId, subsidiaryId: c.subsidiaryId } },
          data: { kind: c.after.kind, categories: c.after.categories },
        });
      }
      const created = changes.filter((c) => c.before === null && c.after !== null);
      if (created.length) {
        try {
          await tx.userSubsidiaryAccess.createMany({
            data: created.map((c) => ({
              userId: profileId, subsidiaryId: c.subsidiaryId, organisationId, kind: 'central_reporter', categories: grant.categories,
            })),
          });
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
            throw new ResourceNotFoundError('subsidiary_not_found');
          }
          throw treeTriggerRefusal(err) ?? err;
        }
      }
      for (const c of changes) {
        await this.audit.record(admin, grantChangeRow(profileId, c.subsidiaryId, c.before, c.after), tx);
      }
    }));
  }

  /**
   * inc26-group-tree (design D5, ruling R6): a super_admin creating a child
   * company under one of its companies. Called by `SubsidiariesService.create`
   * inside its transaction BEFORE the node is written: takes the
   * organisation's administration lock and re-reads the actor, so a
   * super_admin whose grant on the parent was withdrawn a moment ago — or who
   * was demoted or disabled — creates nothing. A parent outside its grants
   * answers as an unknown company.
   */
  async lockChildCompanyCreator(tx: Prisma.TransactionClient, actor: RequestUser, parentId: string): Promise<void> {
    const organisationId = assertActorMay(actor, 'company.create_child');
    const admin = await lockAndReadActor(tx, actor, organisationId, 'company.create_child');
    if (admin.scope !== null && !admin.scope.has(parentId)) throw new ResourceNotFoundError('subsidiary_not_found');
  }

  /**
   * The same step's grant (D5): the super_admin who created child company
   * `subsidiaryId` is granted it, with its `subsidiary_access` audit row, in
   * the caller's transaction — so if the grant cannot be stored, the company
   * is not stored either. No other account gains access by the creation.
   */
  async grantChildCompanyCreator(tx: Prisma.TransactionClient, actor: RequestUser, subsidiaryId: string): Promise<void> {
    const organisationId = assertActorMay(actor, 'company.create_child');
    if (!can(actor.role, 'scope.granted')) return; // a masterkey reads the whole organisation already
    const grant: AccessGrant = { subsidiaryId, categories: [] };
    await createGrants(tx, actor.id, organisationId, [grant]);
    await this.audit.record(actor, grantCreatedRow(actor.id, grant, actor.role), tx);
  }

  /**
   * LP4-01: creates an invited account — its profile (the Auth user's id
   * chosen here, so the database is written before Auth, K4), its grants and
   * its invitation — in one audited transaction. Delivery (the Auth user, the
   * link, the email) follows outside it and is retried from the invitation's
   * state. The audit names the role, language and grants, never the address
   * or the name: the trail has no correction path (D20).
   */
  async inviteMember(actor: RequestUser, input: InviteMember): Promise<{ profileId: string }> {
    const organisationId = assertActorMay(actor, 'users.invite');
    if (!isUserRole(input.role)) throw new BadRequestException('Unknown role');
    if (!isLocale(input.language)) throw new BadRequestException('Unsupported language');
    assertMayInvite(actor.role, input.role);
    const email = normaliseEmail(input.email);
    const access = normaliseAccess(input.access, input.role);
    // One company per standard user (ruling R6): an invitation names at most one.
    if (can(input.role, 'scope.categories') && access.length > 1) throw new StandardUserSingleCompanyError();
    const subsidiaryIds = access.map((g) => g.subsidiaryId);
    const profileId = randomUUID();
    let outcome: 'created' | 'refused';
    try {
      outcome = await this.prisma.$transaction(async (tx) => {
        const admin = await lockAndReadActor(tx, actor, organisationId, 'users.invite');
        // Re-checked on the role read under the lock.
        assertMayInvite(admin.role, input.role);
        // The request's own companies first, so a refusal about them never
        // depends on whether some address exists. A super_admin names only
        // its own; any other answers as unknown.
        await assertSubsidiaries(tx, organisationId, subsidiaryIds, admin.scope);
        // Past its bound, the organisation learns nothing more about any
        // address, new or taken: refused before the lookup (`account-access`).
        await assertInviteRefusalBound(tx, organisationId);
        // D17: one organisation per account — an address with a profile anywhere
        // is unavailable. Exact equality on the stored spelling (CHECK
        // `profiles_email_normalised`), never a pattern; the unique index
        // catches the race between tenants. The refusal is audited and
        // committed — never the address — and only then answered.
        const taken = await tx.profile.findUnique({ where: { email }, select: { id: true } });
        if (taken) {
          await this.recordInviteRefusal(tx, admin);
          return 'refused' as const;
        }
        await tx.profile.create({
          data: {
            id: profileId,
            email,
            fullName: input.fullName.trim(),
            role: input.role,
            language: input.language,
            organisationId,
          },
        });
        // Single entry (§4.2): the invited user's categories may not be open
        // to a central reporter at the same company.
        if (can(input.role, 'scope.categories')) {
          await assertSingleEntry(tx, organisationId, profileId, input.role, access.map((g) => ({ ...g, kind: 'assigned' as const })), admin.scope);
        }
        await createGrants(tx, profileId, organisationId, access);
        await tx.invitation.create({ data: { profileId, language: input.language, invitedBy: admin.id } });
        await this.audit.record(
          admin,
          {
            action: 'invite',
            entity: 'invitation',
            entityId: profileId,
            diff: { role: input.role, language: input.language, subsidiaryIds },
          },
          tx,
        );
        for (const grant of access) {
          await this.audit.record(admin, grantCreatedRow(profileId, grant, input.role), tx);
        }
        return 'created' as const;
      });
    } catch (err) {
      // A grant raced by another access write: the database's single-entry
      // refusal answered as the API's own.
      const raced = accessTriggerRefusal(err);
      if (raced) throw raced;
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Another tenant took the address between the lookup and the insert:
        // the same refusal, audited in a transaction of its own. The lock was
        // released with the first transaction, so the bound is counted again
        // under it: another request of this organisation may have used the
        // last refusal meanwhile (Codex review).
        await this.prisma.$transaction(async (tx) => {
          const admin = await lockAndReadActor(tx, actor, organisationId, 'users.invite');
          await assertInviteRefusalBound(tx, organisationId);
          await this.recordInviteRefusal(tx, admin);
        });
        throw new EmailUnavailableError();
      }
      throw err;
    }
    if (outcome === 'refused') throw new EmailUnavailableError();
    return { profileId };
  }

  /**
   * One `invite_refused` row for the inviting organisation — the reason, never
   * the address. These rows are the bound's state (`assertInviteRefusalBound`):
   * an audit writer that ever turns asynchronous would silently lift the bound.
   */
  private async recordInviteRefusal(tx: Prisma.TransactionClient, admin: RequestUser): Promise<void> {
    await this.audit.record(
      admin,
      { action: 'invite_refused', entity: 'invitation', entityId: null, diff: { reason: 'email_unavailable' } },
      tx,
    );
  }

  /**
   * Self-service registration: creates an organisation, its default
   * subsidiary (named by the company, so a facility can be added at once —
   * UAT round 2, K1), its first `masterkey`, that account's invitation and
   * the consent it gave — in one audited transaction, all or nothing. There is
   * no actor: the caller is the public registration endpoint, which has
   * already checked the registration code. Delivery follows outside, as for an
   * invitation. The audit rows name the defaults, role, language and notice
   * version — never the address, the name, the job title or the company (D20). An address that already has a
   * profile anywhere is refused (D17), the unique index catching a race.
   */
  async registerOrganisation(input: RegisterOrganisation): Promise<{ organisationId: string; profileId: string }> {
    if (!isLocale(input.language)) throw new BadRequestException('Unsupported language');
    const email = normaliseEmail(input.email);
    const profileId = randomUUID();
    try {
      const organisationId = await this.prisma.$transaction(async (tx) => {
        const taken = await tx.profile.findUnique({ where: { email }, select: { id: true } });
        if (taken) throw new EmailUnavailableError();
        const organisation = await tx.organisation.create({
          data: { legalName: input.companyName.trim(), ...REGISTRATION_ORGANISATION_DEFAULTS },
          select: { id: true },
        });
        await this.audit.recordSystem(
          {
            organisationId: organisation.id,
            action: 'create',
            entity: 'organisation',
            entityId: organisation.id,
            diff: { source: REGISTRATION_SOURCE, ...REGISTRATION_ORGANISATION_DEFAULTS },
          },
          tx,
        );
        await createDefaultSubsidiary(tx, this.audit, {
          organisationId: organisation.id,
          legalName: input.companyName.trim(),
          geographyCode: REGISTRATION_ORGANISATION_DEFAULTS.geographyCode,
          source: { source: REGISTRATION_SOURCE },
        });
        await tx.profile.create({
          data: {
            id: profileId,
            email,
            fullName: input.fullName.trim(),
            jobTitle: input.jobTitle.trim(),
            role: DbUserRole.masterkey,
            language: input.language,
            organisationId: organisation.id,
          },
        });
        await tx.invitation.create({ data: { profileId, language: input.language, invitedBy: null } });
        await this.audit.recordSystem(
          {
            organisationId: organisation.id,
            action: 'invite',
            entity: 'invitation',
            entityId: profileId,
            diff: { source: REGISTRATION_SOURCE, role: DbUserRole.masterkey, language: input.language, subsidiaryIds: [] },
          },
          tx,
        );
        await tx.consent.create({
          data: { profileId, kind: REGISTRATION_CONSENT_KIND, textVersion: input.consentVersion, language: input.language },
        });
        await this.audit.recordSystem(
          {
            organisationId: organisation.id,
            action: 'create',
            entity: 'consent',
            entityId: profileId,
            diff: { source: REGISTRATION_SOURCE, kind: REGISTRATION_CONSENT_KIND, textVersion: input.consentVersion, language: input.language },
          },
          tx,
        );
        return organisation.id;
      });
      return { organisationId, profileId };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new EmailUnavailableError();
      throw err;
    }
  }

  /**
   * Self-service registration, submitted again for an address whose invitation
   * is not accepted: re-opens that invitation for a fresh link — only a
   * registered account's (it holds a registration consent), enabled, in an
   * active organisation, only outside the cooldown since its last attempt, and
   * only while it has had fewer than `maxAttempts` deliveries — the address
   * may not be the submitter's, so the emails it can be sent are bounded.
   * One statement claims the cooldown, so two submissions at once re-send
   * once. False when nothing was re-opened; no actor, as above.
   */
  async reopenRegistration(rawProfileId: string, cooldownSeconds: number, maxAttempts: number): Promise<boolean> {
    const profileId = canonicalId(rawProfileId);
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.$queryRaw<{ organisation_id: string; before: string }[]>`
        WITH target AS (
          SELECT i.profile_id, i.status::text AS before, p.organisation_id
          FROM invitations i
          JOIN profiles p ON p.id = i.profile_id
          JOIN organisations o ON o.id = p.organisation_id
          WHERE i.profile_id = ${profileId}::uuid
            AND i.status IN ('pending', 'sent')
            AND i.invited_by IS NULL
            AND p.disabled_at IS NULL
            AND o.offboarded_at IS NULL
            AND EXISTS (SELECT 1 FROM consents c WHERE c.profile_id = p.id AND c.kind = ${REGISTRATION_CONSENT_KIND})
            AND COALESCE(GREATEST(i.sent_at, i.last_attempt_at), i.created_at) <= now() - make_interval(secs => ${cooldownSeconds})
            AND i.attempts < ${maxAttempts}
          FOR UPDATE OF i
        )
        UPDATE invitations i
        SET status = 'pending', last_attempt_at = now(), updated_at = now()
        FROM target
        WHERE i.profile_id = target.profile_id
        RETURNING target.organisation_id::text AS organisation_id, target.before`;
      if (claimed.length !== 1) return false;
      await this.audit.recordSystem(
        {
          organisationId: claimed[0].organisation_id,
          action: 'invite',
          entity: 'invitation',
          entityId: profileId,
          diff: { source: REGISTRATION_SOURCE, resend: true, before: { status: claimed[0].before } },
        },
        tx,
      );
      return true;
    });
  }

  /**
   * Re-opens an invitation for a re-send: a revoked one (its account since
   * enabled) becomes pending again. Refused once accepted, or while the
   * account is disabled.
   */
  async reopenInvitation(actor: RequestUser, rawProfileId: string): Promise<void> {
    const organisationId = assertActorMay(actor, 'users.invite');
    const profileId = canonicalId(rawProfileId);
    await this.prisma.$transaction(async (tx) => {
      const admin = await lockAndReadActor(tx, actor, organisationId, 'users.invite');
      const target = await findMember(tx, organisationId, profileId);
      // Re-sending is inviting again: the actor must be one who may invite
      // the account's role — and a super_admin only an account it
      // administers (a grant in its companies, or none), the users list's rule.
      assertMayInvite(admin.role, target.role);
      if (admin.scope !== null) {
        const grants = await tx.userSubsidiaryAccess.findMany({
          where: { userId: profileId, organisationId },
          select: { subsidiaryId: true },
        });
        if (grants.length > 0 && !grants.some((g) => admin.scope!.has(g.subsidiaryId))) {
          throw new ResourceNotFoundError('user_not_found');
        }
      }
      const invitation = await tx.invitation.findUnique({ where: { profileId }, select: { status: true } });
      if (!invitation) throw new ResourceNotFoundError('invitation_not_found');
      if (invitation.status === InvitationStatus.accepted) throw new InvitationClosedError();
      if (target.disabledAt) throw new UserDisabledError();
      await tx.invitation.update({
        where: { profileId },
        data: { status: InvitationStatus.pending, revokedAt: null },
      });
      await this.audit.record(
        admin,
        { action: 'invite', entity: 'invitation', entityId: profileId, diff: { resend: true, before: { status: invitation.status } } },
        tx,
      );
    });
  }

  /**
   * D19: disables a member of the actor's organisation — the guard refuses
   * them from their next request — and withdraws an invitation not yet
   * accepted. Flags Supabase Auth's ban as pending in the same transaction
   * (K4); the caller then applies it. Idempotent.
   */
  async disableMember(actor: RequestUser, rawProfileId: string): Promise<EnabledChange> {
    const organisationId = assertActorMay(actor, 'users.disable');
    const profileId = canonicalId(rawProfileId);
    if (profileId === actor.id) throw new OwnAccountError('disable');
    return this.prisma.$transaction(async (tx) => {
      const admin = await lockAndReadActor(tx, actor, organisationId, 'users.disable');
      const target = await findMember(tx, organisationId, profileId);
      if (target.disabledAt) return { changed: false };
      const now = new Date();
      await tx.profile.update({
        where: { id: profileId },
        // Every access token issued so far dies with this (the guard holds them
        // to `sessions_revoked_at`), and Auth has a new change to catch up with.
        data: { disabledAt: now, sessionsRevokedAt: now, authSyncPendingSince: now, authSyncGeneration: { increment: 1 } },
      });
      const { count: revoked } = await tx.invitation.updateMany({
        where: { profileId, status: { in: [InvitationStatus.pending, InvitationStatus.sent] } },
        data: { status: InvitationStatus.revoked, revokedAt: now },
      });
      await this.audit.record(
        admin,
        { action: 'disable', entity: 'profile', entityId: profileId, diff: { invitationRevoked: revoked > 0 } },
        tx,
      );
      return { changed: true };
    });
  }

  /** Re-enables a disabled member; Auth's unban is flagged pending (K4). Idempotent. */
  async enableMember(actor: RequestUser, rawProfileId: string): Promise<EnabledChange> {
    const organisationId = assertActorMay(actor, 'users.disable');
    const profileId = canonicalId(rawProfileId);
    return this.prisma.$transaction(async (tx) => {
      const admin = await lockAndReadActor(tx, actor, organisationId, 'users.disable');
      const target = await findMember(tx, organisationId, profileId);
      if (!target.disabledAt) return { changed: false };
      const now = new Date();
      await tx.profile.update({
        where: { id: profileId },
        // The boundary moves to the enable too: a session begun while the
        // account was disabled — through one Auth still honoured, before its
        // ban landed or because it failed — is refused like the older ones
        // (security re-review P2). No legitimate session outlives an enable:
        // its sync replaces the password and Auth ends every session.
        data: { disabledAt: null, sessionsRevokedAt: now, authSyncPendingSince: now, authSyncGeneration: { increment: 1 } },
      });
      await this.audit.record(admin, { action: 'enable', entity: 'profile', entityId: profileId }, tx);
      return { changed: true };
    });
  }
}

/**
 * An id as the database spells it (lowercase). Postgres matches either case,
 * but this service compares ids as strings ("the actor's own account?") and
 * writes them into audit rows, so one spelling is used throughout — an
 * uppercase spelling of one's own id must not pass for another account's.
 */
function canonicalId(id: string): string {
  return id.toLowerCase();
}

/** Addresses compare without case or surrounding space; stored lower-case. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Every id a subsidiary of `organisationId` AND, for a scoped actor, one of
 * its own grants; any other — another tenant's, or a company of the
 * organisation the actor is not granted — is 404, as one that does not exist.
 */
async function assertSubsidiaries(
  tx: Prisma.TransactionClient,
  organisationId: string,
  ids: string[],
  scope: ReadonlySet<string> | null,
): Promise<void> {
  if (!ids.length) return;
  if (scope !== null && ids.some((id) => !scope.has(id))) throw new ResourceNotFoundError('subsidiary_not_found');
  const found = await tx.subsidiary.findMany({
    where: { id: { in: ids }, organisationId },
    select: { nodeType: true, control: true },
  });
  if (found.length !== ids.length) throw new ResourceNotFoundError('subsidiary_not_found');
  // No account is assigned to an associate or a sector group (inc26-group-tree,
  // INC-2.6 §6: never to an associate; design D6) — after the scope and tenant
  // checks, so a foreign id still answers as unknown. TA020 holds it for
  // every writer.
  if (found.some((node) => !holdsRecords(node))) throw subsidiaryNotAssignable();
}

/** A grant as the service handles it: canonical id, sorted unique categories. */
interface AccessGrant {
  subsidiaryId: string;
  categories: Category[];
}

function sortedCategories(categories: readonly string[]): Category[] {
  return [...new Set(categories.filter(isCategory))].sort();
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * The request's grants for an account of `role`: each company once, each
 * category one of `CATEGORIES` (400 otherwise), stored sorted and unique.
 * Categories belong to a standard user's grant only, and grants to the two
 * granted roles only (`access_role_mismatch`).
 */
function normaliseAccess(access: readonly UserAccessGrantDTO[] | undefined, role: string): AccessGrant[] {
  const list = access ?? [];
  if (!list.length) return [];
  if (!can(role, 'scope.granted')) throw new AccessRoleMismatchError();
  const seen = new Set<string>();
  const out: AccessGrant[] = [];
  for (const grant of list) {
    const subsidiaryId = canonicalId(grant.subsidiaryId);
    if (seen.has(subsidiaryId)) throw new BadRequestException('Each company may appear once');
    seen.add(subsidiaryId);
    const categories = grant.categories ?? [];
    if (categories.some((c) => !isCategory(c))) throw new BadRequestException('Unknown category');
    if (!can(role, 'scope.categories') && categories.length) throw new AccessRoleMismatchError();
    out.push({ subsidiaryId, categories: sortedCategories(categories) });
  }
  return out.sort((x, y) => x.subsidiaryId.localeCompare(y.subsidiaryId));
}

/** The audit row of a grant added: the company, and a standard user's categories. */
function grantCreatedRow(profileId: string, grant: AccessGrant, role: string) {
  return {
    action: 'create' as const,
    entity: 'subsidiary_access' as const,
    entityId: profileId,
    diff: can(role, 'scope.categories')
      ? { subsidiaryId: grant.subsidiaryId, categories: grant.categories }
      : { subsidiaryId: grant.subsidiaryId },
  };
}

async function createGrants(
  tx: Prisma.TransactionClient,
  profileId: string,
  organisationId: string,
  grants: AccessGrant[],
): Promise<void> {
  if (!grants.length) return;
  try {
    await tx.userSubsidiaryAccess.createMany({
      data: grants.map(({ subsidiaryId, categories }) => ({ userId: profileId, subsidiaryId, organisationId, categories })),
    });
  } catch (err) {
    // A subsidiary deleted after the check above (its delete takes no lock here).
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
      throw new ResourceNotFoundError('subsidiary_not_found');
    }
    // Ticked associate after the check above: TA020 refused the grant; a
    // category opened to the other party meanwhile: TA024.
    throw treeTriggerRefusal(err) ?? accessTriggerRefusal(err) ?? err;
  }
}

/** A stored kind as the service reads it: anything but a grant row is assigned. */
function kindOf(kind: string): GrantKind {
  return kind === 'central_reporter' ? 'central_reporter' : 'assigned';
}

/** An access row's kind and categories, before or after a grant change. */
interface GrantRowState {
  kind: GrantKind;
  categories: Category[];
}

/**
 * The grant request's input: each company once (400 otherwise), canonical
 * ids, each category one of `CATEGORIES`, stored sorted and unique. Companies
 * with no category are invalid input (§4.1: one category list per grant); no
 * company is a withdrawal, whatever the list.
 */
function normaliseGrant(input: CentralReporterGrantInput): { subsidiaryIds: string[]; categories: Category[] } {
  const ids = (input.subsidiaryIds ?? []).map(canonicalId);
  if (new Set(ids).size !== ids.length) throw new BadRequestException('Each company may appear once');
  const raw = input.categories ?? [];
  if (raw.some((c) => !isCategory(c))) throw new BadRequestException('Unknown category');
  const categories = sortedCategories(raw);
  if (ids.length > 0 && categories.length === 0) throw new BadRequestException('A central reporter grant names at least one category');
  return { subsidiaryIds: [...ids].sort(), categories: ids.length > 0 ? categories : [] };
}

/** The audit row of one company of a grant changed: its kind and categories before and after, never an address or a name. */
function grantChangeRow(profileId: string, subsidiaryId: string, before: GrantRowState | null, after: GrantRowState | null) {
  const state = (s: GrantRowState) => ({ kind: s.kind, categories: s.categories });
  if (before === null && after !== null) {
    return { action: 'create' as const, entity: 'subsidiary_access' as const, entityId: profileId, diff: { subsidiaryId, ...state(after) } };
  }
  if (after === null && before !== null) {
    return { action: 'delete' as const, entity: 'subsidiary_access' as const, entityId: profileId, diff: { subsidiaryId, ...state(before) } };
  }
  return {
    action: 'update' as const,
    entity: 'subsidiary_access' as const,
    entityId: profileId,
    diff: { subsidiaryId, before: state(before!), after: state(after!) },
  };
}

/**
 * Single entry, what is opened (§4.2; design D4): `proposed` is every access
 * row `profileId` would hold after the write; the other accounts' rows at
 * those companies are read in the same transaction, under the administrative
 * lock the caller holds. A conflict is refused with `single_entry_conflict`,
 * its list limited to companies `scope` reads (null: all). TA024 holds the
 * same rule for every writer and a race.
 */
async function assertSingleEntry(
  tx: Prisma.TransactionClient,
  organisationId: string,
  profileId: string,
  holderRole: string,
  proposed: readonly { subsidiaryId: string; categories: readonly Category[]; kind: GrantKind }[],
  scope: ReadonlySet<string> | null,
): Promise<void> {
  if (holderRole !== 'standard_user' || proposed.length === 0) return;
  const companies = [...new Set(proposed.map((r) => r.subsidiaryId))];
  const others = await tx.userSubsidiaryAccess.findMany({
    where: { organisationId, subsidiaryId: { in: companies }, userId: { not: profileId } },
    select: { userId: true, subsidiaryId: true, kind: true, categories: true, profile: { select: { role: true } } },
  });
  const standing: SingleEntryAccessRow[] = others.map((r) => ({
    userId: r.userId,
    subsidiaryId: r.subsidiaryId,
    kind: kindOf(r.kind),
    categories: sortedCategories(r.categories),
    holderRole: r.profile.role,
  }));
  const conflicts = singleEntryConflicts(
    standing,
    proposed.map((r) => ({ userId: profileId, subsidiaryId: r.subsidiaryId, kind: r.kind, categories: r.categories, holderRole })),
  );
  if (conflicts.length === 0) return;
  throw new SingleEntryConflictError(conflicts[0]!.side, conflictsVisibleTo(conflicts, scope));
}

/**
 * The conflicts a refusal lists: only companies its reader may read (null: the
 * whole organisation), as identifiers, never an account (design D4). The
 * companies a request names are inside its reader's scope already; this holds
 * the rule should that ever change.
 */
export function conflictsVisibleTo(
  conflicts: readonly { subsidiaryId: string; categories: readonly Category[] }[],
  scope: ReadonlySet<string> | null,
): { subsidiaryId: string; categories: Category[] }[] {
  return conflicts
    .filter((c) => scope === null || scope.has(c.subsidiaryId))
    .map((c) => ({ subsidiaryId: c.subsidiaryId, categories: [...c.categories] }));
}

/** A write's database refusals answered as the API's own: TA024's single entry. */
async function mapAccessRefusals<T>(write: Promise<T>): Promise<T> {
  try {
    return await write;
  } catch (err) {
    throw accessTriggerRefusal(err) ?? err;
  }
}

// The first key of the two-int advisory-lock form, so these locks share no key
// with the lifecycle protocol's period locks ("TPLK") — "TADM".
const TENANT_ADMIN_LOCK_NAMESPACE = 0x5441444d;

/** An organisation's advisory-lock key: 32 bits of a SHA-256 of its id. */
export function tenantAdminLockKey(organisationId: string): number {
  // Lowercased here too: every caller must reach the same key for one
  // organisation, whatever spelling of its id it holds (`architect` re-review).
  return createHash('sha256').update(organisationId.toLowerCase()).digest().readInt32BE(0);
}

/** The actor's organisation, when the actor's role holds `capability` at all. */
function assertActorMay(actor: RequestUser, capability: Capability): string {
  if (!actor.organisationId || !can(actor.role, capability)) {
    throw new ForbiddenException(REFUSAL[capability] ?? 'Your role may not manage accounts.');
  }
  return actor.organisationId;
}

const REFUSAL: Partial<Record<Capability, string>> = {
  'users.invite': 'Only a masterkey or a super_admin invites accounts.',
  'users.set_access': 'Only a masterkey or a super_admin sets access.',
  'users.set_role': 'Only a masterkey changes roles.',
  'users.disable': 'Only a masterkey disables or enables accounts.',
};

/** A masterkey invites super_admins and auditors, a super_admin standard
 *  users; nobody invites a masterkey (design Decision 9, ruling R1). */
function assertMayInvite(actorRole: string, role: string): void {
  const allowed = isUserRole(actorRole) ? INVITABLE_ROLES[actorRole] : [];
  if (!(allowed as readonly string[]).includes(role)) {
    throw new ForbiddenException(
      role === 'masterkey'
        ? 'Nobody is made a masterkey in the product.'
        : `A ${actorRole} may not invite a ${role}.`,
    );
  }
}

/**
 * Whose access the actor sets: a masterkey a super_admin's, a super_admin a
 * standard user's (ruling R3). An organisation-wide target answers
 * `access_role_mismatch` when access is asked for it, and nothing otherwise.
 */
function assertMaySetAccessOf(admin: AdminActor, targetRole: string, asksForAccess: boolean): void {
  const assignable = isUserRole(admin.role) ? ACCESS_ASSIGNABLE_ROLES[admin.role] : [];
  // A scoped actor administers only the roles it assigns: any other account
  // answers as one it cannot see, as its users list and summary do — never
  // revealing which accounts are organisation-wide.
  if (admin.scope !== null && !(assignable as readonly string[]).includes(targetRole)) {
    throw new ResourceNotFoundError('user_not_found');
  }
  if (!can(targetRole, 'scope.granted')) {
    if (asksForAccess) throw new AccessRoleMismatchError();
    return;
  }
  if (!(assignable as readonly string[]).includes(targetRole)) {
    throw new ForbiddenException(
      admin.role === 'masterkey'
        ? 'A super_admin of the company sets a standard user\'s company and categories.'
        : `A ${admin.role} may not set a ${targetRole}'s access.`,
    );
  }
}

/**
 * The organisation's administrative lock, held until the transaction ends.
 * Every change through this service takes it, and so does the operator's
 * offboarding (LP4-01), so an invitation or an enable cannot slip past an
 * offboarding that is disabling everyone.
 */
export async function lockTenantAdmin(tx: Prisma.TransactionClient, organisationId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${TENANT_ADMIN_LOCK_NAMESPACE}::int4, ${tenantAdminLockKey(organisationId)}::int4)`;
}

/** Refusals an organisation may meet within an hour before every invitation is refused (`account-access`). */
export const INVITE_REFUSALS_PER_HOUR = 5;

/**
 * The invite route answers whether an address has an account anywhere (D17),
 * and self-service registration makes a `masterkey` of anyone holding the
 * code. So an organisation's `invite_refused` rows of the last hour bound it:
 * at `INVITE_REFUSALS_PER_HOUR`, every invitation is refused 429 before the
 * address is looked up, until the oldest ages out. Counted on the database's
 * clock, which also stamps the rows; run under the tenant lock, so one
 * organisation's invitations cannot race past the bound.
 */
async function assertInviteRefusalBound(tx: Prisma.TransactionClient, organisationId: string): Promise<void> {
  // The database's clock — the one `created_at` defaults to — read without
  // naming the trail in raw SQL (the append-only guard forbids that).
  const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  const { _count: refusals, _min: { createdAt: oldest } } = await tx.auditLog.aggregate({
    where: { organisationId, action: 'invite_refused', createdAt: { gt: new Date(now.getTime() - 3_600_000) } },
    _count: true,
    _min: { createdAt: true },
  });
  if (refusals >= INVITE_REFUSALS_PER_HOUR) {
    const retryAfter = oldest ? Math.max(1, Math.ceil((oldest.getTime() + 3_600_000 - now.getTime()) / 1000)) : 3600;
    throw new InviteRefusalsExhaustedError(retryAfter);
  }
}

/**
 * Serialises every administrative change within one organisation, then
 * re-reads the actor: the role the request was authenticated with may have
 * been withdrawn since.
 */
/** The actor as re-read under the lock, with its scope: null for the whole
 *  organisation (a masterkey), else its own same-organisation grants. */
interface AdminActor extends RequestUser {
  scope: ReadonlySet<string> | null;
}

/**
 * The organisation's administrative lock, then the actor as it stands now: its
 * role (holding `capability`) and, for a scoped role, its companies. A write
 * another module gates on a company grant re-checks it here, so a grant
 * withdrawn while the request waited no longer lets it through (the boundary
 * declarations; owner review of WP7, P2).
 */
export async function lockAndReadActor(
  tx: Prisma.TransactionClient,
  actor: RequestUser,
  organisationId: string,
  capability: Capability,
): Promise<AdminActor> {
  await lockTenantAdmin(tx, organisationId);
  const current = await tx.profile.findUnique({
    where: { id: actor.id },
    select: {
      role: true,
      organisationId: true,
      disabledAt: true,
      organisation: { select: { offboardedAt: true } },
      subsidiaryAccess: { where: { organisationId }, select: { subsidiaryId: true } },
    },
  });
  // Disabled — or the organisation offboarded — since the guard admitted the
  // request (D19, K6): the same answer the guard gives, so the session ends
  // rather than acting once more.
  if (current?.disabledAt || current?.organisation?.offboardedAt) throw new AccountDisabledError();
  if (!current || current.organisationId !== organisationId || !can(current.role, capability)) {
    throw new ForbiddenException(REFUSAL[capability] ?? 'Your role may not manage accounts.');
  }
  // A scoped actor's companies as they stand now, not as authenticated.
  const scope = can(current.role, 'scope.granted')
    ? new Set((current.subsidiaryAccess ?? []).map((g) => g.subsidiaryId))
    : null;
  return { ...actor, role: current.role, scope };
}

/** A profile of `organisationId`; any other id — another tenant's included — is 404. */
async function findMember(tx: Prisma.TransactionClient, organisationId: string, profileId: string) {
  const member = await tx.profile.findFirst({
    where: { id: profileId, organisationId },
    select: { id: true, role: true, disabledAt: true },
  });
  if (!member) throw new ResourceNotFoundError('user_not_found');
  return member;
}
