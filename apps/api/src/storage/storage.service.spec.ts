import { describe, expect, it } from 'vitest';
import { withDownloadName } from './storage.service';

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
