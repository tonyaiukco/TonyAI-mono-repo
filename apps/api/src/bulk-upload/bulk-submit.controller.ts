import { Body, Controller, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/auth.types';
import { BulkSubmitService } from './bulk-submit.service';
import { BulkSubmitActivityRecordsDto } from './dto/bulk-submit-activity-records.dto';

/**
 * Its own controller, under `activity-records`, even though it lives in the
 * bulk-upload module.
 *
 * Placement and URL are independent decisions. The code belongs here because
 * the batch idiom is here — the loop that continues past a failure, the
 * exception-to-code mapper, the batch audit row, the per-user throttle. But
 * the RESOURCE is an activity record: this route submits drafts, and the very
 * next change extends it to drafts nobody imported. A path under
 * `/bulk-upload/` would assert a provenance the operation does not have, and
 * fixing it then would be a breaking API change.
 */
@Controller('activity-records')
export class BulkSubmitController {
  constructor(private readonly service: BulkSubmitService) {}

  /**
   * Send many drafts for review at once — the other half of an import, since
   * imported rows land as `draft` and a draft counts towards nothing.
   *
   * Its own throttle bucket: throttler keys include the handler name, so this
   * and the import never share a budget. Ten a minute, because a submit is
   * roughly an import's per-row cost with no dry-run doubling, and because a
   * partial result is the normal reason to send a second one.
   */
  @Post('bulk-submit')
  submitMany(
    @CurrentUser() user: RequestUser,
    @Body() dto: BulkSubmitActivityRecordsDto,
  ) {
    return this.service.submitMany(user, dto);
  }
}
