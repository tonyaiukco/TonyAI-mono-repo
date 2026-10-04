import { Module } from '@nestjs/common';
import { AccessAdminService } from './access-admin.service';
import { AuthController } from './auth.controller';

@Module({
  controllers: [AuthController],
  // The role/access mutation boundary (LP1-03). No route reaches it yet —
  // LP4-01's onboarding adds its controller.
  providers: [AccessAdminService],
  exports: [AccessAdminService],
})
export class AuthModule {}
