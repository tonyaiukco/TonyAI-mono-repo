import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/auth.types';
import { IntensityService } from './intensity.service';
import { CreateDenominatorDto } from './dto/create-denominator.dto';
import { UpdateDenominatorDto } from './dto/update-denominator.dto';

@Controller('denominators')
export class DenominatorsController {
  constructor(private readonly service: IntensityService) {}

  /** List intensity denominators (tenant-scoped; optional subsidiary/year). */
  @Get()
  list(
    @CurrentUser() user: RequestUser,
    @Query('subsidiaryId') subsidiaryId?: string,
    @Query('year', new ParseIntPipe({ optional: true })) year?: number,
  ) {
    return this.service.listDenominators(user, subsidiaryId, year);
  }

  /** Configure a denominator — super_admin only, audited. */
  @Post()
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateDenominatorDto) {
    return this.service.createDenominator(user, dto);
  }

  /** Update a denominator's value/unit — super_admin only, audited. */
  @Patch(':id')
  update(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: UpdateDenominatorDto,
  ) {
    return this.service.updateDenominator(user, id, dto);
  }

  /** Remove a denominator — super_admin only, audited. */
  @Delete(':id')
  remove(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.service.removeDenominator(user, id);
  }
}
