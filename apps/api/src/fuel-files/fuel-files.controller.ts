import { Body, Controller, Get, HttpCode, Param, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { FuelFilePreviewDTO, FuelTrayDTO, FuelUploadDTO } from '@tonyai/shared-types';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/auth.types';
import { FUEL_MULTIPART_LIMITS } from '../common/multipart-limits';
import { ParseUuidParamPipe } from '../common/parse-uuid-param.pipe';
import { RuntimeUploadWorkInterceptor } from '../common/runtime-request';
import { FuelFileFieldsDto } from './dto/fuel-file-fields.dto';
import { TakeOverFuelRowsDto, WithdrawFuelRowsDto } from './dto/fuel-rows.dto';
import { FuelFilesService } from './fuel-files.service';
import { FuelUploadsService } from './fuel-uploads.service';

/**
 * The fuel file upload (inc28-fuel-bulk D3, D8, D14). The two multipart routes
 * are in the import group (`routeGroup`): the per-user import quota and the
 * import concurrency permit, under the fuel upload's own body cap.
 */
@Controller('fuel-files')
export class FuelFilesController {
  constructor(
    private readonly files: FuelFilesService,
    private readonly uploads: FuelUploadsService,
  ) {}

  @Post('preview')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: FUEL_MULTIPART_LIMITS, defParamCharset: 'utf8' }), RuntimeUploadWorkInterceptor)
  preview(
    @CurrentUser() user: RequestUser,
    @UploadedFile() file: Express.Multer.File,
    @Body() fields: FuelFileFieldsDto,
  ): Promise<FuelFilePreviewDTO> {
    return this.files.preview(user, file, fields);
  }

  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: FUEL_MULTIPART_LIMITS, defParamCharset: 'utf8' }), RuntimeUploadWorkInterceptor)
  apply(
    @CurrentUser() user: RequestUser,
    @UploadedFile() file: Express.Multer.File,
    @Body() fields: FuelFileFieldsDto,
  ): Promise<FuelUploadDTO> {
    return this.files.apply(user, file, fields);
  }

  @Get()
  list(@CurrentUser() user: RequestUser): Promise<FuelUploadDTO[]> {
    return this.uploads.list(user);
  }

  @Get('tray')
  tray(@CurrentUser() user: RequestUser): Promise<FuelTrayDTO> {
    return this.uploads.tray(user);
  }

  @Get(':id')
  detail(@CurrentUser() user: RequestUser, @Param('id', ParseUuidParamPipe) id: string): Promise<FuelUploadDTO> {
    return this.uploads.detail(user, id);
  }

  @Post(':id/withdraw-rows')
  @HttpCode(200)
  withdrawRows(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUuidParamPipe) id: string,
    @Body() body: WithdrawFuelRowsDto,
  ): Promise<FuelUploadDTO> {
    return this.uploads.withdrawRows(user, id, body);
  }

  @Post(':id/take-over')
  @HttpCode(200)
  takeOver(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUuidParamPipe) id: string,
    @Body() body: TakeOverFuelRowsDto,
  ): Promise<FuelUploadDTO> {
    return this.uploads.takeOver(user, id, body);
  }
}
