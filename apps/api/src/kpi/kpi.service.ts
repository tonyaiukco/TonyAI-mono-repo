import { Injectable } from '@nestjs/common';
import type { DashboardKpi } from '@tonyai/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestUser } from '../auth/auth.types';

@Injectable()
export class KpiService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(user: RequestUser): Promise<DashboardKpi> {
    const subs = await this.prisma.subsidiary.findMany({
      where: { id: { in: user.accessibleSubsidiaryIds } },
      select: { reportingStatus: true, geographyCode: true },
    });

    const geoCounts = new Map<string, number>();
    for (const s of subs) {
      geoCounts.set(s.geographyCode, (geoCounts.get(s.geographyCode) ?? 0) + 1);
    }

    return {
      totalSubsidiaries: subs.length,
      activeSubsidiaries: subs.filter((s) => s.reportingStatus === 'active').length,
      pendingSubsidiaries: subs.filter((s) => s.reportingStatus === 'pending').length,
      geographyBreakdown: Array.from(geoCounts.entries()).map(([geographyCode, count]) => ({
        geographyCode,
        count,
      })),
    };
  }
}
