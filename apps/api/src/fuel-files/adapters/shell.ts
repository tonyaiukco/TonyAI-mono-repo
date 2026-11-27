import { FUEL_UPLOAD_MAX_ROWS, shellInvoiceRef } from '@tonyai/shared-types';
import { canonicalQuantity, localDateTimeText, readCode, readDateTime, readQuantity, readText } from './cells';
import { keyHashOf, type FuelAdapter } from './adapter';

/**
 * A Shell fuel-card export (INC-2.8 §1, §5): one per company, sheet `items`,
 * no invoice number on a row — Duman invoices each account per half-month, so
 * a row's invoice is the half-month of its transaction date (C2). The key is
 * the card, the date-time to the second, the quantity and the station (B13).
 */
export const SHELL_HEADERS = {
  accountCode: 'Müşteri Kodu',
  accountName: 'Müşteri Adı',
  card: 'Kart No',
  at: 'İşlem Tarihi',
  station: 'İstasyon Kodu',
  product: 'Ürün',
  litres: 'Miktar (LT)',
} as const;

export const shellAdapter: FuelAdapter = {
  source: 'shell',
  sheetName: 'items',
  headers: Object.values(SHELL_HEADERS),
  maxRows: FUEL_UPLOAD_MAX_ROWS,
  quota: 'rows',
  read(cells, fileRow) {
    const card = readCode(cells.get(SHELL_HEADERS.card));
    const station = readCode(cells.get(SHELL_HEADERS.station));
    const atCell = cells.get(SHELL_HEADERS.at);
    const litresCell = cells.get(SHELL_HEADERS.litres);
    if (card === null || station === null || atCell === undefined || litresCell === undefined) {
      return { refused: 'fuel_key_missing' };
    }
    const accountCode = readCode(cells.get(SHELL_HEADERS.accountCode));
    const accountName = readText(cells.get(SHELL_HEADERS.accountName));
    const rawFuel = readText(cells.get(SHELL_HEADERS.product));
    if (accountCode === null || accountName === null || rawFuel === null) return { refused: 'fuel_cell_missing' };
    const litres = readQuantity(litresCell);
    if (litres === null) return { refused: 'fuel_quantity_unreadable' };
    const at = readDateTime(atCell);
    if (at === null) return { refused: 'fuel_date_unreadable' };
    const transactionAt = localDateTimeText(at);
    return {
      row: {
        fileRow,
        accountCode,
        accountName,
        rawFuel,
        litres,
        transactionAt,
        year: at.year,
        month: at.month,
        invoiceRef: shellInvoiceRef(at),
        keyHash: keyHashOf('shell', [card, transactionAt, canonicalQuantity(litres), station]),
      },
    };
  },
};
