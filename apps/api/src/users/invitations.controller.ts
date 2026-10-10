import { Controller, HttpCode, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/auth.types';
import { UserLifecycleService } from './user-lifecycle.service';

/** The invitee's side of an invitation (LP4-01). */
@Controller('invitations')
export class InvitationsController {
  constructor(private readonly lifecycle: UserLifecycleService) {}

  /** Called by `/auth/confirm` once `verifyOtp` has signed the invitee in. */
  @Post('accept')
  @HttpCode(204)
  async accept(@CurrentUser() user: RequestUser): Promise<void> {
    await this.lifecycle.accept(user);
  }
}
