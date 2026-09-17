import { BadRequestException } from '@nestjs/common';

/**
 * A row names a reporting entity outside the caller's access set — or one
 * that does not exist; the two are one sentence on purpose, so the refusal is
 * not an existence oracle. The whole file is refused.
 *
 * With the role refusal, the one file-level refusal that is written to the
 * audit trail: it says something about the caller, where a malformed file
 * says something about the file.
 */
export class InaccessibleEntityError extends BadRequestException {
  constructor(message: string) {
    super(message);
  }
}
