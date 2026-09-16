import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  Matches,
} from 'class-validator';
import { BULK_SUBMIT_MAX_IDS } from '@tonyai/shared-types';
import { UUID_SHAPE } from '../../common/parse-uuid-param.pipe';

/**
 * Body of POST /api/v1/activity-records/bulk-submit.
 *
 * Ids, never a filter. A filter would be fewer round trips and would survive a
 * page refresh, but there is no batch id to filter on — the importer writes no
 * table — so the only expressible filter is "every draft in this period", which
 * also catches drafts someone typed by hand and meant to keep working on. And
 * `submit` applies its author gate only on a RESUBMISSION, so a draft is
 * submittable by any colleague who can see the subsidiary: a filter would let
 * one user sweep another's work-in-progress into review, unenumerated, in one
 * call. Ids keep the caller answerable for exactly what they sent.
 */
export class BulkSubmitActivityRecordsDto {
  /**
   * The shape check is `UUID_SHAPE`, the same pattern the route pipe uses, and
   * NOT class-validator's `@IsUUID`: that enforces the RFC 4122 variant nibble,
   * which the seed's own ids (`2222…`) fail. The job here is exactly "do not
   * hand Prisma something that raises P2023" — no wider and no narrower.
   *
   * `@ArrayNotEmpty` because an empty array must be a 400, not a silent
   * success reporting nothing: the one reading of `[]` nobody wants is "all".
   *
   * It stays HYPHENATED-ONLY, deliberately. `UUID_SHAPE` is case-insensitive,
   * so case is the only spelling variation that reaches the service — which
   * canonicalises it — while `{a0ee…}`, `urn:uuid:a0ee…` and the unhyphenated
   * form are all 400s here, though `canonicalUuid` would resolve every one of
   * them. That asymmetry with the IMPORT is the point: the import reads cells
   * a person typed into a spreadsheet, and this route reads ids the API
   * itself handed to its own client. Widening it would invent a caller that
   * does not exist, and every accepted spelling is one more thing the audit
   * trail has to be reconciled against.
   */
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(BULK_SUBMIT_MAX_IDS)
  @Matches(UUID_SHAPE, {
    each: true,
    message: 'recordIds must contain record ids',
  })
  recordIds!: string[];
}
