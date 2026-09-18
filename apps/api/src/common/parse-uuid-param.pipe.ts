import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';

/**
 * The canonical 8-4-4-4-12 hex form, and nothing about RFC 4122 beyond it.
 *
 * This is deliberately NOT Nest's `ParseUUIDPipe`. That pipe delegates to
 * class-validator's `isUUID`, which enforces the RFC variant nibble — position
 * 17 must be one of 8/9/a/b — no matter which version you ask for, "all"
 * included. Our seed uses fixed, human-readable ids so it can stay idempotent:
 *
 *   organisation  11111111-1111-1111-1111-111111111111
 *   subsidiary    22222222-2222-2222-2222-222222220001
 *   location      33333333-3333-3333-3333-333333330001
 *
 * Every one of those has `2` in the variant position, so `ParseUUIDPipe` rejects
 * all three. Measured before writing this: adding it to the `:id` params would
 * have turned `GET /subsidiaries/2222…0001` — the first subsidiary every user
 * and every E2E spec touches — into a 400.
 *
 * Postgres's own `uuid` type does not check version or variant either; it takes
 * 32 hex digits. So the job here is exactly "do not hand Prisma something that
 * will raise P2023", and this pattern is that set, no wider and no narrower.
 */
export const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Turn a malformed id into a 400 instead of a 500.
 *
 * Routes used to hand the raw string to `findUnique`, where Prisma raised P2023
 * and Nest rendered it as `500 Internal Server Error`. Measured on a live API:
 * `DELETE /targets/not-a-uuid` and `DELETE /locations/not-a-uuid` both 500'd.
 *
 * This is robustness, not isolation: a malformed id returned the same status
 * regardless of scope, and the role gate fires first for non-admin callers, so
 * there was never an existence oracle here. It matters because the WP16
 * subsidiary-delete refusal now points users at exactly those endpoints.
 */
@Injectable()
export class ParseUuidParamPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (typeof value !== 'string' || !UUID_SHAPE.test(value)) {
      throw new BadRequestException(
        `"${value}" is not a valid id — expected a UUID.`,
      );
    }
    return value;
  }
}

/** What a DTO says about an id field that is not the accepted shape. `$property` is class-validator's. */
export const ID_SHAPE_MESSAGE =
  '$property is not an id — copy it exactly as the system shows it (8-4-4-4-12 hexadecimal, with hyphens)';

/**
 * The one spelling of an id this API accepts from a caller, or `null`.
 *
 * Postgres and Prisma resolve several spellings of a uuid (`{…}`,
 * `urn:uuid:…`, unhyphenated), and the bulk importer once folded all of them.
 * That needed a hand-measured grammar table, a probe to keep it honest and a
 * rewrite of the caller's cells — for spellings nobody types: every id this
 * system shows (the API, the template's Reference sheet) is hyphenated. So
 * the boundary accepts the hyphenated shape, in either case, and lowercases
 * it — which is how the database spells it, so string comparisons against
 * stored ids and the access set are sound — and refuses everything else.
 */
export function canonicalUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID_SHAPE.test(value)
    ? value.toLowerCase()
    : null;
}

/** `@Transform` for an id field: the accepted spelling lowercased, anything else left for `@Matches(UUID_SHAPE)` to refuse. */
export function lowercaseUuid({ value }: { value: unknown }): unknown {
  return canonicalUuid(value) ?? value;
}
