import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma, type Subsidiary } from '@tonyai/db';
import { NODE_TYPES, allowedChildTypes, type NodeType } from '@tonyai/shared-types';
import { SubsidiariesService } from './subsidiaries.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { LocationsService } from '../locations/locations.service';
import type { AccessAdminService } from '../auth/access-admin.service';
import type { CalculationsService } from '../calculations/calculations.service';
import {
  createPrismaMock,
  makeAuditor,
  makeMasterkey,
  makeSubsidiary,
  makeSuperAdmin,
  stubRead,
  type PrismaMock,
} from '../../test/helpers';

/**
 * The group tree on the company service (inc26-group-tree, tasks 3.1–3.5,
 * 3.8, 5.2): placement, the default placement, a super_admin's child company
 * and its grant, moves, the associate tick, the geography rule, the parent a
 * reader may see, and the exclusions note. DB-free; TA018–TA022 are proved on
 * the database in `test:int`.
 */

const audit = { record: vi.fn() };
const PRICED = ['TR', 'UK'];
const calculations = {
  coverage: vi.fn(async () => ({
    entries: PRICED.map((geographyCode) => ({ geographyCode, reportingYear: 2026, statuses: ['authoritative'] })),
  })),
};
const accessAdmin = {
  lockChildCompanyCreator: vi.fn(),
  grantChildCompanyCreator: vi.fn(),
};
const locations = { writeLocationForTrustedParent: vi.fn() };

interface Node {
  id: string;
  nodeType: NodeType;
  control?: 'controlled' | 'associate';
  geographyCode?: string;
  organisationId?: string;
}

/** The organisation's nodes as `findFirst` reads them: by id within the
 *  organisation, or its holding. */
function tree(prisma: PrismaMock, nodes: Node[]): void {
  const shaped = nodes.map((n) => ({
    id: n.id,
    nodeType: n.nodeType,
    control: n.control ?? 'controlled',
    geographyCode: n.geographyCode ?? 'TR',
    organisationId: n.organisationId ?? 'org-1',
  }));
  const impl = async ({ where }: { where: Record<string, unknown> }) => {
    const inOrg = shaped.filter((n) => n.organisationId === where.organisationId);
    if (typeof where.id === 'string') return inOrg.find((n) => n.id === where.id) ?? null;
    if (where.nodeType === 'holding') return inOrg.find((n) => n.nodeType === 'holding') ?? null;
    return null;
  };
  prisma.subsidiary.findFirst.mockImplementation(impl as never);
  prisma.txClient.subsidiary.findFirst.mockImplementation(impl as never);
}

/** `subsidiary.create` answers the row it was given. */
function echoCreate(prisma: PrismaMock): void {
  prisma.txClient.subsidiary.create.mockImplementation((async ({ data }: { data: Record<string, unknown> }) =>
    makeSubsidiary({
      ...(data as Partial<Subsidiary>),
      id: 'sub-new',
      sharePercent: data.sharePercent == null ? null : new Prisma.Decimal(data.sharePercent as number),
    })) as never);
}

function triggerError(sqlstate: string, message: string): Prisma.PrismaClientUnknownRequestError {
  return new Prisma.PrismaClientUnknownRequestError(
    `Error occurred during query execution: ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "${sqlstate}", message: "${message}", severity: "ERROR", detail: None, column: None, hint: None }) })`,
    { clientVersion: '6' },
  );
}

const ROOT: Node = { id: 'sub-root', nodeType: 'holding' };
const masterkey = () =>
  makeMasterkey({ accessibleSubsidiaryIds: ['sub-root', 'sub-1', 'sub-2', 'sub-3', 'sub-4', 'sub-5', 'sub-p'] });

