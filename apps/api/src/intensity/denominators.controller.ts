import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/auth.types';
import { IntensityService } from './intensity.service';
import { CreateDenominatorDto } from './dto/create-denominator.dto';
import { UpdateDenominatorDto } from './dto/update-denominator.dto';
import { DenominatorPageQueryDto } from './dto/denominator-page-query.dto';
import { ParseUuidParamPipe } from '../common/parse-uuid-param.pipe';

@Controller('denominators')
export class DenominatorsController {
  constructor(private readonly service: IntensityService) {}

  /** One `CursorPage` of intensity denominators (tenant-scoped; LP4-05 PR C). */
  @Get()
  list(@CurrentUser() user: RequestUser, @Query() query: DenominatorPageQueryDto) {
    return this.service.listDenominatorPage(user, query);
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
    @Param('id', ParseUuidParamPipe) id: string,
    @Body() dto: UpdateDenominatorDto,
  ) {
    return this.service.updateDenominator(user, id, dto);
  }

  /** Remove a denominator — super_admin only, audited. */
  @Delete(':id')
  remove(@CurrentUser() user: RequestUser, @Param('id', ParseUuidParamPipe) id: string) {
    return this.service.removeDenominator(user, id);
  }
}
