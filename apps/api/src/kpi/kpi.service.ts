import { Injectable } from '@nestjs/common';
import type { DashboardKpi } from '@tonyai/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestUser } from '../auth/auth.types';
import { HOLDS_RECORDS_WHERE } from '../subsidiaries/reporting-set';

@Injectable()
export class KpiService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(user: RequestUser): Promise<DashboardKpi> {
    const [subs, totalLocations] = await Promise.all([
      // The reporting set (inc26-group-tree, D6): the companies that can hold
      // records, and their facilities — never a sector group or an associate.
      this.prisma.subsidiary.findMany({
        where: { id: { in: user.accessibleSubsidiaryIds }, ...HOLDS_RECORDS_WHERE },
        select: { reportingStatus: true, geographyCode: true },
      }),
      this.prisma.location.count({
        where: { subsidiaryId: { in: user.accessibleSubsidiaryIds }, subsidiary: HOLDS_RECORDS_WHERE },
      }),
    ]);

    const geoCounts = new Map<string, number>();
    for (const s of subs) {
      geoCounts.set(s.geographyCode, (geoCounts.get(s.geographyCode) ?? 0) + 1);
    }

    return {
      totalSubsidiaries: subs.length,
      activeSubsidiaries: subs.filter((s) => s.reportingStatus === 'active').length,
      pendingSubsidiaries: subs.filter((s) => s.reportingStatus === 'pending').length,
      totalLocations,
      geographyBreakdown: Array.from(geoCounts.entries()).map(([geographyCode, count]) => ({
        geographyCode,
        count,
      })),
    };
  }
}
