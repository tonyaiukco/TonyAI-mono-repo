import { Transform } from 'class-transformer';
import { IsBoolean } from 'class-validator';

/**
 * The multipart fields that travel beside the file.
 *
 * `dryRun` decides whether a thousand rows are written or nothing is, so it is
 * the one flag in this codebase that must NEVER coerce. A permissive
 * `Boolean(value)` would turn `dryRun=yes`, `dryRun=1` or a typo into `false`
 * and import a file the user asked only to be told about — irreversibly, since
 * each row lands as its own audited record. Anything that is not a recognised
 * spelling of true or false falls through to `@IsBoolean` and is refused.
 *
 * It is REQUIRED, not defaulted. `@Transform` never fires for a key absent
 * from the body, so omitting the field is a 400 — and that is the right
 * contract for this flag: a caller who did not say which one they wanted
 * should be told, not guessed at. (The `undefined` branch below is therefore
 * unreachable over multipart; it is kept for a direct programmatic caller.)
 */
export class BulkUploadOptionsDto {
  @Transform(({ value }) => {
    if (value === undefined || value === null || value === '') return false;
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return value;
  })
  @IsBoolean()
  dryRun!: boolean;
}
