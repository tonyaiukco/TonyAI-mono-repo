import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { SubsidiariesController } from './subsidiaries.controller';
import { SubsidiariesService } from './subsidiaries.service';
import { ParseUuidParamPipe } from '../common/parse-uuid-param.pipe';
import { makeSuperAdmin } from '../../test/helpers';

/**
 * There was no controller spec at all, and the whole of WP16 PR 2a is one new
 * route. Renaming it to `@Get('summary/:id')` passed 369 unit tests — E2E would
 * have caught it, but `playwright.config.ts` keeps E2E out of the turbo `test`
 * pipeline, so nothing in CI did.
 *
 * Route metadata rather than a Nest testing module: the goal is to pin the path,
 * the verb, the pipe and the delegation, none of which needs a container.
 */
function route(method: keyof SubsidiariesController) {
  const handler = SubsidiariesController.prototype[method];
  return {
    path: Reflect.getMetadata(PATH_METADATA, handler) as string,
    method: Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod,
  };
}

describe('SubsidiariesController — routes', () => {
  it.each([
    ['list', '/', RequestMethod.GET],
    ['get', ':id', RequestMethod.GET],
    ['summary', ':id/summary', RequestMethod.GET],
    ['create', '/', RequestMethod.POST],
    ['update', ':id', RequestMethod.PATCH],
    ['remove', ':id', RequestMethod.DELETE],
  ] as const)('%s is %s', (method, path, verb) => {
    expect(route(method)).toEqual({ path, method: verb });
  });

  it('summary is a sub-resource of the id, not a sibling literal', () => {
    // `:id` matches ONE path segment and will not cross a `/`, so declaration
    // order is irrelevant here — but a literal like `@Get('summary')` WOULD
    // have to precede `:id`. Pinned because the difference is invisible until
    // someone adds the literal.
    expect(route('summary').path.startsWith(':id/')).toBe(true);
  });

  it('every id-bearing route validates the uuid before the service sees it', () => {
    // Otherwise a malformed id reaches Prisma and surfaces as a 500 (PR #45).
    for (const method of ['get', 'summary', 'update', 'remove'] as const) {
      const pipes = Reflect.getMetadata(
        '__routeArguments__',
        SubsidiariesController,
        method,
      ) as Record<string, { pipes: unknown[] }>;
      const paramPipes = Object.values(pipes).flatMap((a) => a.pipes ?? []);
      expect(
        paramPipes.includes(ParseUuidParamPipe),
        `${method} is missing ParseUuidParamPipe`,
      ).toBe(true);
    }
  });

  it('delegates to the service with the caller and the id, unchanged', () => {
    const service = {
      summary: vi.fn().mockResolvedValue({ subsidiaryId: 'sub-1' }),
    } as unknown as SubsidiariesService;
    const controller = new SubsidiariesController(service);
    const user = makeSuperAdmin();

    void controller.summary(user, 'sub-1');

    expect(service.summary).toHaveBeenCalledWith(user, 'sub-1');
  });
});
