import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsOptional, Matches, ValidateIf } from 'class-validator';
import { EVIDENCE_MAX_LINKED_RECORDS } from '@tonyai/shared-types';
import { ID_SHAPE_MESSAGE, UUID_SHAPE } from '../../common/parse-uuid-param.pipe';

/**
 * The multipart field beside the file in `POST /evidence`: the records the
 * file backs, as a JSON array of ids (`recordIds=["…","…"]`).
 *
 * JSON rather than a repeated field, because multer hands a repeated field
 * over as an array but a single one as a bare string — two shapes for one
 * meaning. So the field must be ONE string: a repeated field (which multer
 * delivers as an array) is refused rather than accepted as a second shape
 * that works for exactly two ids under the route's field limit. The string is
 * parsed; anything that is not a JSON array of id strings is refused by the
 * validators — nothing is coerced. Same id rule as the bulk submit
 * (`UUID_SHAPE`, hyphenated, either case — the service lowercases), because
 * these are ids the API handed to its own client.
 */
export class UploadEvidenceForRecordsDto {
  @Transform(({ value }) => {
    if (typeof value !== 'string') return null;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  })
  // Absent only when the file is for a fuel batch (inc28-fuel-bulk D11).
  @ValidateIf((dto: UploadEvidenceForRecordsDto) => dto.fuelBatchId === undefined || dto.recordIds !== undefined)
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(EVIDENCE_MAX_LINKED_RECORDS)
  @Matches(UUID_SHAPE, { each: true, message: ID_SHAPE_MESSAGE })
  recordIds?: string[];

  /** `fuelBatchId` in place of `recordIds`: the file backs every live record of that batch (D11). */
  @IsOptional()
  @Matches(UUID_SHAPE, { message: ID_SHAPE_MESSAGE })
  fuelBatchId?: string;
}
