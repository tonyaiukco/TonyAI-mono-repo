import {
  Body,
  Controller,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
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
