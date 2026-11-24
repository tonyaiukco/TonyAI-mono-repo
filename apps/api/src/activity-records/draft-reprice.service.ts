import { Injectable } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { ActivityRecordStatus, Prisma, type ActivityRecord } from '@tonyai/db';
import { EDITABLE_RECORD_STATUSES, isCalculated, isProvenanceSnapshot, type ActivityCalculationSnapshot, type RefrigerantTerm } from '@tonyai/shared-types';
import { AuditService } from '../audit/audit.service';
import { CalculationsService } from '../calculations/calculations.service';
import { compareSnapshots } from '../calculations/snapshot-staleness';
import { PrismaService } from '../prisma/prisma.service';
import { LIFECYCLE_TX, lockActivityRecordRow, lockPeriodsShared, periodOf, samePeriod } from './lifecycle-lock';
import { ActivityRecordCalculation, sameEngineInputs } from './activity-record-calculation';

type Outcome = 'would_reprice' | 'repriced' | 'up_to_date' | 'skipped' | 'refused';

interface RepriceRecord {
  id: string;
  status: ActivityRecordStatus;
  beforeTCo2e: number | null;
  afterTCo2e: number | null;
  outcome: Outcome;
  reason?: string;
}

interface ReviewRecord {
  id: string;
  status: ActivityRecordStatus;
  tCo2e: number | null;
}

export interface DraftRepriceReport {
  mode: 'dry_run' | 'apply';
  counts: Record<Outcome | 'sum_rule_review' | 'unclassified_review', number>;
  records: RepriceRecord[];
  reviewQueue: { sumRule: ReviewRecord[]; unclassified: ReviewRecord[] };
}

const OPEN: readonly ActivityRecordStatus[] = EDITABLE_RECORD_STATUSES;
const REVIEW: ActivityRecordStatus[] = ['submitted', 'under_review'];

interface EquipmentMasses {
  equipmentType: string;
  capacityKg: number;
  refillKg: number;
}

function hasBothMasses(line: unknown): line is EquipmentMasses {
  if (!line || typeof line !== 'object') return false;
  const { equipmentType, capacityKg, refillKg } = line as Partial<EquipmentMasses>;
  return typeof equipmentType === 'string' &&
    typeof capacityKg === 'number' && capacityKg > 0 &&
    typeof refillKg === 'number' && refillKg > 0;
}

function affectedLines(parameters: ActivityRecord['parameters']): EquipmentMasses[] {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return [];
  const equipment: unknown = parameters.equipment;
  return Array.isArray(equipment) ? equipment.filter(hasBothMasses) : [];
}

function tonnes(value: unknown): number | null {
  const snapshot = value as ActivityCalculationSnapshot | null;
  return isCalculated(snapshot) ? snapshot.tCo2e : null;
}

function result(row: ActivityRecord, outcome: Outcome, calculation?: ActivityCalculationSnapshot, reason?: string): RepriceRecord {
  const beforeTCo2e = tonnes(row.calculation);
  return {
    id: row.id,
    status: row.status,
    beforeTCo2e,
    afterTCo2e: calculation === undefined ? beforeTCo2e : tonnes(calculation),
    outcome,
    ...(reason === undefined ? {} : { reason }),
  };
}

function reviewRule(
  value: ActivityRecord['calculation'],
  lines: readonly EquipmentMasses[],
): 'sumRule' | 'unclassified' | null {
  const snapshot = value as unknown as ActivityCalculationSnapshot;
  if (!isProvenanceSnapshot(snapshot) || snapshot.snapshotSchema !== 3 || !Array.isArray(snapshot.refrigerantTerms)) {
    return 'unclassified';
  }

  const terms: readonly RefrigerantTerm[] = snapshot.refrigerantTerms;
  const affectedTerms = lines.map((line) => terms.find((term) =>
    hasBothMasses(term) &&
    term.equipmentType === line.equipmentType &&
    term.capacityKg === line.capacityKg &&
    term.refillKg === line.refillKg,
  ));
  if (affectedTerms.some((term) => !term || (term.pricedBy !== undefined && term.pricedBy !== 'refill'))) {
    return 'unclassified';
  }
  return affectedTerms.some((term) => term?.pricedBy === undefined) ? 'sumRule' : null;
}

/** Operator-only service. It has no HTTP route and boots without the API's storage sweeper. */
@Injectable()
export class DraftRepriceService {
  private readonly recordCalculation: ActivityRecordCalculation;

