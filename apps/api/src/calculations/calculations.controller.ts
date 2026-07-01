import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import type { CalculationResult, EmissionFactorDTO } from '@tonyai/shared-types';
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
  preview(@Body() dto: CalculationInputDto): Promise<CalculationResult> {
    return this.service.compute(dto);
  }

  @Get('factors')
  listFactors(@Query() query: ListFactorsQueryDto): Promise<EmissionFactorDTO[]> {
    return this.service.listFactors(query);
  }
}
