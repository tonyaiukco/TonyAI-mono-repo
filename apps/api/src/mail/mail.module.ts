import { Module } from '@nestjs/common';
import { MailService } from './mail.service';

/** Transactional email (LP4-01): invitations and password resets only. */
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
