import { IsIn } from 'class-validator';
import { PASSWORD_SET_FLOWS, type PasswordSetFlow, type RecordPasswordSetRequest } from '@tonyai/shared-types';

/** POST /me/password-set (`pre-g5-security-hardening`). The whitelisting pipe refuses any other field. */
export class RecordPasswordSetDto implements RecordPasswordSetRequest {
  @IsIn(PASSWORD_SET_FLOWS)
  flow!: PasswordSetFlow;
}
