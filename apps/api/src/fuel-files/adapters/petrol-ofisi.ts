import { FUEL_UPLOAD_MAX_ROWS, documentInvoiceRef } from '@tonyai/shared-types';
import { localDateTimeText, readCode, readDateTime, readQuantity, readText } from './cells';
import { keyHashOf, type FuelAdapter } from './adapter';

/**
 * A Petrol Ofisi `SatisListesi` (INC-2.8 §1, §5): one file, `Satış ID` unique,
 * `Fatura Numarası` on every row. The period is `Tarih`; `Dönem` is never
 * read — it is a code that looks like a date (§0).
 */
export const PETROL_OFISI_HEADERS = {
  saleId: 'Satış ID',
  accountCode: 'Filo Kod Adı',
  accountName: 'Filo',
  at: 'Tarih',
  product: 'Tip',
  litres: 'Miktar',
  invoice: 'Fatura Numarası',
} as const;

export const petrolOfisiAdapter: FuelAdapter = {
  source: 'petrol_ofisi',
  headers: Object.values(PETROL_OFISI_HEADERS),
  maxRows: FUEL_UPLOAD_MAX_ROWS,
  read(cells, fileRow) {
    const saleId = readCode(cells.get(PETROL_OFISI_HEADERS.saleId));
    if (saleId === null) return { refused: 'fuel_key_missing' };
    const accountCode = readCode(cells.get(PETROL_OFISI_HEADERS.accountCode));
    const accountName = readText(cells.get(PETROL_OFISI_HEADERS.accountName));
    const rawFuel = readText(cells.get(PETROL_OFISI_HEADERS.product));
    const atCell = cells.get(PETROL_OFISI_HEADERS.at);
    const litresCell = cells.get(PETROL_OFISI_HEADERS.litres);
    if (accountCode === null || accountName === null || rawFuel === null || !atCell || !litresCell) {
      return { refused: 'fuel_cell_missing' };
    }
    const invoice = documentInvoiceRef(readCode(cells.get(PETROL_OFISI_HEADERS.invoice)));
    if ('refused' in invoice) {
      return { refused: invoice.refused === 'empty' ? 'fuel_cell_missing' : 'fuel_reference_too_long' };
    }
    const litres = readQuantity(litresCell);
    if (litres === null) return { refused: 'fuel_quantity_unreadable' };
    const at = readDateTime(atCell);
    if (at === null) return { refused: 'fuel_date_unreadable' };
    return {
      row: {
        fileRow,
        accountCode,
        accountName,
        rawFuel,
        litres,
        transactionAt: localDateTimeText(at),
        year: at.year,
        month: at.month,
        invoiceRef: invoice.ref,
        keyHash: keyHashOf('petrol_ofisi', [saleId]),
      },
    };
  },
};
