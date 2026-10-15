import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import type {
  InventoryBoundaryVersionDTO,
  InventoryBoundaryVersionSummary,
  PutInventoryBoundarySubsidiaryRequest,
} from '@tonyai/shared-types';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/auth.types';
import { ParseUuidParamPipe } from '../common/parse-uuid-param.pipe';
import { BoundaryWriterGuard, DeclarationSizeGuard } from './boundary-writer.guard';
import {
  CreateInventoryBoundaryDto,
  ListInventoryBoundariesQueryDto,
  PutInventoryBoundarySubsidiaryDto,
} from './dto/inventory-boundary.dto';
import { InventoryBoundariesService } from './inventory-boundaries.service';

/** LP3-04's write path (E1): a year's boundary versions and one subsidiary's
 * declaration at a time. Roles and refusals are the service's; a write is also
 * refused before its body is validated (`boundary-writer.guard.ts`). */
@Controller('inventory-boundaries')
export class InventoryBoundariesController {
  constructor(private readonly service: InventoryBoundariesService) {}

  @Get()
  list(@CurrentUser() user: RequestUser, @Query() query: ListInventoryBoundariesQueryDto): Promise<InventoryBoundaryVersionSummary[]> {
    return this.service.list(user, query);
  }

  @Get(':id')
  get(@CurrentUser() user: RequestUser, @Param('id', ParseUuidParamPipe) id: string): Promise<InventoryBoundaryVersionDTO> {
    return this.service.get(user, id);
  }

  @Post()
  @UseGuards(BoundaryWriterGuard)
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateInventoryBoundaryDto): Promise<InventoryBoundaryVersionDTO> {
    return this.service.create(user, dto);
  }

  @Put(':id/subsidiaries/:subsidiaryId')
  @UseGuards(BoundaryWriterGuard, DeclarationSizeGuard)
  putSubsidiary(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUuidParamPipe) id: string,
    @Param('subsidiaryId', ParseUuidParamPipe) subsidiaryId: string,
    @Body() dto: PutInventoryBoundarySubsidiaryDto,
  ): Promise<InventoryBoundaryVersionDTO> {
    // The DTO's document check (`inventoryDeclarationIssues`) holds the flat
    // classes to the contract's unions, so a validated body is the contract's.
    return this.service.putSubsidiary(user, id, subsidiaryId, dto as PutInventoryBoundarySubsidiaryRequest);
  }

  @Delete(':id/subsidiaries/:subsidiaryId')
  @UseGuards(BoundaryWriterGuard)
  deleteSubsidiary(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUuidParamPipe) id: string,
    @Param('subsidiaryId', ParseUuidParamPipe) subsidiaryId: string,
  ): Promise<InventoryBoundaryVersionDTO> {
    return this.service.deleteSubsidiary(user, id, subsidiaryId);
  }

  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  @UseGuards(BoundaryWriterGuard)
  confirm(@CurrentUser() user: RequestUser, @Param('id', ParseUuidParamPipe) id: string): Promise<InventoryBoundaryVersionDTO> {
    return this.service.confirm(user, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(BoundaryWriterGuard)
  remove(@CurrentUser() user: RequestUser, @Param('id', ParseUuidParamPipe) id: string): Promise<void> {
    return this.service.remove(user, id);
  }
}
