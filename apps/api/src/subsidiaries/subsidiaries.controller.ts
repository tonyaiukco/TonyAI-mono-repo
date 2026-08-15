import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/auth.types';
import { SubsidiariesService } from './subsidiaries.service';
import { CreateSubsidiaryDto } from './dto/create-subsidiary.dto';
import { UpdateSubsidiaryDto } from './dto/update-subsidiary.dto';
import { ParseUuidParamPipe } from '../common/parse-uuid-param.pipe';

@Controller('subsidiaries')
export class SubsidiariesController {
  constructor(private readonly service: SubsidiariesService) {}

  @Get()
  list(@CurrentUser() user: RequestUser) {
    return this.service.list(user);
  }

  @Get(':id')
  get(@CurrentUser() user: RequestUser, @Param('id', ParseUuidParamPipe) id: string) {
    return this.service.get(user, id);
  }

  /**
   * Counts of everything hanging off this subsidiary, for the control panel.
   *
   * Declared AFTER `@Get(':id')` and safe regardless of order: `:id` matches a
   * SINGLE path segment and will not cross a `/`, so a two-segment path can
   * never match it. The UUID pipe has nothing to do with it — pipes run after
   * the route has already been chosen, so a literal like `@Get('summary')`
   * WOULD need to precede `:id`.
   */
  @Get(':id/summary')
  summary(@CurrentUser() user: RequestUser, @Param('id', ParseUuidParamPipe) id: string) {
    return this.service.summary(user, id);
  }

  @Post()
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateSubsidiaryDto) {
    return this.service.create(user, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUuidParamPipe) id: string,
    @Body() dto: UpdateSubsidiaryDto,
  ) {
    return this.service.update(user, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: RequestUser, @Param('id', ParseUuidParamPipe) id: string) {
    return this.service.remove(user, id);
  }
}
