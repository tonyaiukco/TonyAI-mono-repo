import { describe, expect, it } from 'vitest';
import { foldCompanyName, proposeCompany } from './propose';

const companies = [
  { id: 'enerya-konya', names: ['Enerya Konya Gaz Dağıtım A.Ş.', 'Enerya Konya'] },
  { id: 'logistics', names: ['TonyAI Lojistik A.Ş.'] },
  { id: 'insaat-1', names: ['Örnek İnşaat'] },
  { id: 'insaat-2', names: ['Örnek İnşaat Taahhüt'] },
];

describe('proposeCompany (C4)', () => {
  it('proposes the one company whose name equals the account name, whatever the case', () => {
    expect(proposeCompany('ENERYA KONYA', companies)).toBe('enerya-konya');
  });

  it('proposes a company whose name contains the account name, or is contained in it', () => {
    expect(proposeCompany('LOJİSTİK', companies)).toBe('logistics');
    expect(proposeCompany('Enerya Konya Filo 3', companies)).toBe('enerya-konya');
  });

  it('proposes nothing when two companies match', () => {
    expect(proposeCompany('ÖRNEK İNŞAAT', companies)).toBeNull();
    expect(proposeCompany('İnşaat', companies)).toBeNull();
  });

  it('proposes nothing when no company matches, or the name is empty', () => {
    expect(proposeCompany('Başka Firma', companies)).toBeNull();
    expect(proposeCompany('   ', companies)).toBeNull();
    expect(proposeCompany('Enerya', [])).toBeNull();
  });

  it('folds Turkish characters both ways: dotted and dotless i, ş, ğ, ü, ö, ç', () => {
    expect(foldCompanyName('İŞÇİ ĞÜÖ ıI')).toBe(foldCompanyName('isci guo ii'));
    expect(proposeCompany('TONYAI LOJISTIK A.S.', companies)).toBe('logistics');
    // Equal to one name and containing another is still two matches.
    expect(proposeCompany('ornek insaat taahhut', companies)).toBeNull();
  });

  it('counts a company once when both its legal and trading names match', () => {
    expect(proposeCompany('Enerya Konya', companies)).toBe('enerya-konya');
  });

  it('never matches on an empty company name', () => {
    expect(proposeCompany('Enerya Konya', [{ id: 'blank', names: [' '] }, ...companies.slice(0, 1)])).toBe('enerya-konya');
  });
});
