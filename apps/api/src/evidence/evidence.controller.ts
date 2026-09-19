import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/auth.types';
import { EvidenceService } from './evidence.service';
import { EVIDENCE_MAX_SIZE_BYTES } from '@tonyai/shared-types';
import { ParseUuidParamPipe } from '../common/parse-uuid-param.pipe';
import { UploadEvidenceForRecordsDto } from './dto/upload-evidence-for-records.dto';

// multer defaults `defParamCharset` to 'latin1', so a browser's UTF-8
// filename bytes were decoded as latin1 and `originalname` arrived already
// mangled — "Şubat" became "Åubat" BEFORE any of our code saw it. That
// mojibake was then stored, listed, and printed into the evidence appendix of
// customer-facing report PDFs. Round-1 DE-8.
const FILE_NAME_CHARSET = 'utf8';

@Controller()
export class EvidenceController {
  constructor(private readonly service: EvidenceService) {}

  /** List evidence files linked to an activity record. */
  @Get('activity-records/:recordId/evidence')
  list(
    @CurrentUser() user: RequestUser,
    @Param('recordId', ParseUuidParamPipe) recordId: string,
  ) {
    return this.service.list(user, recordId);
  }

  /** Attach an evidence file to an activity record (multipart `file`). */
  @Post('activity-records/:recordId/evidence')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: EVIDENCE_MAX_SIZE_BYTES },
      defParamCharset: FILE_NAME_CHARSET,
    }),
  )
  upload(
    @CurrentUser() user: RequestUser,
    @Param('recordId', ParseUuidParamPipe) recordId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.service.upload(user, recordId, file);
  }

  /**
   * Upload one file for several records of one subsidiary (multipart `file` +
   * `recordIds`, a JSON array). All or nothing: one record that cannot take
   * the file refuses the upload, naming every refused record.
   */
  @Post('evidence')
  @UseInterceptors(
    FileInterceptor('file', {
      // busboy defaults `fields` and `parts` to Infinity; one file and one
      // field is the whole contract. `fieldSize` stays at busboy's 1 MB — a
      // thousand ids are ~39 KB of JSON.
      limits: {
        fileSize: EVIDENCE_MAX_SIZE_BYTES,
        files: 1,
        fields: 2,
        parts: 4,
      },
      defParamCharset: FILE_NAME_CHARSET,
    }),
  )
  uploadForRecords(
    @CurrentUser() user: RequestUser,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: UploadEvidenceForRecordsDto,
  ) {
    return this.service.uploadForRecords(user, body.recordIds, file);
  }

  /** Take a file off one record; deleting the file when that was its last record. */
  @Delete('activity-records/:recordId/evidence/:evidenceId')
  detach(
    @CurrentUser() user: RequestUser,
    @Param('recordId', ParseUuidParamPipe) recordId: string,
    @Param('evidenceId', ParseUuidParamPipe) evidenceId: string,
  ) {
    return this.service.detach(user, recordId, evidenceId);
  }

  /** Short-lived signed download URL for one evidence file. */
  @Get('evidence/:id/url')
  signedUrl(@CurrentUser() user: RequestUser, @Param('id', ParseUuidParamPipe) id: string) {
    return this.service.signedUrl(user, id);
  }

  /** Delete a file from every record it backs (only while each of them is still editable). */
  @Delete('evidence/:id')
  remove(@CurrentUser() user: RequestUser, @Param('id', ParseUuidParamPipe) id: string) {
    return this.service.remove(user, id);
  }
}
