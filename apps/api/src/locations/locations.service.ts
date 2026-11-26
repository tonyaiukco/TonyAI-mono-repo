import {
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Prisma, type Location, type Subsidiary } from '@tonyai/db';
import type { LocationDTO } from '@tonyai/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { boundaryGuardRefused } from '../inventory-boundary/errors';
import { errorBody, ResourceNotFoundError } from '../common/api-error';
import { lockAndReadActor } from '../auth/access-admin.service';
// `CreateSubsidiaryLocationDto` is the base of `CreateLocationDto` and is what
// the shared writer takes: the parameter used to build its own
// `Omit<CreateLocationDto, 'subsidiaryId'>`, which made the shape's THIRD
// declaration. One contract type and one validator class is the floor.
import {
  CreateLocationDto,
  CreateSubsidiaryLocationDto,
} from './dto/create-location.dto';
import { UpdateLocationDto } from './dto/update-location.dto';
import { can } from '@tonyai/shared-types';
import { CalculationsService } from '../calculations/calculations.service';
import { assertPricedGeography } from '../common/priced-geography';
import { nodePlacementInvalid, treeTriggerRefusal } from '../subsidiaries/tree-errors';

/**
 * A subsidiary that some caller has already established the right to write to.
 *
 * The point is the private constructor: a third caller cannot simply pass a
 * string, it has to ADD a factory here — a visible, reviewable act rather than
 * an injection and one more argument. The safety of
 * `writeLocationForTrustedParent` was otherwise carried entirely by its name.
 */
export class TrustedParent {
  private constructor(readonly subsidiaryId: string) {}

  /** The caller checked the role AND `accessibleSubsidiaryIds` first. */
  static becauseInAccessibleSet(user: RequestUser, subsidiaryId: string): TrustedParent {
    if (!user.accessibleSubsidiaryIds.includes(subsidiaryId)) {
      throw new ResourceNotFoundError('subsidiary_not_found');
    }
    return new TrustedParent(subsidiaryId);
  }

  /**
   * The caller is creating the parent, in this transaction, under its own
   * organisation — so there is no accessible set to consult yet.
   *
   * Typed against the Prisma model, not `{ id: string }`. The looser signature
   * accepted a location, an activity record, or a subsidiary fetched from
   * anywhere including another organisation, which made the brand assert a
   * proof it had never performed — worse than a raw string, because the next
   * reader sees `TrustedParent` and stops checking.
   */
  static becauseJustCreated(created: Subsidiary): TrustedParent {
    return new TrustedParent(created.id);
  }
}

