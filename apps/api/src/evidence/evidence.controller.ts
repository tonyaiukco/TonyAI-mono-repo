import {
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

@Controller()
export class EvidenceController {
  constructor(private readonly service: EvidenceService) {}

  /** List evidence files linked to an activity record. */
  @Get('activity-records/:recordId/evidence')
  list(
    @CurrentUser() user: RequestUser,
    @Param('recordId') recordId: string,
  ) {
    return this.service.list(user, recordId);
  }

  /** Attach an evidence file to an activity record (multipart `file`). */
  @Post('activity-records/:recordId/evidence')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: EVIDENCE_MAX_SIZE_BYTES } }),
  )
  upload(
    @CurrentUser() user: RequestUser,
    @Param('recordId') recordId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.service.upload(user, recordId, file);
  }

  /** Short-lived signed download URL for one evidence file. */
  @Get('evidence/:id/url')
  signedUrl(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.service.signedUrl(user, id);
  }

  /** Remove an evidence file (while the parent record is still editable). */
  @Delete('evidence/:id')
  remove(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.service.remove(user, id);
  }
}
