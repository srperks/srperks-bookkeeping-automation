import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDraftLines, expectedXeroTotals } from '../src/billmap.js';
import { validateBill } from '../src/validate.js';
import { billExtraction } from './helpers.js';

const tax = { withGst: 'INPUT', noGst: 'EXEMPTEXPENSES' };
const ctx = { today: '2026-10-28', allowedCurrencies: ['AUD'] };

test('lines carry per-line GST and Xero totals equal the printed totals', () => {
  const ex = billExtraction();
  const r = validateBill(ex, ctx).resolved!;
  const lines = buildDraftLines(ex.bill!, r, tax, '300');
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => [l.taxType, l.taxAmount, l.accountCode]), [['INPUT', 10, '300'], ['EXEMPTEXPENSES', 0, '300']]);
  assert.deepEqual(expectedXeroTotals(lines, false), { total: 160, gst: 10 });
});

test('a one-cent rounding difference in printed GST is absorbed so Xero matches the PDF exactly', () => {
  const ex = billExtraction();
  ex.bill!.lines = [
    { description: 'A', quantity: 1, unit_price: 10.04, line_amount: 10.04, gst_applicable: true },
    { description: 'B', quantity: 1, unit_price: 10.04, line_amount: 10.04, gst_applicable: true },
    { description: 'C', quantity: 1, unit_price: 10.04, line_amount: 10.04, gst_applicable: true },
  ];
  // per-line GST rounds to 1.00 each = 3.00, but the supplier printed GST on the sum: 30.12 * 10% = 3.01
  ex.bill!.subtotal_ex_gst = 30.12;
  ex.bill!.total_gst = 3.01;
  ex.bill!.total_inc_gst = 33.13;
  const v = validateBill(ex, ctx);
  assert.deepEqual(v.issues, []);
  const lines = buildDraftLines(ex.bill!, v.resolved!, tax);
  assert.deepEqual(expectedXeroTotals(lines, false), { total: 33.13, gst: 3.01 });
});

test('GST-inclusive bills keep inclusive amounts and tax per line', () => {
  const ex = billExtraction();
  ex.bill!.line_amounts_include_gst = true;
  ex.bill!.lines = [{ description: 'Service', quantity: 1, unit_price: 110, line_amount: 110, gst_applicable: true }];
  ex.bill!.subtotal_ex_gst = 100;
  ex.bill!.total_gst = 10;
  ex.bill!.total_inc_gst = 110;
  const v = validateBill(ex, ctx);
  assert.deepEqual(v.issues, []);
  const lines = buildDraftLines(ex.bill!, v.resolved!, tax);
  assert.equal(lines[0]!.taxAmount, 10);
  assert.deepEqual(expectedXeroTotals(lines, true), { total: 110, gst: 10 });
});

test('quantity and unit price are kept only when they reproduce the line amount', () => {
  const ex = billExtraction();
  ex.bill!.lines = [
    { description: 'Exact', quantity: 4, unit_price: 25, line_amount: 100, gst_applicable: false },
    { description: 'Discounted', quantity: 4, unit_price: 25, line_amount: 90, gst_applicable: false },
    { description: 'Fine decimals', quantity: 3, unit_price: 0.3333, line_amount: 1, gst_applicable: false },
  ];
  ex.bill!.subtotal_ex_gst = 191;
  ex.bill!.total_gst = 0;
  ex.bill!.total_inc_gst = 191;
  const v = validateBill(ex, ctx);
  assert.deepEqual(v.issues, []);
  const lines = buildDraftLines(ex.bill!, v.resolved!, tax);
  assert.deepEqual(lines.map((l) => [l.quantity, l.unitAmount, l.lineAmount]), [[4, 25, 100], [1, 90, 90], [1, 1, 1]]);
});

test('discount lines (negative amounts) flow through', () => {
  const ex = billExtraction();
  ex.bill!.lines = [
    { description: 'Goods', quantity: 1, unit_price: 200, line_amount: 200, gst_applicable: true },
    { description: 'Discount', quantity: null, unit_price: null, line_amount: -20, gst_applicable: true },
  ];
  ex.bill!.subtotal_ex_gst = 180;
  ex.bill!.total_gst = 18;
  ex.bill!.total_inc_gst = 198;
  const v = validateBill(ex, ctx);
  assert.deepEqual(v.issues, []);
  const lines = buildDraftLines(ex.bill!, v.resolved!, tax);
  assert.deepEqual(expectedXeroTotals(lines, false), { total: 198, gst: 18 });
});