describe('SubsidiariesService — the group tree', () => {
  let prisma: PrismaMock;
  let service: SubsidiariesService;

  beforeEach(() => {
    audit.record.mockClear();
    calculations.coverage.mockClear();
    accessAdmin.lockChildCompanyCreator.mockReset().mockResolvedValue(undefined);
    accessAdmin.grantChildCompanyCreator.mockReset().mockResolvedValue(undefined);
    locations.writeLocationForTrustedParent.mockReset();
    prisma = createPrismaMock();
    service = new SubsidiariesService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
      locations as unknown as LocationsService,
      accessAdmin as unknown as AccessAdminService,
      calculations as unknown as CalculationsService,
    );
  });

  describe('create — placement (RD7)', () => {
    for (const parentType of NODE_TYPES) {
      for (const childType of NODE_TYPES) {
        const admitted = childType !== 'holding' && allowedChildTypes(parentType).includes(childType);
        it(`a ${childType} under a ${parentType} → ${admitted ? 'created' : 'node_placement_invalid'}`, async () => {
          tree(prisma, [ROOT, { id: 'sub-p', nodeType: parentType }]);
          echoCreate(prisma);
          const call = service.create(masterkey(), {
            legalName: 'Node', geographyCode: 'TR', parentId: 'sub-p', nodeType: childType,
          });
          if (admitted) {
            const dto = await call;
            expect(prisma.txClient.subsidiary.create.mock.calls[0][0].data).toMatchObject({ parentId: 'sub-p', nodeType: childType });
            expect(dto).toMatchObject({ parentId: 'sub-p', nodeType: childType, control: 'controlled' });
          } else {
            await expect(call).rejects.toMatchObject({ response: { code: 'node_placement_invalid', statusCode: 400 } });
            expect(prisma.txClient.subsidiary.create).not.toHaveBeenCalled();
          }
        });
      }
    }

    it('refuses a child under an associate', async () => {
      tree(prisma, [ROOT, { id: 'sub-p', nodeType: 'company', control: 'associate' }]);
      await expect(
        service.create(masterkey(), { legalName: 'B', geographyCode: 'TR', parentId: 'sub-p', nodeType: 'child_company' }),
      ).rejects.toMatchObject({ response: { code: 'node_placement_invalid' } });
      expect(prisma.txClient.subsidiary.create).not.toHaveBeenCalled();
    });
  });

  describe('create — the default placement (RD14)', () => {
    it('stores a company with no parent named under the root', async () => {
      tree(prisma, [ROOT]);
      echoCreate(prisma);
      const dto = await service.create(masterkey(), { legalName: 'Plain', geographyCode: 'TR' });
      expect(prisma.txClient.subsidiary.create.mock.calls[0][0].data).toMatchObject({
        parentId: 'sub-root', nodeType: 'company', control: 'controlled', createdByRole: 'masterkey',
        sharePercent: null, naceCode: null,
      });
      expect(dto.parentId).toBe('sub-root');
    });

    it("stores an organisation's first company as its root, a holding", async () => {
      tree(prisma, []);
      echoCreate(prisma);
      await service.create(masterkey(), { legalName: 'First', geographyCode: 'TR' });
      expect(prisma.txClient.subsidiary.create.mock.calls[0][0].data).toMatchObject({ parentId: null, nodeType: 'holding' });
    });

    it('refuses a second holding, and creates nothing', async () => {
      tree(prisma, [ROOT]);
      await expect(
        service.create(masterkey(), { legalName: 'Second', geographyCode: 'TR', nodeType: 'holding' }),
      ).rejects.toMatchObject({ response: { code: 'node_placement_invalid' } });
      expect(prisma.txClient.subsidiary.create).not.toHaveBeenCalled();
    });

    it('refuses a child company with no parent named (it would sit under the holding)', async () => {
      tree(prisma, [ROOT]);
      await expect(
        service.create(masterkey(), { legalName: 'B', geographyCode: 'TR', nodeType: 'child_company' }),
      ).rejects.toMatchObject({ response: { code: 'node_placement_invalid' } });
    });

    it('answers a parent of another organisation exactly as an unknown company', async () => {
      tree(prisma, [ROOT, { id: 'sub-p', nodeType: 'company', organisationId: 'org-2' }]);
      const foreign = await service
        .create(masterkey(), { legalName: 'B', geographyCode: 'TR', parentId: 'sub-p', nodeType: 'child_company' })
        .catch((e: NotFoundException) => e.getResponse());
      const unknown = await service
        .create(masterkey(), { legalName: 'B', geographyCode: 'TR', parentId: 'sub-zz', nodeType: 'child_company' })
        .catch((e: NotFoundException) => e.getResponse());
      expect(foreign).toMatchObject({ code: 'subsidiary_not_found' });
      expect(foreign).toEqual(unknown);
      expect(prisma.txClient.subsidiary.create).not.toHaveBeenCalled();
    });

    it('maps TA018 reached through a race to node_placement_invalid', async () => {
      tree(prisma, [ROOT]);
      prisma.txClient.subsidiary.create.mockRejectedValue(
        triggerError('TA018', 'node_placement_invalid: organisation x already has its holding'),
      );
      await expect(service.create(masterkey(), { legalName: 'A', geographyCode: 'TR' })).rejects.toMatchObject({
        response: { code: 'node_placement_invalid' },
      });
    });
  });

  describe('create — control, NACE, share percent', () => {
    it('stores a company ticked associate, and its creation audit row holds it', async () => {
      tree(prisma, [ROOT]);
      echoCreate(prisma);
      await service.create(masterkey(), { legalName: 'Dünya Katılım', geographyCode: 'TR', control: 'associate', sharePercent: 20 });
      expect(prisma.txClient.subsidiary.create.mock.calls[0][0].data).toMatchObject({ control: 'associate', sharePercent: 20 });
      expect(audit.record.mock.calls[0][1].diff.after).toMatchObject({ control: 'associate', sharePercent: 20 });
    });

    it('refuses a sub-holding sent as an associate as invalid', async () => {
      tree(prisma, [ROOT]);
      await expect(
        service.create(masterkey(), { legalName: 'SH', geographyCode: 'TR', nodeType: 'sub_holding', control: 'associate' }),
      ).rejects.toMatchObject({ response: { code: 'node_placement_invalid', statusCode: 400 } });
      expect(prisma.txClient.subsidiary.create).not.toHaveBeenCalled();
    });

    it('creates a company with no NACE code and no share percent', async () => {
      tree(prisma, [ROOT]);
      echoCreate(prisma);
      const dto = await service.create(masterkey(), { legalName: 'Bare', geographyCode: 'TR' });
      expect(dto).toMatchObject({ naceCode: null, sharePercent: null });
    });
  });

  describe('create — the geography rule (D10)', () => {
    it("creates a sector group sent no geography at all, with its parent's (owner review of WP7, P2)", async () => {
      tree(prisma, [ROOT]);
      prisma.txClient.subsidiary.create.mockImplementation((async ({ data }: { data: Record<string, unknown> }) => makeSubsidiary({ ...(data as Partial<Subsidiary>), id: 'sub-new' })) as never);
      await service.create(masterkey(), { legalName: 'Group', nodeType: 'sector_group', parentId: 'sub-root' } as never);
      // The root's geography in this spec's tree: TR.
      expect(prisma.txClient.subsidiary.create.mock.calls[0][0].data.geographyCode).toBe('TR');
      expect(calculations.coverage).not.toHaveBeenCalled();
    });

    it('creates a company in a priced geography', async () => {
      tree(prisma, [ROOT]);
      echoCreate(prisma);
      await service.create(masterkey(), { legalName: 'TR Co', geographyCode: 'TR' });
      expect(calculations.coverage).toHaveBeenCalledTimes(1);
    });

    it('refuses a geography with no factor set with 422 naming it, and creates nothing', async () => {
      tree(prisma, [ROOT]);
      await expect(service.create(masterkey(), { legalName: 'EU Co', geographyCode: 'EU' })).rejects.toMatchObject({
        status: 422,
        response: { code: 'geography_without_factors', params: { geography: 'EU' } },
      });
      expect(prisma.txClient.subsidiary.create).not.toHaveBeenCalled();
    });

    it("gives a sector group its parent's geography, unchecked, and no facility", async () => {
      tree(prisma, [{ ...ROOT, geographyCode: 'TR' }]);
      echoCreate(prisma);
      await service.create(masterkey(), { legalName: 'Natural gas', geographyCode: 'EU', nodeType: 'sector_group' });
      expect(prisma.txClient.subsidiary.create.mock.calls[0][0].data.geographyCode).toBe('TR');
      expect(calculations.coverage).not.toHaveBeenCalled();
      await expect(
        service.create(masterkey(), {
          legalName: 'Natural gas', geographyCode: 'TR', nodeType: 'sector_group',
          locations: [{ name: 'Depot', geographyCode: 'TR' }],
        }),
      ).rejects.toMatchObject({ response: { code: 'node_placement_invalid' } });
    });
  });

  describe("create — a super_admin's child company (D5)", () => {
    const superAdmin = () => makeSuperAdmin({ accessibleSubsidiaryIds: ['sub-1'] });

    it('creates a controlled child company under a granted company, granted to its creator in the same transaction', async () => {
      tree(prisma, [ROOT, { id: 'sub-1', nodeType: 'company' }]);
      echoCreate(prisma);
      const dto = await service.create(superAdmin(), {
        legalName: 'B', geographyCode: 'TR', parentId: 'sub-1', nodeType: 'child_company',
      });
      expect(accessAdmin.lockChildCompanyCreator).toHaveBeenCalledWith(prisma.txClient, expect.objectContaining({ role: 'super_admin' }), 'sub-1');
      expect(prisma.txClient.subsidiary.create.mock.calls[0][0].data).toMatchObject({
        parentId: 'sub-1', nodeType: 'child_company', control: 'controlled', createdByRole: 'super_admin',
      });
      expect(accessAdmin.grantChildCompanyCreator).toHaveBeenCalledWith(prisma.txClient, expect.objectContaining({ role: 'super_admin' }), 'sub-new');
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record.mock.calls[0][1]).toMatchObject({ action: 'create', entity: 'subsidiary', entityId: 'sub-new' });
      expect(dto).toMatchObject({ parentId: 'sub-1', createdByRole: 'super_admin' });
      // The lock and re-read come before the node is written.
      expect(accessAdmin.lockChildCompanyCreator.mock.invocationCallOrder[0])
        .toBeLessThan(prisma.txClient.subsidiary.create.mock.invocationCallOrder[0]);
    });

    it('answers a parent outside its scope as an unknown company, and creates nothing', async () => {
      tree(prisma, [ROOT, { id: 'sub-1', nodeType: 'company' }, { id: 'sub-3', nodeType: 'company' }]);
      await expect(
        service.create(superAdmin(), { legalName: 'B', geographyCode: 'TR', parentId: 'sub-3', nodeType: 'child_company' }),
      ).rejects.toMatchObject({ response: { code: 'subsidiary_not_found' } });
      expect(prisma.txClient.subsidiary.create).not.toHaveBeenCalled();
      expect(accessAdmin.grantChildCompanyCreator).not.toHaveBeenCalled();
    });

    it.each(['company', 'sub_holding', 'sector_group', 'holding'] as const)('refuses a %s as forbidden, before reading anything', async (nodeType) => {
      await expect(
        service.create(superAdmin(), { legalName: 'X', geographyCode: 'TR', parentId: 'sub-1', nodeType }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('refuses associate as forbidden, and creates nothing', async () => {
      await expect(
        service.create(superAdmin(), {
          legalName: 'B', geographyCode: 'TR', parentId: 'sub-1', nodeType: 'child_company', control: 'associate',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('a grant that cannot be stored fails the create inside its transaction', async () => {
      tree(prisma, [ROOT, { id: 'sub-1', nodeType: 'company' }]);
      echoCreate(prisma);
      accessAdmin.grantChildCompanyCreator.mockRejectedValue(new Error('grant refused'));
      await expect(
        service.create(superAdmin(), { legalName: 'B', geographyCode: 'TR', parentId: 'sub-1', nodeType: 'child_company' }),
      ).rejects.toThrow('grant refused');
      // Both writes ran on the one transaction client, so the rollback takes both.
      expect(prisma.txClient.subsidiary.create).toHaveBeenCalledTimes(1);
      expect(accessAdmin.grantChildCompanyCreator.mock.calls[0][0]).toBe(prisma.txClient);
      expect(prisma.subsidiary.create).not.toHaveBeenCalled();
    });

    it('creates nothing when the re-read scope no longer holds the parent', async () => {
      tree(prisma, [ROOT, { id: 'sub-1', nodeType: 'company' }]);
      accessAdmin.lockChildCompanyCreator.mockRejectedValue(new NotFoundException());
      await expect(
        service.create(superAdmin(), { legalName: 'B', geographyCode: 'TR', parentId: 'sub-1', nodeType: 'child_company' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.txClient.subsidiary.create).not.toHaveBeenCalled();
    });

    it('does not let a masterkey path grant anyone', async () => {
      tree(prisma, [ROOT, { id: 'sub-1', nodeType: 'company' }]);
      echoCreate(prisma);
      await service.create(masterkey(), { legalName: 'B', geographyCode: 'TR', parentId: 'sub-1', nodeType: 'child_company' });
      expect(accessAdmin.lockChildCompanyCreator).not.toHaveBeenCalled();
      expect(accessAdmin.grantChildCompanyCreator).not.toHaveBeenCalled();
    });
  });

  describe('update — type, move, control (3.3)', () => {
    const company = (overrides: Partial<Subsidiary> = {}) =>
      makeSubsidiary({ id: 'sub-2', parentId: 'sub-root', nodeType: 'company', geographyCode: 'TR', ...overrides });

    beforeEach(() => {
      prisma.txClient.subsidiary.update.mockImplementation((async ({ data }: { data: Record<string, unknown> }) =>
        company({
          ...(data as Partial<Subsidiary>),
          ...(data.sharePercent !== undefined
            ? { sharePercent: data.sharePercent === null ? null : new Prisma.Decimal(data.sharePercent as number) }
            : {}),
        })) as never);
    });

    it('refuses a type change with node_type_fixed, before any write', async () => {
      prisma.subsidiary.findUnique.mockResolvedValue(company());
      await expect(service.update(masterkey(), 'sub-2', { nodeType: 'sub_holding' })).rejects.toMatchObject({
        response: { code: 'node_type_fixed', statusCode: 400 },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('accepts the same type sent back', async () => {
      prisma.subsidiary.findUnique.mockResolvedValue(company());
      await service.update(masterkey(), 'sub-2', { nodeType: 'company', legalName: 'Renamed' });
      expect(prisma.txClient.subsidiary.update.mock.calls[0][0].data).toEqual({ legalName: 'Renamed' });
    });

    it('moves an empty company under a sector group, with one audit row holding both parents', async () => {
      prisma.subsidiary.findUnique.mockResolvedValue(company());
      tree(prisma, [ROOT, { id: 'sub-3', nodeType: 'sector_group' }]);
      prisma.txClient.$queryRaw
        .mockResolvedValueOnce([{ id: 'locked' }])
        .mockResolvedValueOnce([{ cycle: false }])
        .mockResolvedValueOnce([{ records: false }]);
      const dto = await service.update(masterkey(), 'sub-2', { parentId: 'sub-3' });
      expect(prisma.txClient.subsidiary.update.mock.calls[0][0].data).toEqual({ parentId: 'sub-3' });
      expect(dto.parentId).toBe('sub-3');
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record.mock.calls[0][1].diff.before.parentId).toBe('sub-root');
      expect(audit.record.mock.calls[0][1].diff.after.parentId).toBe('sub-3');
    });

    it('refuses a move under the node itself as a cycle', async () => {
      prisma.subsidiary.findUnique.mockResolvedValue(company());
      tree(prisma, [ROOT, { id: 'sub-2', nodeType: 'company' }]);
      await expect(service.update(masterkey(), 'sub-2', { parentId: 'sub-2' })).rejects.toMatchObject({
        response: { code: 'tree_cycle', statusCode: 409 },
      });
      expect(prisma.txClient.subsidiary.update).not.toHaveBeenCalled();
    });

    it('refuses a sub-holding moved under its own company as a cycle', async () => {
      prisma.subsidiary.findUnique.mockResolvedValue(company({ id: 'sub-2', nodeType: 'sub_holding' }));
      tree(prisma, [ROOT, { id: 'sub-4', nodeType: 'company' }]);
      // The node's row lock first, then the cycle walk.
      prisma.txClient.$queryRaw.mockResolvedValueOnce([{ id: 'locked' }]).mockResolvedValueOnce([{ cycle: true }]);
      await expect(service.update(masterkey(), 'sub-2', { parentId: 'sub-4' })).rejects.toMatchObject({
        response: { code: 'tree_cycle' },
      });
      expect(prisma.txClient.subsidiary.update).not.toHaveBeenCalled();
    });

    it('refuses a move while a record sits beneath the node, naming records', async () => {
      prisma.subsidiary.findUnique.mockResolvedValue(company());
      tree(prisma, [ROOT, { id: 'sub-3', nodeType: 'sector_group' }]);
      prisma.txClient.$queryRaw
        .mockResolvedValueOnce([{ id: 'locked' }])
        .mockResolvedValueOnce([{ cycle: false }])
        .mockResolvedValueOnce([{ records: true }]);
      const e = (await service.update(masterkey(), 'sub-2', { parentId: 'sub-3' }).catch((err: unknown) => err)) as Error;
      expect(e).toMatchObject({ response: { code: 'node_move_blocked', statusCode: 409 } });
      expect(e.message).toMatch(/activity records/);
      expect(prisma.txClient.subsidiary.update).not.toHaveBeenCalled();
    });

    it('refuses to move the holding, to clear a parent, or to place a type its new parent does not admit', async () => {
      prisma.subsidiary.findUnique.mockResolvedValue(company({ id: 'sub-root', parentId: null, nodeType: 'holding' }));
      await expect(service.update(masterkey(), 'sub-root', { parentId: 'sub-3' })).rejects.toMatchObject({
        response: { code: 'node_placement_invalid' },
      });
      prisma.subsidiary.findUnique.mockResolvedValue(company());
      await expect(service.update(masterkey(), 'sub-2', { parentId: null })).rejects.toMatchObject({
        response: { code: 'node_placement_invalid' },
      });
      tree(prisma, [ROOT, { id: 'sub-5', nodeType: 'child_company' }]);
      prisma.txClient.$queryRaw.mockResolvedValueOnce([{ cycle: false }]);
      await expect(service.update(masterkey(), 'sub-2', { parentId: 'sub-5' })).rejects.toMatchObject({
        response: { code: 'node_placement_invalid' },
      });
      expect(prisma.txClient.subsidiary.update).not.toHaveBeenCalled();
    });

    it('answers an unreadable new parent as an unknown company', async () => {
      prisma.subsidiary.findUnique.mockResolvedValue(company());
      await expect(service.update(masterkey(), 'sub-2', { parentId: 'sub-zz' })).rejects.toMatchObject({
        response: { code: 'subsidiary_not_found' },
      });
    });

    it('maps a cycle the database refused through a race to tree_cycle', async () => {
      prisma.subsidiary.findUnique.mockResolvedValue(company());
      tree(prisma, [ROOT, { id: 'sub-3', nodeType: 'sector_group' }]);
      prisma.txClient.$queryRaw.mockResolvedValueOnce([{ cycle: false }]).mockResolvedValueOnce([{ records: false }]);
      prisma.txClient.subsidiary.update.mockRejectedValue(
        triggerError('TA018', 'tree_cycle: subsidiary x cannot move under itself or a node beneath it'),
      );
      await expect(service.update(masterkey(), 'sub-2', { parentId: 'sub-3' })).rejects.toMatchObject({
        response: { code: 'tree_cycle' },
      });
    });

    it('does not trust a code under the wrong SQLSTATE', async () => {
      prisma.subsidiary.findUnique.mockResolvedValue(company());
      const raw = triggerError('TA019', 'tree_cycle: forged');
      prisma.txClient.subsidiary.update.mockRejectedValue(raw);
      await expect(service.update(masterkey(), 'sub-2', { legalName: 'X Y' })).rejects.toBe(raw);
    });

    describe('ticking associate (RD3)', () => {
      it('stores an unused company as an associate, with one audit row', async () => {
        prisma.subsidiary.findUnique.mockResolvedValue(company());
        await service.update(masterkey(), 'sub-2', { control: 'associate' });
        expect(prisma.txClient.subsidiary.update.mock.calls[0][0].data).toEqual({ control: 'associate' });
        expect(audit.record).toHaveBeenCalledTimes(1);
        expect(audit.record.mock.calls[0][1].diff.before.control).toBe('controlled');
        expect(audit.record.mock.calls[0][1].diff.after.control).toBe('associate');
      });

      it.each([
        ['records (a voided one counts)', (p: PrismaMock) => stubRead(p, (c) => c.activityRecord.count, 1), /activity records/],
        ['user assignments', (p: PrismaMock) => stubRead(p, (c) => c.userSubsidiaryAccess.count, 1), /user assignments/],
        ['child companies', (p: PrismaMock) => stubRead(p, (c) => c.subsidiary.count, 1), /child companies/],
      ])('refuses while it has %s, naming them, and changes nothing', async (_what, arrange, named) => {
        prisma.subsidiary.findUnique.mockResolvedValue(company());
        arrange(prisma);
        const e = (await service.update(masterkey(), 'sub-2', { control: 'associate' }).catch((err: unknown) => err)) as Error;
        expect(e).toMatchObject({ response: { code: 'control_change_blocked', statusCode: 409 } });
        expect(e.message).toMatch(named);
        expect(prisma.txClient.subsidiary.update).not.toHaveBeenCalled();
        expect(audit.record).not.toHaveBeenCalled();
      });

      it('counts every record of the company, whatever its status', async () => {
        prisma.subsidiary.findUnique.mockResolvedValue(company());
        await service.update(masterkey(), 'sub-2', { control: 'associate' });
        expect(prisma.txClient.activityRecord.count).toHaveBeenCalledWith({ where: { subsidiaryId: 'sub-2' } });
      });

      it("refuses while a year's newest version declares it, not an older one — even a frozen one behind an open version (the spec's scenario)", async () => {
        prisma.subsidiary.findUnique.mockResolvedValue(company());
        prisma.txClient.inventoryBoundarySubsidiary.findMany.mockResolvedValue([{ boundary: { reportingYear: 2026, version: 1 } }]);
        const tick = () => service.update(masterkey(), 'sub-2', { control: 'associate' }).catch((err: unknown) => err as Error);

        // V1 (frozen) declares it, V2 (open, newest) leaves it out: allowed —
        // deleting V2 is what is refused then (InventoryBoundariesService.remove).
        prisma.txClient.inventoryBoundary.findFirst.mockResolvedValue({ version: 2 });
        expect(await tick()).not.toBeInstanceOf(Error);
        expect(prisma.txClient.subsidiary.update).toHaveBeenCalledTimes(1);

        prisma.txClient.subsidiary.update.mockClear();
        prisma.txClient.inventoryBoundary.findFirst.mockResolvedValue({ version: 1 });
        const e = await tick();
        expect(e).toMatchObject({ response: { code: 'control_change_blocked' } });
        expect((e as Error).message).toMatch(/inventory boundary declarations/);
        expect(prisma.txClient.subsidiary.update).not.toHaveBeenCalled();
      });

      it('refuses associate on a type that is always controlled as invalid', async () => {
        prisma.subsidiary.findUnique.mockResolvedValue(company({ nodeType: 'sub_holding' }));
        await expect(service.update(masterkey(), 'sub-2', { control: 'associate' })).rejects.toMatchObject({
          response: { code: 'node_placement_invalid' },
        });
      });

      it('lets an associate become controlled again without blockers', async () => {
        prisma.subsidiary.findUnique.mockResolvedValue(company({ control: 'associate' }));
        stubRead(prisma, (c) => c.subsidiary.count, 1);
        await service.update(masterkey(), 'sub-2', { control: 'controlled' });
        expect(prisma.txClient.subsidiary.update.mock.calls[0][0].data).toEqual({ control: 'controlled' });
      });
    });

    it('keeps share percent inert: stored, nothing else read', async () => {
      prisma.subsidiary.findUnique.mockResolvedValue(company());
      await service.update(masterkey(), 'sub-2', { sharePercent: 90, naceCode: '35.21' });
      expect(prisma.txClient.subsidiary.update.mock.calls[0][0].data).toEqual({ sharePercent: 90, naceCode: '35.21' });
      expect(prisma.txClient.activityRecord.count).not.toHaveBeenCalled();
    });

    it('refuses a super_admin renaming a child company it created as forbidden', async () => {
      const superAdmin = makeSuperAdmin({ accessibleSubsidiaryIds: ['sub-2'] });
      prisma.subsidiary.findUnique.mockResolvedValue(company({ createdByRole: 'super_admin' }));
      await expect(service.update(superAdmin, 'sub-2', { legalName: 'Renamed' })).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    describe('the geography rule (D10)', () => {
      it('saves a rename of a company stored in an unpriced geography, the geography unchanged', async () => {
        prisma.subsidiary.findUnique.mockResolvedValue(company({ geographyCode: 'EU' }));
        await service.update(masterkey(), 'sub-2', { legalName: 'Renamed', geographyCode: 'EU' });
        expect(calculations.coverage).not.toHaveBeenCalled();
        expect(prisma.txClient.subsidiary.update).toHaveBeenCalled();
      });

      it('refuses a change to an unpriced geography with 422, and changes nothing', async () => {
        prisma.subsidiary.findUnique.mockResolvedValue(company({ geographyCode: 'TR' }));
        await expect(service.update(masterkey(), 'sub-2', { geographyCode: 'EU' })).rejects.toMatchObject({
          status: 422,
          response: { code: 'geography_without_factors', params: { geography: 'EU' } },
        });
        expect(prisma.txClient.subsidiary.update).not.toHaveBeenCalled();
      });

      it("moves a sector group with its new parent's geography (owner's seventh review, P3)", async () => {
        prisma.subsidiary.findUnique.mockResolvedValue(company({ nodeType: 'sector_group', geographyCode: 'TR' }));
        tree(prisma, [ROOT, { id: 'sub-3', nodeType: 'sub_holding' }]);
        prisma.txClient.subsidiary.findUnique.mockImplementation((async ({ where }: { where: { id: string } }) =>
          where.id === 'sub-3'
            ? makeSubsidiary({ id: 'sub-3', nodeType: 'sub_holding', geographyCode: 'UK' })
            : company({ nodeType: 'sector_group', geographyCode: 'TR' })) as never);
        prisma.txClient.$queryRaw
          .mockResolvedValueOnce([{ id: 'locked' }])
          .mockResolvedValueOnce([{ cycle: false }])
          .mockResolvedValueOnce([{ records: false }]);
        await service.update(masterkey(), 'sub-2', { parentId: 'sub-3' });
        expect(prisma.txClient.subsidiary.update.mock.calls[0][0].data).toEqual({ parentId: 'sub-3', geographyCode: 'UK' });
      });

      it("refuses a sector group's geography change — it is its parent's (owner's sixth review, P3)", async () => {
        prisma.subsidiary.findUnique.mockResolvedValue(company({ nodeType: 'sector_group', geographyCode: 'TR' }));
        await expect(service.update(masterkey(), 'sub-2', { geographyCode: 'UK' })).rejects.toMatchObject({
          response: { code: 'node_placement_invalid' },
        });
        expect(prisma.txClient.subsidiary.update).not.toHaveBeenCalled();
        // Sent back unchanged with a rename: no change to refuse.
        prisma.txClient.subsidiary.update.mockResolvedValue(company({ nodeType: 'sector_group', geographyCode: 'TR' }));
        await service.update(masterkey(), 'sub-2', { legalName: 'Renamed', geographyCode: 'TR' });
        expect(prisma.txClient.subsidiary.update).toHaveBeenCalledTimes(1);
      });

      it('judges the stored-geography exception against the row as locked: a stale edit cannot write an unpriced one back (owner review, P2)', async () => {
        // Read as EU before the transaction; changed to TR meanwhile.
        prisma.subsidiary.findUnique.mockResolvedValue(company({ geographyCode: 'EU' }));
        prisma.txClient.subsidiary.findUnique.mockResolvedValue(company({ geographyCode: 'TR' }));
        await expect(service.update(masterkey(), 'sub-2', { legalName: 'Renamed', geographyCode: 'EU' })).rejects.toMatchObject({
          status: 422,
          response: { code: 'geography_without_factors' },
        });
        expect(prisma.txClient.subsidiary.update).not.toHaveBeenCalled();
      });

      it('accepts a change to a priced geography', async () => {
        prisma.subsidiary.findUnique.mockResolvedValue(company({ geographyCode: 'UK' }));
        await service.update(masterkey(), 'sub-2', { geographyCode: 'TR' });
        expect(prisma.txClient.subsidiary.update.mock.calls[0][0].data).toEqual({ geographyCode: 'TR' });
      });
    });
  });

  describe('lock order, scoped counts and cascaded grants (WP7 reviews)', () => {
    const company = () => makeSubsidiary({ id: 'sub-2', parentId: 'sub-root', nodeType: 'company', geographyCode: 'TR' });

    it.each([
      ['a move', { parentId: 'sub-3' }],
      ['an associate tick', { control: 'associate' as const }],
    ])("%s takes the organisation's tree lock, then the node FOR NO KEY UPDATE, before it reads anything", async (_what, dto) => {
      prisma.subsidiary.findUnique.mockResolvedValue(company());
      tree(prisma, [ROOT, { id: 'sub-3', nodeType: 'sector_group' }]);
      await service.update(masterkey(), 'sub-2', dto).catch(() => undefined);
      // The admin lock (the actor re-read), then the tree lock, then the row.
      const advisory = prisma.txClient.$executeRaw.mock;
      const sql = advisory.calls.map((c) => (c[0] as TemplateStringsArray).join('?'));
      const treeAt = sql.findIndex((q) => /pg_advisory_xact_lock\(hashtext\('tonyai\.subsidiary_tree'\), hashtext\(\?\)\)/.test(q));
      expect(treeAt).toBe(1);
      expect(sql[0]).toMatch(/pg_advisory_xact_lock\(\?::int4, \?::int4\)/);
      expect(advisory.calls[treeAt][1]).toBe(makeSubsidiary().organisationId);
      expect(prisma.txClient.profile.findUnique.mock.invocationCallOrder[0]).toBeLessThan(advisory.invocationCallOrder[treeAt]);
      const rowLock = prisma.txClient.$queryRaw.mock;
      expect((rowLock.calls[0][0] as TemplateStringsArray).join('?')).toMatch(/FOR NO KEY UPDATE$/);
      expect(advisory.invocationCallOrder[treeAt]).toBeLessThan(rowLock.invocationCallOrder[0]);
      const reads = [
        ...prisma.txClient.activityRecord.count.mock.invocationCallOrder,
        ...prisma.txClient.userSubsidiaryAccess.count.mock.invocationCallOrder,
        ...prisma.txClient.subsidiary.update.mock.invocationCallOrder,
        ...rowLock.invocationCallOrder.slice(1),
      ];
      expect(reads.length).toBeGreaterThan(0);
      for (const at of reads) expect(at).toBeGreaterThan(rowLock.invocationCallOrder[0]);
    });

    it("decides and audits from the row as locked, not the read before the transaction (owner review, P2)", async () => {
      // Read before: under the root. Moved under sub-b meanwhile, then locked.
      prisma.subsidiary.findUnique.mockResolvedValue(company());
      prisma.txClient.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-2', parentId: 'sub-b', nodeType: 'company', geographyCode: 'TR' }));
      tree(prisma, [ROOT, { id: 'sub-b', nodeType: 'sub_holding' }, { id: 'sub-3', nodeType: 'sector_group' }]);
      prisma.txClient.$queryRaw
        .mockResolvedValueOnce([{ id: 'locked' }])
        .mockResolvedValueOnce([{ cycle: false }])
        .mockResolvedValueOnce([{ records: false }]);
      prisma.txClient.subsidiary.update.mockResolvedValue(makeSubsidiary({ id: 'sub-2', parentId: 'sub-3', nodeType: 'company', geographyCode: 'TR' }));
      await service.update(masterkey(), 'sub-2', { parentId: 'sub-3' });
      const row = audit.record.mock.calls.map((c) => c[1]).find((r) => r.entity === 'subsidiary');
      expect(row.diff.before.parentId).toBe('sub-b');
      expect(row.diff.after.parentId).toBe('sub-3');
      // And the move the locked row already holds is no change at all.
      prisma.txClient.subsidiary.update.mockClear();
      prisma.txClient.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-2', parentId: 'sub-3', nodeType: 'company', geographyCode: 'TR' }));
      await service.update(masterkey(), 'sub-2', { parentId: 'sub-3' });
      expect(prisma.txClient.subsidiary.update.mock.calls[0][0].data).toEqual({});
    });

    it('answers a company deleted while the update waited for its lock as unknown', async () => {
      prisma.subsidiary.findUnique.mockResolvedValue(company());
      prisma.txClient.subsidiary.findUnique.mockResolvedValue(null);
      await expect(service.update(masterkey(), 'sub-2', { legalName: 'x' })).rejects.toMatchObject({ response: { code: 'subsidiary_not_found' } });
      expect(prisma.txClient.subsidiary.update).not.toHaveBeenCalled();
    });

    it('a rename takes no tree lock', async () => {
      prisma.subsidiary.findUnique.mockResolvedValue(company());
      prisma.txClient.subsidiary.update.mockResolvedValue(company());
      await service.update(masterkey(), 'sub-2', { legalName: 'Renamed' });
      const sql = prisma.txClient.$executeRaw.mock.calls.map((c) => (c[0] as TemplateStringsArray).join('?'));
      expect(sql.some((q) => q.includes('subsidiary_tree'))).toBe(false);
    });

    it("the panel counts only the children its reader can read; a delete counts every one", async () => {
      prisma.subsidiary.findUnique.mockResolvedValue(company());
      const reader = makeSuperAdmin({ accessibleSubsidiaryIds: ['sub-2'] });
      await service.summary(reader, 'sub-2');
      expect(prisma.txClient.subsidiary.count).toHaveBeenCalledWith({ where: { parentId: 'sub-2', id: { in: ['sub-2'] } } });
      await service.remove(masterkey(), 'sub-2').catch(() => undefined);
      expect(prisma.txClient.subsidiary.count).toHaveBeenCalledWith({ where: { parentId: 'sub-2' } });
    });

    it('a delete audits each grant its cascade removes', async () => {
      prisma.subsidiary.findUnique.mockResolvedValue(company());
      prisma.txClient.subsidiary.delete.mockResolvedValue(company());
      // Only the grants this delete's own statement removed (owner review, P2).
      prisma.txClient.$queryRaw.mockImplementation((async (sql: TemplateStringsArray, ...values: unknown[]) =>
        sql.join('?').includes('DELETE FROM user_subsidiary_access')
          ? (values[0] === 'sub-2' ? [{ userId: 'u-b' }, { userId: 'u-a' }] : [])
          : [{ id: 'locked' }]) as never);
      await service.remove(masterkey(), 'sub-2');
      expect(prisma.txClient.$queryRaw.mock.calls.map((c) => (c[0] as unknown as string[]).join('?')).find((q) => q.includes('DELETE')))
        .toMatch(/DELETE FROM user_subsidiary_access WHERE subsidiary_id = \?::uuid RETURNING/);
      const grantRows = audit.record.mock.calls.map((c) => c[1]).filter((r) => r.entity === 'subsidiary_access');
      expect(grantRows).toEqual([
        { action: 'delete', entity: 'subsidiary_access', entityId: 'u-a', diff: { subsidiaryId: 'sub-2', reason: 'company deleted' } },
        { action: 'delete', entity: 'subsidiary_access', entityId: 'u-b', diff: { subsidiaryId: 'sub-2', reason: 'company deleted' } },
      ]);
      expect(audit.record.mock.calls.every((c) => c[2] === prisma.txClient)).toBe(true);
    });
  });

  describe('the actor as it stands, and the row as deleted (owner review of WP7, P2)', () => {
    it('a masterkey demoted while the request waited creates nothing (third review, P2)', async () => {
      tree(prisma, [ROOT]);
      prisma.txClient.profile.findUnique.mockResolvedValue({
        role: 'auditor', organisationId: 'org-1', disabledAt: null, organisation: { offboardedAt: null }, subsidiaryAccess: [],
      });
      await expect(service.create(masterkey(), { legalName: 'New', geographyCode: 'TR', parentId: 'sub-root' } as never)).rejects.toBeDefined();
      expect(prisma.txClient.subsidiary.create).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    const company = (over: Partial<Subsidiary> = {}) => makeSubsidiary({ id: 'sub-2', parentId: 'sub-root', nodeType: 'company', geographyCode: 'TR', ...over });

    it.each([
      ['demoted', { role: 'auditor' }],
      ['disabled', { disabledAt: new Date() }],
    ])('a masterkey %s while the request waited updates and deletes nothing', async (_what, over) => {
      prisma.subsidiary.findUnique.mockResolvedValue(company());
      prisma.txClient.profile.findUnique.mockResolvedValue({
        role: 'masterkey', organisationId: 'org-1', disabledAt: null, organisation: { offboardedAt: null }, subsidiaryAccess: [], ...over,
      });
      await expect(service.update(masterkey(), 'sub-2', { legalName: 'x' })).rejects.toBeDefined();
      await expect(service.remove(masterkey(), 'sub-2')).rejects.toBeDefined();
      expect(prisma.txClient.subsidiary.update).not.toHaveBeenCalled();
      expect(prisma.txClient.subsidiary.delete).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it("a delete's audit row holds the row it removed, not the read before the transaction", async () => {
      prisma.subsidiary.findUnique.mockResolvedValue(company({ legalName: 'Before' }));
      prisma.txClient.subsidiary.delete.mockResolvedValue(company({ legalName: 'Renamed meanwhile', parentId: 'sub-b' }));
      await service.remove(masterkey(), 'sub-2');
      const row = audit.record.mock.calls.map((c) => c[1]).find((r) => r.entity === 'subsidiary');
      expect(row.diff.before).toMatchObject({ legalName: 'Renamed meanwhile', parentId: 'sub-b' });
    });
  });

  describe("a company moved to another organisation since the request arrived (owner's sixth review of WP7, P2)", () => {
    it('is unknown to the detail, the summary, an update and a delete', async () => {
      prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-2', organisationId: 'org-2' }));
      for (const read of [
        () => service.get(masterkey(), 'sub-2'),
        () => service.summary(masterkey(), 'sub-2'),
        () => service.update(masterkey(), 'sub-2', { legalName: 'x' }),
        () => service.remove(masterkey(), 'sub-2'),
      ]) {
        await expect(read()).rejects.toMatchObject({ response: { code: 'subsidiary_not_found' } });
      }
      expect(prisma.txClient.subsidiary.update).not.toHaveBeenCalled();
      expect(prisma.txClient.subsidiary.delete).not.toHaveBeenCalled();
    });
  });

  describe('the parent a reader may see (D4, 3.8)', () => {
    const child = makeSubsidiary({ id: 'sub-c', parentId: 'sub-p', nodeType: 'child_company' });

    it("answers null for a super_admin granted a child but not its parent, in the list and the detail", async () => {
      const superAdmin = makeSuperAdmin({ accessibleSubsidiaryIds: ['sub-c'] });
      prisma.subsidiary.findMany.mockResolvedValue([child]);
      prisma.subsidiary.findUnique.mockResolvedValue(child);
      expect((await service.list(superAdmin))[0].parentId).toBeNull();
      expect((await service.get(superAdmin, 'sub-c')).parentId).toBeNull();
      expect(JSON.stringify(await service.list(superAdmin))).not.toContain('sub-p');
    });

    it('answers the stored parent to a masterkey and an auditor', async () => {
      prisma.subsidiary.findMany.mockResolvedValue([child]);
      prisma.subsidiary.findUnique.mockResolvedValue(child);
      expect((await service.list(masterkey()))[0].parentId).toBe('sub-p');
      const auditor = makeAuditor({ accessibleSubsidiaryIds: ['sub-p', 'sub-c'] });
      expect((await service.get(auditor, 'sub-c')).parentId).toBe('sub-p');
    });

    it('answers a super_admin granted both the stored parent', async () => {
      const superAdmin = makeSuperAdmin({ accessibleSubsidiaryIds: ['sub-p', 'sub-c'] });
      prisma.subsidiary.findMany.mockResolvedValue([child]);
      expect((await service.list(superAdmin))[0].parentId).toBe('sub-p');
    });
  });

  describe('the boundary-exclusions note (5.2)', () => {
    it("lists the associates a masterkey reads, with their share percent", async () => {
      prisma.subsidiary.findMany.mockResolvedValue([
        { id: 'sub-x', legalName: 'Dünya Katılım', sharePercent: new Prisma.Decimal(20) },
        { id: 'sub-y', legalName: 'Other', sharePercent: null },
      ]);
      expect(await service.boundaryExclusions(masterkey())).toEqual([
        { subsidiaryId: 'sub-x', legalName: 'Dünya Katılım', sharePercent: 20 },
        { subsidiaryId: 'sub-y', legalName: 'Other', sharePercent: null },
      ]);
      expect(prisma.subsidiary.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: { in: masterkey().accessibleSubsidiaryIds }, organisationId: 'org-1', control: 'associate' } }),
      );
    });

    it('names none to a scoped reader, and reads nothing for it (owner\'s third review, P2)', async () => {
      prisma.subsidiary.findMany.mockResolvedValue([{ id: 'sub-x', legalName: 'Withdrawn Since', sharePercent: null }]);
      expect(await service.boundaryExclusions(makeSuperAdmin({ accessibleSubsidiaryIds: ['sub-x'] }))).toEqual([]);
      expect(prisma.subsidiary.findMany).not.toHaveBeenCalled();
    });

    it('reads within the auditor\'s set too', async () => {
      prisma.subsidiary.findMany.mockResolvedValue([]);
      const auditor = makeAuditor();
      await service.boundaryExclusions(auditor);
      expect(prisma.subsidiary.findMany.mock.calls[0][0].where.id).toEqual({ in: auditor.accessibleSubsidiaryIds });
    });

    it('answers a super_admin within its grants — empty, since no grant names an associate', async () => {
      prisma.subsidiary.findMany.mockResolvedValue([]);
      expect(await service.boundaryExclusions(makeSuperAdmin())).toEqual([]);
      expect(await service.boundaryExclusions(makeSuperAdmin({ accessibleSubsidiaryIds: [] }))).toEqual([]);
    });
  });
});