@Injectable()
export class LocationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly calculations: CalculationsService,
  ) {}

  private toDTO(l: Location): LocationDTO {
    return {
      id: l.id,
      subsidiaryId: l.subsidiaryId,
      name: l.name,
      geographyCode: l.geographyCode,
      address: l.address,
      authorizedPerson: l.authorizedPerson,
      locationType: l.locationType,
      createdAt: l.createdAt.toISOString(),
      updatedAt: l.updatedAt.toISOString(),
    };
  }

  /** Facilities: a masterkey anywhere, a super_admin in granted companies
   *  (INC-2.6 §1, §6) — the company itself is checked against the caller's
   *  scope, so an ungranted one answers as unknown. */
  private assertCanWrite(user: RequestUser): void {
    if (!can(user.role, 'location.write')) {
      throw new ForbiddenException('Only a masterkey or a super_admin may modify locations');
    }
  }

  /**
   * Load a location and enforce tenant isolation: ids whose parent subsidiary
   * is outside the caller's accessible set are treated as not found.
   */
  private async loadScoped(user: RequestUser, id: string): Promise<Location> {
    const location = await this.prisma.location.findUnique({
      where: { id },
      include: { subsidiary: { select: { organisationId: true } } },
    });
    if (
      !location ||
      !user.accessibleSubsidiaryIds.includes(location.subsidiaryId) ||
      // Its company moved to another organisation since the request arrived:
      // unknown here (owner's seventh review of WP7, P2).
      location.subsidiary?.organisationId !== user.organisationId
    ) {
      throw new ResourceNotFoundError('location_not_found');
    }
    const { subsidiary: _company, ...row } = location;
    return row;
  }

  async list(
    user: RequestUser,
    subsidiaryId?: string,
  ): Promise<LocationDTO[]> {
    // Tenant scope: intersect any requested subsidiaryId with the accessible set.
    let subsidiaryFilter: Prisma.StringFilter | string;
    if (subsidiaryId) {
      if (!user.accessibleSubsidiaryIds.includes(subsidiaryId)) {
        return []; // requested a subsidiary the caller cannot see -> empty
      }
      subsidiaryFilter = subsidiaryId;
    } else {
      subsidiaryFilter = { in: user.accessibleSubsidiaryIds };
    }

    // In the reader's own organisation too: ids taken when the request
    // arrived could name a company an operator moved to another one since
    // (owner's seventh review of WP7, P2).
    const rows = await this.prisma.location.findMany({
      where: { subsidiaryId: subsidiaryFilter, subsidiary: { organisationId: user.organisationId ?? undefined } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((l) => this.toDTO(l));
  }

  async get(user: RequestUser, id: string): Promise<LocationDTO> {
    const location = await this.loadScoped(user, id);
    return this.toDTO(location);
  }

  /**
   * Write one location row and its audit entry against an already-authorised
   * parent.
   *
   * The parent id comes from `parent`, NEVER from `input` — the nested create
   * DTO has no `subsidiaryId` field, and even if a future edit added one back
   * it would not be read. That structural property, not the DTO's shape, is
   * what stops a caller attaching a location to somebody else's subsidiary.
   *
   * This performs no authorisation of its own, which is why the parent has to
   * arrive as a `TrustedParent` rather than a string. It exists because
   * `POST /subsidiaries` creates a subsidiary and its locations in a single
   * transaction, and `accessibleSubsidiaryIds` is computed at authentication
   * time — it cannot contain a subsidiary created moments earlier in the same
   * request, so `create()` below would 404 against the row that very
   * transaction just inserted.
   *
   * Living here rather than in the subsidiary service is the point: the audit
   * row's shape is defined once. A location created during a subsidiary create
   * must be indistinguishable in the trail from one added later, or the meaning
   * of the audit log depends on which screen was used — the exact defect WP16
   * PR 1 fixed for the geography confirmation.
   *
   * "Indistinguishable" covers the VALUES too, not just the shape, and it did
   * not at first: the nested DTO trimmed and nulled blank fields while the
   * standalone one did not, so the same input produced different rows depending
   * on the endpoint. Both normalise through `blankToNull` now, asserted by an
   * end-to-end test that writes the same location through both paths.
   */
  async writeLocationForTrustedParent(
    db: Prisma.TransactionClient,
    user: RequestUser,
    parent: TrustedParent,
    input: CreateSubsidiaryLocationDto,
  ): Promise<LocationDTO> {
    // inc26-group-tree: a sector group is a label and holds no facility (the
    // database's TA021 holds the same for every writer), and a facility takes
    // only a geography the factor library prices (D10).
    const node = await db.subsidiary.findUnique({ where: { id: parent.subsidiaryId }, select: { nodeType: true } });
    if (node?.nodeType === 'sector_group') {
      throw nodePlacementInvalid('A sector group holds no facility: add the facility to a company beneath it.');
    }
    await assertPricedGeography(this.calculations, input.geographyCode);
    let created: Location;
    try {
      created = await db.location.create({
        data: {
          subsidiaryId: parent.subsidiaryId,
          name: input.name,
          geographyCode: input.geographyCode,
          address: input.address ?? null,
          authorizedPerson: input.authorizedPerson ?? null,
          locationType: input.locationType ?? null,
        },
      });
    } catch (e) {
      throw treeTriggerRefusal(e) ?? e;
    }
    await this.audit.record(
      user,
      {
        action: 'create',
        entity: 'location',
        entityId: created.id,
        diff: { after: this.toDTO(created) },
      },
      db,
    );
    return this.toDTO(created);
  }

  async create(user: RequestUser, dto: CreateLocationDto): Promise<LocationDTO> {
    this.assertCanWrite(user);
    // Tenant isolation: cannot attach a location to an inaccessible subsidiary.
    // The factory performs that check and is the only way to obtain the token
    // the writer demands.
    const parent = TrustedParent.becauseInAccessibleSet(
      user,
      dto.subsidiaryId,
    );
    // Same writer the subsidiary create uses, so the two produce byte-identical
    // rows and audit entries. Wrapped in a transaction here too — this endpoint
    // used to write its audit row outside the mutation, so a crash between them
    // left a location with no trail.
    return this.prisma.$transaction(async (tx) => {
      const writer = await this.lockWritableParent(tx, user, dto.subsidiaryId);
      return this.writeLocationForTrustedParent(tx, writer, parent, dto);
    });
  }

  /**
   * A count a refused delete answers with, read only once its caller is
   * re-authorised (a fresh write transaction, the actor and company re-read):
   * a caller whose grant was withdrawn after the delete's own check learns no
   * count — the company answers as unknown (owner's seventh review of WP7, P2).
   */
  private async recountAuthorised(
    user: RequestUser,
    subsidiaryId: string,
    count: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.lockWritableParent(tx, user, subsidiaryId);
      await count(tx);
    });
  }

  /**
   * The facility writer and its company as they stand, inside the write (owner's
   * fifth review of WP7, P2): the actor re-read under the organisation's
   * administrative lock — a super_admin whose grant on the company was
   * withdrawn, or an account disabled or demoted, while the request waited
   * writes nothing — then the company locked FOR SHARE in the actor's own
   * organisation, so one an operator moved to another organisation meanwhile
   * answers as unknown and stays where it is until this write ends. Returns the
   * re-read actor, whose role the audit row names.
   */
  private async lockWritableParent(tx: Prisma.TransactionClient, user: RequestUser, subsidiaryId: string): Promise<RequestUser> {
    const organisationId = user.organisationId as string;
    const actor = await lockAndReadActor(tx, user, organisationId, 'location.write');
    if (actor.scope !== null && !actor.scope.has(subsidiaryId)) throw new ResourceNotFoundError('subsidiary_not_found');
    const [held] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM subsidiaries WHERE id = ${subsidiaryId}::uuid AND organisation_id = ${organisationId}::uuid FOR SHARE`;
    if (!held) throw new ResourceNotFoundError('subsidiary_not_found');
    return { ...user, role: actor.role };
  }

  async update(
    user: RequestUser,
    id: string,
    dto: UpdateLocationDto,
  ): Promise<LocationDTO> {
    this.assertCanWrite(user);
    // The tenant check; the row itself is read again, locked, below.
    await this.loadScoped(user, id);

    const data: Prisma.LocationUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.geographyCode !== undefined) data.geographyCode = dto.geographyCode;
    if (dto.address !== undefined) data.address = dto.address;
    if (dto.authorizedPerson !== undefined) {
      data.authorizedPerson = dto.authorizedPerson;
    }
    if (dto.locationType !== undefined) data.locationType = dto.locationType;

    // Same as create and delete now: mutation and audit in one transaction.
    const updated = await this.prisma.$transaction(async (tx) => {
      // The row as it stands once locked: a stored geography stays valid
      // until it is changed, and a new one must be priced (D10) — judged
      // against THIS value, so an edit that read an older one cannot write
      // back a geography the library no longer prices; the audit's `before`
      // is this row too (owner review of WP7, P2).
      // The actor, then the facility, then its company — the admin lock first,
      // as every writer of grants and the tree takes it.
      const organisationId = user.organisationId as string;
      const actor = await lockAndReadActor(tx, user, organisationId, 'location.write');
      await tx.$queryRaw`SELECT id FROM locations WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.location.findUnique({ where: { id } });
      if (!current) throw new ResourceNotFoundError('location_not_found');
      // Its company in the actor's organisation and, for a scoped actor, still
      // granted (owner's fifth review of WP7, P2).
      if (actor.scope !== null && !actor.scope.has(current.subsidiaryId)) throw new ResourceNotFoundError('location_not_found');
      const [held] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM subsidiaries WHERE id = ${current.subsidiaryId}::uuid AND organisation_id = ${organisationId}::uuid FOR SHARE`;
      if (!held) throw new ResourceNotFoundError('location_not_found');
      const writer = { ...user, role: actor.role };
      if (dto.geographyCode !== undefined && dto.geographyCode !== current.geographyCode) {
        await assertPricedGeography(this.calculations, dto.geographyCode);
      }
      const row = await tx.location.update({ where: { id }, data });
      await this.audit.record(
        writer,
        {
          action: 'update',
          entity: 'location',
          entityId: id,
          diff: { before: this.toDTO(current), after: this.toDTO(row) },
        },
        tx,
      );
      return row;
    });
    return this.toDTO(updated);
  }

  /**
   * A site declared in an inventory boundary version is not deleted (LP3-04
   * W9): the version records which sites the inventory covers and the months
   * each operated. An open version can drop it; a frozen one keeps it, and so
   * the site stays.
   */
  private async assertNotDeclared(locationId: string, db: Prisma.TransactionClient | PrismaService = this.prisma): Promise<void> {
    const versions = await db.inventoryBoundarySite.count({ where: { locationId } });
    if (versions > 0) {
      throw new ConflictException(
        errorBody(
          'location_in_boundary',
          `This location is declared in ${versions} inventory boundary version(s), which record the sites ` +
            'an inventory covers and the months each operated. Remove it from an open version first; ' +
            'a confirmed or captured version never changes, so a location declared in one stays.',
          { count: versions },
        ),
      );
    }
  }

  /**
   * Refuse to delete something that committed data still points at.
   *
   * The FK was `ON DELETE SET NULL` (RESTRICT since LP4-01, which makes the
   * database refuse it too), so a delete used to succeed silently and
   * leave every referencing record claiming the SUBSIDIARY's geography while its
   * frozen calculation snapshot was computed from the LOCATION's — measured:
   * subsidiary TR, location UK, record detached with `geographyCode: 'UK'` still
   * in the snapshot. Nothing recorded that per record, so the divergence was
   * undiscoverable from the audit trail.
   *
   * The count is part of the message because "you cannot delete this" without a
   * number leaves the user with no idea what to do next.
   */
  private async assertNoRecords(locationId: string, db: Prisma.TransactionClient | PrismaService = this.prisma): Promise<void> {
    const count = await db.activityRecord.count({
      where: { locationId },
    });
    if (count > 0) {
      // Draft and rejected records can be re-targeted; committed ones cannot be
      // moved OR deleted, so for those the honest answer is that the location
      // stays — it is part of what the reported figures mean.
      throw new ConflictException(
        errorBody(
          'location_has_records',
          `${count} activity record(s) are recorded at this location. Deleting it ` +
            'would leave them showing a different geography than the one they ' +
            'were calculated with. Re-target any draft records to another ' +
            'location first; a location with committed records stays, because it ' +
            'is part of what those figures mean.',
          { count },
        ),
      );
    }
  }

  /**
   * Delete one location row and write its audit entry, for a caller that has
   * already established the right to remove it AND that it holds no records.
   *
   * The mirror of `writeLocationForTrustedParent`, and here for the same
   * reason: a location cleared while its subsidiary is being deleted must leave
   * exactly the row `DELETE /locations/:id` leaves. Otherwise the audit trail
   * would say something different about the same event depending on which
   * endpoint the user happened to reach for — the defect WP16 PR 1 fixed for
   * the geography confirmation, and PR 3 for location creation.
   *
   * Performs no authorisation and no record check: both callers do them first,
   * with different reasons and different messages.
   *
   * Answers false, writing no audit row, when the row is already gone: a
   * concurrent `DELETE /locations/:id` removed it first. Prisma reports that
   * as P2025 on the client side, with no SQL error, so the caller's
   * transaction carries on. The standalone delete turns false into a 404; the
   * subsidiary sweep counts the site as cleared (pre-pilot defects, Codex
   * review of #350 P2).
   */
  async deleteLocationForTrustedParent(
    db: Prisma.TransactionClient,
    user: RequestUser,
    location: Location,
  ): Promise<boolean> {
    let deleted: Location;
    try {
      deleted = await db.location.delete({ where: { id: location.id } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') return false;
      throw err;
    }
    await this.audit.record(
      user,
      {
        action: 'delete',
        entity: 'location',
        entityId: location.id,
        // The row the delete removed, not the read before the transaction —
        // a rename or a new type meanwhile is what was deleted (owner's sixth
        // review of WP7, P2).
        diff: { before: this.toDTO(deleted) },
      },
      db,
    );
    return true;
  }

  async remove(
    user: RequestUser,
    id: string,
  ): Promise<{ id: string; deleted: true }> {
    this.assertCanWrite(user);
    const existing = await this.loadScoped(user, id);
    // Delete + audit in one transaction (see subsidiaries.remove).
    try {
      await this.prisma.$transaction(async (tx) => {
        // The actor and the company as they stand (owner's fifth review of WP7, P2).
        const writer = await this.lockWritableParent(tx, user, existing.subsidiaryId);
        // Only then what depends on the site: a caller whose grant was
        // withdrawn meanwhile learns no count of its records or versions
        // (owner's sixth review of WP7, P2).
        await this.assertNoRecords(id, tx);
        await this.assertNotDeclared(id, tx);
        // Deleted by a concurrent request since it was read: the answer it
        // would get now, not a 500 (pre-pilot defects).
        if (!(await this.deleteLocationForTrustedParent(tx, writer, existing))) {
          throw new ResourceNotFoundError('location_not_found');
        }
      });
    } catch (err) {
      // A record filed here after the check above: the site's key is RESTRICT
      // (LP4-01), so the delete is refused rather than re-filing it at company
      // level. The same 409 as the check, with the count as it is now.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
        await this.recountAuthorised(user, existing.subsidiaryId, (tx) => this.assertNoRecords(id, tx));
      }
      // A boundary version declaring the site since the check: its guard
      // refuses the cascade (TA014, W9). The same 409 as the check — and a 409
      // still if that version is gone by the recount: the delete did not
      // happen either way (Codex's B9 review).
      if (boundaryGuardRefused(err)) {
        await this.recountAuthorised(user, existing.subsidiaryId, (tx) => this.assertNotDeclared(id, tx));
        throw new ConflictException(
          errorBody(
            'location_declared_during_delete',
            'This location was declared in an inventory boundary version when it was being deleted, so it ' +
              'was not deleted. Check the inventory boundary and try again.',
          ),
        );
      }
      throw err;
    }
    return { id, deleted: true };
  }

}
