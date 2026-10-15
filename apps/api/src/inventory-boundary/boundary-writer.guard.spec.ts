import { BadRequestException, ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { errorCodeOf } from '../common/api-error';
import { makeDataEntry, makeSuperAdmin } from '../../test/helpers';
import { BoundaryWriterGuard, DeclarationSizeGuard } from './boundary-writer.guard';
import { INVENTORY_DECLARATION_LIMITS } from './dto/inventory-boundary.dto';

/**
 * The boundary's writes are refused before their body is transformed and
 * validated (`security-rls` P1): that work grows with a body's rows, the
 * declaration PUT reads up to 1 MB, and the service's own role check runs only
 * after the global pipe — so a reader's 1 MB of `{}` rows stalled the API for
 * seconds and answered 76 MB of messages.
 */

const context = (request: Record<string, unknown>) =>
  ({ switchToHttp: () => ({ getRequest: () => request }) }) as unknown as ExecutionContext;

describe('BoundaryWriterGuard', () => {
  it.each([
    ['consultant', makeSuperAdmin({ role: 'consultant' })],
    ['executive_viewer', makeSuperAdmin({ role: 'executive_viewer' })],
    ['data_entry', makeDataEntry()],
    ['a super_admin with no organisation', makeSuperAdmin({ organisationId: null })],
    ['no one', undefined],
  ])('refuses %s with forbidden — whatever the body', (_who, user) => {
    const failure = (() => {
      try {
        new BoundaryWriterGuard().canActivate(context({ user, body: { sources: Array(100_000).fill({}) } }));
      } catch (e) {
        return e;
      }
      return null;
    })();
    // The filter answers it `forbidden`, as it does the service's own refusal.
    expect(failure).toBeInstanceOf(ForbiddenException);
    expect((failure as ForbiddenException).message).toMatch(/^(Only super_admin may change an inventory boundary|No organisation context for this user)$/);
  });

  it("lets a super_admin of an organisation through", () => {
    expect(new BoundaryWriterGuard().canActivate(context({ user: makeSuperAdmin() }))).toBe(true);
  });
});

describe('DeclarationSizeGuard', () => {
  const guard = new DeclarationSizeGuard();
  const lists = Object.keys(INVENTORY_DECLARATION_LIMITS) as Array<keyof typeof INVENTORY_DECLARATION_LIMITS>;

  it.each(lists)('refuses %s past its limit with validation_failed, one short message — before a row is read', (list) => {
    const max = INVENTORY_DECLARATION_LIMITS[list];
    let failure: unknown;
    try {
      guard.canActivate(context({ body: { [list]: Array(max + 1).fill({}) } }));
    } catch (e) {
      failure = e;
    }
    expect(failure).toBeInstanceOf(BadRequestException);
    expect(errorCodeOf(failure)).toBe('validation_failed');
    expect((failure as BadRequestException).getResponse()).toMatchObject({
      message: [`${list} must contain no more than ${max} elements`],
    });
  });

  it('passes every list at its limit, and anything that is not a list of rows on to the pipe', () => {
    const atLimit = Object.fromEntries(lists.map((l) => [l, Array(INVENTORY_DECLARATION_LIMITS[l]).fill({})]));
    expect(guard.canActivate(context({ body: atLimit }))).toBe(true);
    for (const body of [undefined, null, 'x', [], { sources: 'not a list' }, { sources: {} }]) {
      expect(guard.canActivate(context({ body }))).toBe(true);
    }
  });
});
