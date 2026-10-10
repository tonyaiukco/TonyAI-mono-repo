import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/auth.types';
import { ParseUuidParamPipe } from '../common/parse-uuid-param.pipe';
import { ListImportBatchesQueryDto } from './dto/list-import-batches-query.dto';
import { ImportBatchesService } from './import-batches.service';

/**
 * Applied bulk imports. Reads are open to every role, scoped by
 * `ImportBatchesService`'s visibility rule (a batch you cannot see is a 404);
 * the submit is the bulk submit's own gates, with the batch naming the ids.
 */
@Controller('import-batches')
export class ImportBatchesController {
  constructor(private readonly service: ImportBatchesService) {}

  @Get()
  list(@CurrentUser() user: RequestUser, @Query() query: ListImportBatchesQueryDto) {
    return this.service.list(user, query.limit);
  }

  @Get(':id')
  detail(@CurrentUser() user: RequestUser, @Param('id', ParseUuidParamPipe) id: string) {
    return this.service.detail(user, id);
  }

  @Get(':id/source-url')
  sourceUrl(@CurrentUser() user: RequestUser, @Param('id', ParseUuidParamPipe) id: string) {
    return this.service.sourceUrl(user, id);
  }

  /** The bulk submit's budget: a batch submit is one. */
  @Post(':id/submit')
  submit(@CurrentUser() user: RequestUser, @Param('id', ParseUuidParamPipe) id: string) {
    return this.service.submit(user, id);
  }
}
