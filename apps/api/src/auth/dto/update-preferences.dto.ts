import { IsIn } from 'class-validator';
import { SUPPORTED_LOCALES, type Locale, type UpdatePreferencesRequest } from '@tonyai/shared-types';

/** PATCH /me/preferences. The whitelisting pipe refuses any other field. */
export class UpdatePreferencesDto implements UpdatePreferencesRequest {
  @IsIn(SUPPORTED_LOCALES)
  language!: Locale;
}
