import { Module } from '@nestjs/common';
import { SecurityReportsController } from './security-reports.controller';

/** Browser security reports (`pre-g5-security-hardening`). */
@Module({
  controllers: [SecurityReportsController],
})
export class SecurityModule {}
