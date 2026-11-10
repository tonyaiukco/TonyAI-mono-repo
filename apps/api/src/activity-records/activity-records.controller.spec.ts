import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { ActivityRecordsController } from './activity-records.controller';
import { SUBMISSION_NOT_NAMED, type ActivityRecordsService } from './activity-records.service';
import type { RequestUser } from '../auth/auth.types';

/**
 * BUG-R2-03 owner review P1: over HTTP an approve or reject MUST name the
 * submission the reviewer saw. The controller hands an absent field to the
 * service as SUBMISSION_NOT_NAMED, which refuses it after the role check
 * (activity-records.service.spec.ts); a value — a time or null — goes as is.
 */
const user = { id: 'user-admin', role: 'super_admin' } as RequestUser;
const ID = 'a1111111-1111-4111-8111-111111111111';
const SEEN = '2026-11-10T09:00:00.000Z';

function build() {
  const service = { approve: vi.fn().mockResolvedValue({}), reject: vi.fn().mockResolvedValue({}) };
  return { service, controller: new ActivityRecordsController(service as unknown as ActivityRecordsService) };
}

describe('ActivityRecordsController — a review decision names the submission it saw', () => {
  it('passes an absent field on as "not named", never as "nothing to compare"', async () => {
    const { service, controller } = build();
    await controller.approve(user, ID);
    expect(service.approve).toHaveBeenLastCalledWith(user, ID, SUBMISSION_NOT_NAMED);
    await controller.approve(user, ID, {});
    expect(service.approve).toHaveBeenLastCalledWith(user, ID, SUBMISSION_NOT_NAMED);
    await controller.reject(user, ID, { varianceReason: 'x' } as never);
    expect(service.reject).toHaveBeenLastCalledWith(user, ID, 'x', SUBMISSION_NOT_NAMED);
  });

  it('passes the submission seen — a time or null — as is', async () => {
    const { service, controller } = build();
    await controller.approve(user, ID, { seenSubmittedAt: SEEN });
    expect(service.approve).toHaveBeenLastCalledWith(user, ID, SEEN);
    await controller.approve(user, ID, { seenSubmittedAt: null });
    expect(service.approve).toHaveBeenLastCalledWith(user, ID, null);
    await controller.reject(user, ID, { varianceReason: 'why', seenSubmittedAt: SEEN });
    expect(service.reject).toHaveBeenLastCalledWith(user, ID, 'why', SEEN);
  });
});
