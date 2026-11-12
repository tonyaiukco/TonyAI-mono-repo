import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import type {
  ActivityCalculationSnapshot,
  EmissionFactorDetailDTO,
  FactorCoverageDTO,
  ReleaseParametersDTO,
  SealedFactorReleaseDTO,
} from '@tonyai/shared-types';
import { CalculationsService } from './calculations.service';
import { CalculationInputDto } from './dto/calculation-input.dto';
import { ListFactorsQueryDto } from './dto/list-factors-query.dto';
import { ReleaseParametersQueryDto } from './dto/release-parameters-query.dto';

// Auth is enforced globally by SupabaseAuthGuard (APP_GUARD). Every route is
// read-only (preview + reference-data listing), so no RBAC/audit is required.
@Controller()
export class CalculationsController {
  constructor(private readonly service: CalculationsService) {}

  @Post('calculations/preview')
  @HttpCode(HttpStatus.OK)
  // The preview mirrors what would be STORED, so it returns the same union the
  // record does: an invoice-tracked category with no factor previews as the
  // explicit "not calculated" shape rather than 404-ing the Data Entry form.
  preview(@Body() dto: CalculationInputDto): Promise<ActivityCalculationSnapshot> {
    return this.service.compute(dto);
  }

  @Get('factors')
  listFactors(@Query() query: ListFactorsQueryDto): Promise<EmissionFactorDetailDTO[]> {
    return this.service.listFactors(query);
  }

  // Reference data like the listing above: the values Data Entry shows beside
  // a TR record's inputs (8,250, a leak rate) before a preview can price one.
  @Get('factors/parameters')
  releaseParameters(@Query() query: ReleaseParametersQueryDto): Promise<ReleaseParametersDTO> {
    return this.service.releaseParameters(query);
  }

  // Reference data too: the geographies and years the library prices under
  // this API's placeholder policy — the Data Entry legend (BUG-R2-09).
  @Get('factors/coverage')
  coverage(): Promise<FactorCoverageDTO> {
    return this.service.coverage();
  }

  // Reference data: each sealed release with its database-set seal date, which
  // the screens show beside the release a figure names (UAT round 2, S2).
  @Get('factors/releases')
  listSealedReleases(): Promise<SealedFactorReleaseDTO[]> {
    return this.service.listSealedReleases();
  }
}
