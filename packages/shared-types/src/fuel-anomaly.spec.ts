import { describe, expect, it } from 'vitest';
import { judgeFuelBatch, type FuelBatchAnomalyInvoice, type FuelBatchAnomalyRecord } from './index';

/** inc28-fuel-bulk D12 (task 6.4): a fuel batch is checked per invoice and fuel. */

const record = (id: string, activityType: string, tCo2e: number | null, litres = 1000): FuelBatchAnomalyRecord => ({
  id,
  activityType,
  tCo2e,
  ceiling: { category: 'Mobile Combustion', activityType, activityValue: litres, activityUnit: 'litres' },
});
const invoice = (id: string, period: number, records: FuelBatchAnomalyRecord[], counted = true, invoiceRef = id): FuelBatchAnomalyInvoice => ({
  id, period, invoiceRef, counted, records,
});

describe('judgeFuelBatch', () => {
  const history = [
    invoice('feb-1', 20250201, [record('a', 'on_road_diesel', 10)]),
    invoice('feb-2', 20250216, [record('b', 'on_road_diesel', 10)]),
    invoice('mar-1', 20250301, [record('c', 'on_road_diesel', 10)]),
  ];

  it('compares a half-month invoice with the average of the three earlier invoices, not a month', () => {
    const current = invoice('mar-2', 20250316, [record('x', 'on_road_diesel', 10.5)]);
    expect(judgeFuelBatch(current, history).x).toEqual({ anomalous: false, priorCount: 3, baseline: 10 });
    const doubled = invoice('mar-2', 20250316, [record('x', 'on_road_diesel', 21)]);
    expect(judgeFuelBatch(doubled, history).x).toMatchObject({ anomalous: true, priorCount: 3 });
  });

  it('judges a posting-lag record with its invoice’s other record of that fuel, as one observation', () => {
    // 7,500 L in April's first half and 31.86 L dated 31 March: one diesel observation of 13.5 against an average of 13.33.
    const current = invoice('apr-1', 20250331, [record('apr', 'on_road_diesel', 13.4), record('mar', 'on_road_diesel', 0.1, 31.86)]);
    const verdicts = judgeFuelBatch(current, [...history, invoice('mar-2', 20250316, [record('d', 'on_road_diesel', 20)])]);
    expect(verdicts.apr).toEqual(verdicts.mar);
    expect(verdicts.mar).toMatchObject({ anomalous: false, priorCount: 3 });
  });

  it('judges each fuel against that fuel’s history only', () => {
    const current = invoice('mar-2', 20250316, [record('d1', 'on_road_diesel', 10), record('p1', 'on_road_petrol', 3)]);
    const verdicts = judgeFuelBatch(current, history);
    expect(verdicts.d1).toMatchObject({ priorCount: 3, anomalous: false });
    // No earlier invoice holds petrol: the record's first-period ceiling judges it.
    expect(verdicts.p1).toMatchObject({ priorCount: 0, baseline: null });
  });

  it('leaves out invoices that do not count, later ones and itself', () => {
    const current = invoice('mar-1', 20250301, [record('x', 'on_road_diesel', 10)]);
    const others = [
      invoice('jan-1', 20250101, [record('j', 'on_road_diesel', 10)], false),
      invoice('apr-1', 20250401, [record('k', 'on_road_diesel', 10)]),
      current,
    ];
    expect(judgeFuelBatch(current, others).x).toMatchObject({ priorCount: 0 });
  });

  it('judges a further batch of an invoice as an observation of its own', () => {
    const first = invoice('first', 20250301, [record('f', 'on_road_diesel', 10)], true, 'OZK-1');
    const further = invoice('further', 20250312, [record('g', 'on_road_diesel', 0.2)], true, 'OZK-1');
    expect(judgeFuelBatch(further, [first, ...history.slice(0, 2)]).g).toMatchObject({ anomalous: true, priorCount: 3 });
  });

  it('gives no verdict to a record with no figure', () => {
    const current = invoice('x', 20250316, [record('n', 'on_road_diesel', null)]);
    expect(judgeFuelBatch(current, history).n).toMatchObject({ anomalous: false, priorCount: null });
  });
});
