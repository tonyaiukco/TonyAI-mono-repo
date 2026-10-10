import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { MailModule } from '../mail/mail.module';
import { AuthAdminService } from './auth-admin.service';
import { AuthSyncService } from './auth-sync.service';
import { InvitationDeliveryService } from './invitation-delivery.service';
import { InvitationsController } from './invitations.controller';
import { PasswordResetController } from './password-reset.controller';
import { PasswordResetService } from './password-reset.service';
import { UserLifecycleService } from './user-lifecycle.service';
import { UsersController } from './users.controller';
import { UsersQueryService } from './users-query.service';

/**
 * Onboarding and the user lifecycle (LP4-01): invitations, acceptance,
 * password resets, role and access changes, disabling — over
 * `AccessAdminService` (AuthModule) for every database change.
 */
@Module({
  imports: [AuthModule, AuditModule, MailModule],
  controllers: [UsersController, InvitationsController, PasswordResetController],
  providers: [
    AuthAdminService,
    AuthSyncService,
    InvitationDeliveryService,
    PasswordResetService,
    UserLifecycleService,
    UsersQueryService,
  ],
})
export class UsersModule {}
