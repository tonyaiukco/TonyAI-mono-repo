import { FUEL_TANKER_MAX_DELIVERIES, documentInvoiceRef } from '@tonyai/shared-types';
import { readCode, readQuantity, readText } from './cells';
import { dedupeDigest, type FuelAdapter } from './adapter';

/**
 * A tanker deliveries file (INC-2.8 §1, §5): one row per delivery, no fuel,
 * usage or date column — each is declared at upload (C3) — and a last row
 * `TOPLAM` with no `EVRAK NO`, refused as a row with an empty key so its
 * litres are never added to the deliveries'. The receiving company's text,
 * `AÇIKLAMA`, is the account (C5). Its money columns are never read.
 */
export const TANKER_HEADERS = {
  document: 'EVRAK NO',
  receiving: 'AÇIKLAMA',
  litres: 'MİKTAR',
} as const;

export const tankerAdapter: FuelAdapter = {
  source: 'tanker',
  headers: Object.values(TANKER_HEADERS),
  maxRows: FUEL_TANKER_MAX_DELIVERIES,
  read(cells, fileRow) {
    const document = documentInvoiceRef(readCode(cells.get(TANKER_HEADERS.document)));
    if ('refused' in document) {
      return { refused: document.refused === 'empty' ? 'fuel_key_missing' : 'fuel_reference_too_long' };
    }
    const receiving = readText(cells.get(TANKER_HEADERS.receiving));
    const litresCell = cells.get(TANKER_HEADERS.litres);
    if (receiving === null || litresCell === undefined) return { refused: 'fuel_cell_missing' };
    const litres = readQuantity(litresCell);
    if (litres === null) return { refused: 'fuel_quantity_unreadable' };
    return {
      row: {
        fileRow,
        accountCode: receiving,
        accountName: receiving,
        rawFuel: null,
        litres,
        transactionAt: null,
        year: null,
        month: null,
        invoiceRef: document.ref,
        dedupeDigest: dedupeDigest('tanker', [document.ref]),
      },
    };
  },
};
