import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import {
  ENCRYPTED_FIXTURE,
  FIXTURE_PRODUCER,
  FIXTURE_TITLE,
  buildInvoiceFixtures,
  dumanInvoices,
  sharedInvoice,
  trNumber,
} from './generate';

/**
 * inc29-evidence-assistant task 2.2: the synthetic invoice PDFs (design D11) are
 * the generator's output, byte for byte, every run, and each says it is a test
 * fixture. The encrypted fixture is random by nature: it is checked here by its
 * metadata and by the reader's outcome in `pdf-reader.service.spec.ts`.
 */

const digest = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const committed = () => readdirSync(__dirname).filter((n) => n.endsWith('.pdf')).sort();

describe('the synthetic invoice PDFs (D11)', () => {
  it('are deterministic: two builds write the same bytes', async () => {
    const [a, b] = [await buildInvoiceFixtures(), await buildInvoiceFixtures()];
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    for (const name of Object.keys(a)) expect(digest(a[name]!), name).toBe(digest(b[name]!));
  });

  it('are the files committed beside the script, and nothing else is', async () => {
    const built = await buildInvoiceFixtures();
    for (const [name, bytes] of Object.entries(built)) {
      expect(digest(readFileSync(join(__dirname, name))), `${name}: run generate.ts`).toBe(digest(bytes));
    }
    expect(committed()).toEqual([...Object.keys(built), ENCRYPTED_FIXTURE].sort());
  });

  it('each says it is a test fixture, the encrypted one included', async () => {
    for (const name of committed().filter((n) => n !== ENCRYPTED_FIXTURE)) {
      const doc = await PDFDocument.load(readFileSync(join(__dirname, name)), { updateMetadata: false });
      expect(doc.getProducer(), name).toBe(FIXTURE_PRODUCER);
      expect(doc.getTitle(), name).toBe(FIXTURE_TITLE);
      // No dates: the bytes would otherwise change at every run.
      expect(doc.getCreationDate(), name).toBeUndefined();
    }
    // pdf-lib writes the Info strings of an encrypted document in the clear
    // (`@cantoo/pdf-lib` 2.11.1), so a reader given the password decrypts them
    // into noise: the encrypted fixture's producer is read from its bytes.
    const raw = readFileSync(join(__dirname, ENCRYPTED_FIXTURE)).toString('latin1');
    expect(raw).toContain('/Encrypt ');
    const hex = /\/Producer <FEFF([0-9A-F]+)>/.exec(raw)?.[1] ?? '';
    expect(Buffer.from(hex, 'hex').swap16().toString('utf16le')).toBe(FIXTURE_PRODUCER);
  });

  it('agree with the fuel fixture and the documents', () => {
    // WP9's shared invoice: 312,80 L diesel and 456,21 L petrol, 769,01 L in all.
    const lines = sharedInvoice().lines.map((l) => Number(l.litres));
    expect(lines).toEqual([312.8, 456.21]);
    expect(Math.round((lines[0]! + lines[1]!) * 100)).toBe(76901);
    // 23 Duman invoices, one per half-month, INC-2.9 §5's example among them.
    const duman = dumanInvoices();
    expect(duman).toHaveLength(23);
    expect(new Set(duman.map((d) => d.period)).size).toBe(23);
    expect(duman.find((d) => d.period === '01.02.2025 - 15.02.2025')?.lines).toEqual([
      { product: 'Motorin Med', litres: '7502.66' },
    ]);
    expect(trNumber('7502.66')).toBe('7.502,66');
    expect(trNumber('1168.00')).toBe('1.168,00');
    expect(trNumber('31.86')).toBe('31,86');
  });
});
