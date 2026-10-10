import { Injectable, type PipeTransform } from '@nestjs/common';
import { ParseUuidParamPipe } from '../common/parse-uuid-param.pipe';

/**
 * A path id in the one spelling the database stores: the 8-4-4-4-12 shape
 * (`ParseUuidParamPipe`, `invalid_id` otherwise), lowercased. Postgres matches
 * a uuid in either case, but the service compares ids as strings — "is this
 * the actor's own account?" — and writes them into audit rows and Auth calls,
 * so an uppercase spelling of one's own id must not pass for someone else's
 * (`security-rls`, LP4-01 PR B review).
 */
@Injectable()
export class CanonicalIdPipe implements PipeTransform<string, string> {
  private readonly shape = new ParseUuidParamPipe();

  transform(value: string): string {
    return this.shape.transform(value).toLowerCase();
  }
}
