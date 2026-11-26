import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({
  listInventoryBoundaries: vi.fn(),
  createInventoryBoundary: vi.fn(),
  putInventoryBoundarySubsidiary: vi.fn(),
}));
vi.mock('@/lib/api', () => ({ api: new Proxy({}, { get: (_t, k: string) => (calls as Record<string, unknown>)[k] ?? vi.fn() }) }));

import { boundaryCalls } from './use-boundary-calls';

describe('the wizard writes into the version on screen (owner review of WP8, P1)', () => {
  beforeEach(() => vi.clearAllMocks());
  it('a version id is written to as it is, never chosen again', async () => {
    const write = vi.spyOn(boundaryCalls, 'writeDeclaration').mockResolvedValue({ id: 'v1' } as never);
    const list = vi.spyOn(boundaryCalls, 'listYear');
    const openNew = vi.spyOn(boundaryCalls, 'openNew');
    await boundaryCalls.declare('v1', 2025, 'S', {} as never);
    expect(write).toHaveBeenCalledWith('v1', 'S', {});
    expect(list).not.toHaveBeenCalled();
    expect(openNew).not.toHaveBeenCalled();
  });
  it('no version on screen: the first save opens one', async () => {
    const write = vi.spyOn(boundaryCalls, 'writeDeclaration').mockResolvedValue({ id: 'v2' } as never);
    vi.spyOn(boundaryCalls, 'openNew').mockResolvedValue({ id: 'v2' } as never);
    await boundaryCalls.declare(null, 2025, 'S', {} as never);
    expect(write).toHaveBeenCalledWith('v2', 'S', {});
  });
});
