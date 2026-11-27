/**
 * The tool's proposal for an account first seen (inc28-fuel-bulk C4,
 * fuel-account-mapping "The tool proposes a company and a person confirms
 * it"): a company is proposed only when exactly one candidate's name, compared
 * without regard to case or Turkish characters, equals the account's name,
 * contains it, or is contained in it. Anything else proposes nothing. A
 * proposal changes nothing until a person confirms it.
 */

/** Case, Turkish characters and runs of spaces folded away: `ENERYA  KONYA` and `Enerya Konya` read alike. */
export function foldCompanyName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ı/g, 'i')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ProposalCandidate {
  id: string;
  /** A company's legal and trading names: either may match, and the company counts once. */
  names: readonly string[];
}

/** The one company whose name matches the account's, or null (none, or more than one). */
export function proposeCompany(accountName: string, candidates: readonly ProposalCandidate[]): string | null {
  const account = foldCompanyName(accountName);
  if (account.length === 0) return null;
  const matches = candidates.filter((candidate) =>
    candidate.names.some((name) => {
      const company = foldCompanyName(name);
      return company.length > 0 && (company === account || company.includes(account) || account.includes(company));
    }),
  );
  return matches.length === 1 ? matches[0]!.id : null;
}
