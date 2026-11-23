import { describe, expect, it, vi } from 'vitest';
import { StorageService, withDownloadName } from './storage.service';

describe('withDownloadName (pre-pilot defects)', () => {
  const signed = 'http://127.0.0.1:54321/storage/v1/object/sign/evidence/a/b.pdf?token=abc.def';

  it('encodes a Turkish file name once, so Storage answers a filename* the browser saves as written', () => {
    const url = new URL(withDownloadName(signed, 'Şubat-Faturası-İĞÜÖÇ.pdf'));
    expect(url.search).toContain('download=%C5%9Eubat-Faturas%C4%B1-%C4%B0%C4%9E%C3%9C%C3%96%C3%87.pdf');
    expect(url.search).not.toContain('%25');
    expect(url.searchParams.get('download')).toBe('Şubat-Faturası-İĞÜÖÇ.pdf');
  });

  it('keeps the signing token and the path as they were', () => {
    const url = new URL(withDownloadName(signed, 'a b.pdf'));
    expect(url.searchParams.get('token')).toBe('abc.def');
    expect(url.pathname).toBe('/storage/v1/object/sign/evidence/a/b.pdf');
    expect(url.searchParams.get('download')).toBe('a b.pdf');
  });
});

describe('StorageService.createSignedUrl (pre-pilot defects)', () => {
  const SIGNED = 'http://127.0.0.1:54321/storage/v1/object/sign/evidence/a/b.pdf?token=abc.def';

  function service() {
    process.env.SUPABASE_URL ??= 'http://127.0.0.1:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role';
    const createSignedUrl = vi.fn(async () => ({ data: { signedUrl: SIGNED }, error: null }));
    const svc = new StorageService();
    (svc as unknown as { client: unknown }).client = { storage: { from: () => ({ createSignedUrl }) } };
    return { svc, createSignedUrl };
  }

  it('never hands storage-js the download option, which it would encode twice', async () => {
    const { svc, createSignedUrl } = service();
    await svc.createSignedUrl('evidence', 'a/b.pdf', 60, 'Şubat-Faturası.pdf');
    expect(createSignedUrl).toHaveBeenCalledWith('a/b.pdf', 60);
  });

  it('adds the name once, to be saved as written', async () => {
    const { svc } = service();
    const url = new URL(await svc.createSignedUrl('evidence', 'a/b.pdf', 60, 'Şubat-Faturası.pdf'));
    expect(url.searchParams.getAll('download')).toEqual(['Şubat-Faturası.pdf']);
    expect(url.search).not.toContain('%25');
    expect(url.searchParams.get('token')).toBe('abc.def');
  });

  it('adds no download parameter without a name', async () => {
    const { svc } = service();
    expect(await svc.createSignedUrl('evidence', 'a/b.pdf', 60)).toBe(SIGNED);
  });
});
