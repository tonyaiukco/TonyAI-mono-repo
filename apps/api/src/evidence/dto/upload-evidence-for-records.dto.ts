import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, Matches } from 'class-validator';
import { EVIDENCE_MAX_LINKED_RECORDS } from '@tonyai/shared-types';
import { ID_SHAPE_MESSAGE, UUID_SHAPE } from '../../common/parse-uuid-param.pipe';

/**
 * The multipart field beside the file in `POST /evidence`: the records the
 * file backs, as a JSON array of ids (`recordIds=["…","…"]`).
 *
 * JSON rather than a repeated field, because multer hands a repeated field
 * over as an array but a single one as a bare string — two shapes for one
 * meaning. The transform parses a string and leaves anything else alone, so a
 * value that is not a JSON array of strings falls through to the validators
 * and is refused; it never coerces. Same id rule as the bulk submit
 * (`UUID_SHAPE`, hyphenated, either case — the service lowercases), because
 * these are ids the API handed to its own client.
 */
export class UploadEvidenceForRecordsDto {
  @Transform(({ value }) => {
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(EVIDENCE_MAX_LINKED_RECORDS)
  @Matches(UUID_SHAPE, { each: true, message: ID_SHAPE_MESSAGE })
  recordIds!: string[];
}
