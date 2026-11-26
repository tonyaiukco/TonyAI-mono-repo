/**
 * Litres travel as decimal text (`FuelRowCountDTO`): a sum of 45,000 rows is
 * never a float. These add plain non-negative decimals exactly, with BigInt.
 */

const PLAIN = /^(\d+)(?:\.(\d+))?$/;

function parts(value: string): { integer: string; fraction: string } {
  const match = PLAIN.exec(value);
  if (!match) throw new Error(`not a plain decimal: ${value}`);
  return { integer: match[1]!, fraction: match[2] ?? '' };
}

/** The exact sum, with as many decimals as the most precise term (`'0'` for none). */
export function sumDecimals(values: Iterable<string>): string {
  const terms = [...values].map(parts);
  if (terms.length === 0) return '0';
  const scale = Math.max(...terms.map((t) => t.fraction.length));
  let total = 0n;
  for (const t of terms) total += BigInt(t.integer + t.fraction.padEnd(scale, '0'));
  const digits = total.toString().padStart(scale + 1, '0');
  return scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

/** Rows and litres of a group, as the DTOs count them. */
export class LitreTally {
  rows = 0;
  private readonly litres: string[] = [];

  add(litres: string): void {
    this.rows += 1;
    this.litres.push(litres);
  }

  get total(): string {
    return sumDecimals(this.litres);
  }

  toDTO(): { rows: number; litres: string } {
    return { rows: this.rows, litres: this.total };
  }
}