  constructor(
    private readonly prisma: PrismaService,
    calculations: CalculationsService,
    private readonly audit: AuditService,
  ) {
    this.recordCalculation = new ActivityRecordCalculation(prisma, calculations);
  }

  async run(apply: boolean): Promise<DraftRepriceReport> {
    const rows = await this.prisma.activityRecord.findMany({
      where: {
        category: 'Refrigerants',
        status: { in: [...OPEN, ...REVIEW] },
        parameters: { not: Prisma.DbNull },
      },
      orderBy: { id: 'asc' },
    });
    const report: DraftRepriceReport = {
      mode: apply ? 'apply' : 'dry_run',
      counts: { would_reprice: 0, repriced: 0, up_to_date: 0, skipped: 0, refused: 0, sum_rule_review: 0, unclassified_review: 0 },
      records: [],
      reviewQueue: { sumRule: [], unclassified: [] },
    };
    for (const row of rows) {
      const lines = affectedLines(row.parameters);
      if (lines.length === 0) continue;
      if (REVIEW.includes(row.status)) {
        const rule = reviewRule(row.calculation, lines);
        if (rule) {
          report.reviewQueue[rule].push({ id: row.id, status: row.status, tCo2e: tonnes(row.calculation) });
          report.counts[rule === 'sumRule' ? 'sum_rule_review' : 'unclassified_review']++;
        }
        continue;
      }
      if (!OPEN.includes(row.status)) continue;
      const outcome = await this.reprice(row, apply);
      report.records.push(outcome);
      report.counts[outcome.outcome]++;
    }
    return report;
  }

  private async reprice(row: ActivityRecord, apply: boolean): Promise<RepriceRecord> {
    if (await this.periodLocked(row, this.prisma)) return result(row, 'skipped', undefined, 'locked_period');
    // A record can use only the calculation geography of its own subsidiary or location.
    const priced = await this.recordCalculation.recompute([row.subsidiaryId], row);
    if (!priced.ok) return result(row, 'refused', undefined, priced.refusal);
    if (!compareSnapshots(row.calculation, priced.calculation).stale) return result(row, 'up_to_date');
    if (!apply) return result(row, 'would_reprice', priced.calculation);
    return this.write(row, priced.calculation);
  }

  private async periodLocked(row: ActivityRecord, client: Pick<Prisma.TransactionClient, 'periodLock'>): Promise<boolean> {
    return Boolean(await client.periodLock.findFirst({ where: periodOf(row) }));
  }

  private async write(seen: ActivityRecord, calculation: ActivityCalculationSnapshot): Promise<RepriceRecord> {
    return this.prisma.$transaction(async (tx) => {
      await lockPeriodsShared(tx, [periodOf(seen)]);
      if (!(await lockActivityRecordRow(tx, seen.id))) return result(seen, 'skipped', undefined, 'no_longer_open');
      const current = await tx.activityRecord.findUnique({
        where: { id: seen.id },
        include: { subsidiary: { select: { organisationId: true } } },
      });
      if (!current || !OPEN.includes(current.status)) {
        return result(current ?? seen, 'skipped', undefined, 'no_longer_open');
      }
      if (!samePeriod(seen, current) || !sameEngineInputs(seen, current)) {
        return result(current, 'skipped', undefined, 'inputs_changed');
      }
      if (await this.periodLocked(current, tx)) return result(current, 'skipped', undefined, 'locked_period');
      if (!compareSnapshots(current.calculation, calculation).stale) return result(current, 'up_to_date');
      if (!isDeepStrictEqual(current.calculation, seen.calculation)) {
        return result(current, 'skipped', undefined, 'snapshot_changed');
      }

      const anomaly = await this.recordCalculation.detectAnomalyFor(
        calculation,
        { ...current, excludeId: current.id },
        current,
        tx,
      );
      const outcome = result(current, 'repriced', calculation);
      await tx.activityRecord.update({
        where: { id: current.id, status: current.status },
        data: {
          calculation: calculation as unknown as Prisma.InputJsonValue,
          anomalyFlag: anomaly.anomalous,
          anomalyBaselinePriorCount: anomaly.priorCount,
          anomalyBaselineTCo2e: anomaly.baseline,
        },
      });
      await this.audit.recordSystem({
        organisationId: current.subsidiary.organisationId,
        action: 'reprice',
        entity: 'activity_record',
        entityId: current.id,
        diff: { before: { tCo2e: outcome.beforeTCo2e }, after: { tCo2e: outcome.afterTCo2e } },
      }, tx);
      return outcome;
    }, LIFECYCLE_TX);
  }
}
