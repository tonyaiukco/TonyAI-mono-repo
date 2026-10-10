import { RuntimeUploadWorkInterceptor } from '../common/runtime-request';
import { IMPORT_MULTIPART_LIMITS } from '../common/multipart-limits';
import {
  Body,
  Controller,
  Get,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/auth.types';
import { BulkUploadService } from './bulk-upload.service';
import { BulkUploadOptionsDto } from './dto/bulk-upload-options.dto';

@Controller('bulk-upload')
// Global runtime admission provides the user quota and parser permit.
export class BulkUploadController {
  constructor(private readonly service: BulkUploadService) {}

  /**
   * The import template: an XLSX whose first sheet carries exactly the columns
   * the importer accepts, and whose second sheet — which the importer never
   * reads — lists the caller's own reporting entities and the vocabularies.
   *
   * Template downloads use the ordinary read quota; imports have a separate budget.
   */
  @Get('template')
  async template(
    @CurrentUser() user: RequestUser,
    @Res() res: Response,
  ): Promise<void> {
    const buffer = await this.service.template(user);
    res
      .set({
        'Content-Type':
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition':
          'attachment; filename="tonyai-bulk-upload-template.xlsx"',
        'Content-Length': buffer.length,
        // The body is this caller's own entity register, and the response
        // carries no `Vary: Authorization`. Behind a caching intermediary an
        // ETag match could otherwise serve one tenant's register to another.
        'Cache-Control': 'no-store',
      })
      .send(buffer);
  }

  /**
   * Import activity records from a CSV/XLSX (multipart `file`), optionally as
   * a dry run (`dryRun=true`) that validates and prices every row without
   * writing any of them.
   */
  @Post('activity-records')
  // Global runtime admission applies the configured per-user import quota.
  @UseInterceptors(
    FileInterceptor('file', {
      limits: IMPORT_MULTIPART_LIMITS,
      // Same reason as the evidence upload: multer decodes filename bytes as
      // latin1 by default, so a Turkish filename arrives mangled before any of
      // our code sees it — and here the filename is echoed in the report and
      // written to the audit row.
      defParamCharset: 'utf8',
    }),
    RuntimeUploadWorkInterceptor,
  )
  import(
    @CurrentUser() user: RequestUser,
    @UploadedFile() file: Express.Multer.File,
    @Body() options: BulkUploadOptionsDto,
  ) {
    return this.service.import(user, file, options);
  }

}
