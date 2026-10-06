import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import type {
  ActivityCalculationSnapshot,
  EmissionFactorDetailDTO,
} from '@tonyai/shared-types';
import { CalculationsService } from './calculations.service';
import { CalculationInputDto } from './dto/calculation-input.dto';
import { ListFactorsQueryDto } from './dto/list-factors-query.dto';

// Auth is enforced globally by SupabaseAuthGuard (APP_GUARD). Both routes are
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
}
