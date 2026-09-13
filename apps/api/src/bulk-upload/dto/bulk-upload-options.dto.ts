import { Transform } from 'class-transformer';
import { IsBoolean } from 'class-validator';

/**
 * The multipart fields that travel beside the file.
 *
 * `dryRun` decides whether a thousand rows are written or nothing is, so it is
 * the one flag in this codebase that must NEVER coerce. A permissive
 * `Boolean(value)` would turn `dryRun=yes`, `dryRun=1` or a typo into `false`
 * and import a file the user asked only to be told about — irreversibly, since
 * each row lands as its own audited record. So the transform is an allow-list:
 * exactly `true`/`'true'` and `false`/`'false'` become booleans, and EVERY
 * other value falls through to `@IsBoolean` and is refused.
 *
 * "Every other value" includes the empty one, which this used to get wrong:
 * `dryRun=` — the field present but blank — mapped to `false` and imported the
 * whole file, while this comment already promised that anything unrecognised
 * is refused. A blank is not a spelling of false. (The web client never sends
 * one; the endpoint is the contract, not the client.)
 *
 * It is REQUIRED, not defaulted. `@Transform` never fires for a key absent
 * from the body, so omitting the field is a 400 — and a programmatic caller
 * passing `null` or `undefined` gets the same refusal rather than an apply.
 */
export class BulkUploadOptionsDto {
  @Transform(({ value }) => {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return value;
  })
  @IsBoolean()
  dryRun!: boolean;
}
