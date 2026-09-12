import {
  Body,
  Controller,
  Get,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { BULK_UPLOAD_MAX_SIZE_BYTES } from '@tonyai/shared-types';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/auth.types';
import { BulkUploadService } from './bulk-upload.service';
import { BulkUploadOptionsDto } from './dto/bulk-upload-options.dto';
import { UserThrottlerGuard } from './user-throttler.guard';

@Controller('bulk-upload')
// Scoped to this controller, NOT registered as a second APP_GUARD. WP9 owns
// global rate-limit tuning; a global guard added here would quietly change
// every other endpoint's behaviour before that work has a say. This is also
// the only route where one request can mean a thousand writes.
@UseGuards(UserThrottlerGuard)
export class BulkUploadController {
  constructor(private readonly service: BulkUploadService) {}

  /**
   * The import template: an XLSX whose first sheet carries exactly the columns
   * the importer accepts, and whose second sheet — which the importer never
   * reads — lists the caller's own reporting entities and the vocabularies.
   *
   * Its own, looser throttle — **not** because a tighter one would eat the
   * import budget. Throttler keys include the handler name, so a limit here
   * would have its own bucket and could never consume a unit of `import`'s;
   * an earlier version of this comment said otherwise and was simply wrong.
   * The real reason is cost: building this workbook is tens of milliseconds
   * against an import's thousands, so holding it to five a minute would
   * ration the cheap half of the feature to protect the expensive one.
   */
  @Get('template')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
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
  // Five per minute PER USER (see UserThrottlerGuard — the default tracker
  // would have made this five per minute for the whole product behind a
  // reverse proxy). An import is a deliberate act a person performs once or
  // twice, so this is loose enough that correcting a file and retrying is
  // never blocked, and tight enough that the endpoint cannot be used as a
  // 7,000-query-per-request amplifier. In-memory and therefore per replica,
  // which is honest to state rather than to pretend otherwise.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @UseInterceptors(
    FileInterceptor('file', {
      // `fileSize` is the one that matters, but the others are not decoration:
      // busboy defaults `fields` and `parts` to Infinity, and
      // `forbidNonWhitelisted` only rejects extras AFTER multer has buffered
      // every one of them. Four fields is `file` plus `dryRun` plus slack.
      limits: {
        fileSize: BULK_UPLOAD_MAX_SIZE_BYTES,
        files: 1,
        fields: 4,
        parts: 6,
      },
      // Same reason as the evidence upload: multer decodes filename bytes as
      // latin1 by default, so a Turkish filename arrives mangled before any of
      // our code sees it — and here the filename is echoed in the report and
      // written to the audit row.
      defParamCharset: 'utf8',
    }),
  )
  import(
    @CurrentUser() user: RequestUser,
    @UploadedFile() file: Express.Multer.File,
    @Body() options: BulkUploadOptionsDto,
  ) {
    return this.service.import(user, file, options);
  }

}
