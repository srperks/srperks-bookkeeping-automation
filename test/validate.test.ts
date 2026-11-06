import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateBill, validateStatement, compareBillPasses, compareStatementPasses } from '../src/validate.js';
import { billExtraction, statementExtraction } from './helpers.js';

const ctx = { today: '2026-10-28', allowedCurrencies: ['AUD'] };

test('a consistent bill validates and resolves', () => {
  const r = validateBill(billExtraction(), ctx);
  assert.deepEqual(r.issues, []);
  assert.equal(r.resolved?.issueDate, '2026-10-12');
  assert.equal(r.resolved?.dueDate, '2026-10-26');
  assert.equal(r.resolved?.totalIncGst, 160);
});

test('totals that do not add up are caught', () => {
  const ex = billExtraction();
  ex.bill!.total_inc_gst = 165;
  const r = validateBill(ex, ctx);
  assert.ok(r.issues.some((i) => i.includes('do not equal the printed total')));
  assert.equal(r.resolved, null);
});

test('GST that does not match the GST-applicable lines is caught', () => {
  const ex = billExtraction();
  ex.bill!.lines[1]!.gst_applicable = true; // now 10% of 150 = 15, but printed GST is 10
  const r = validateBill(ex, ctx);
  assert.ok(r.issues.some((i) => i.includes('GST')));
});

test('GST-inclusive lines are handled', () => {
  const ex = billExtraction();
  ex.bill!.line_amounts_include_gst = true;
  ex.bill!.lines = [
    { description: 'Service', quantity: 1, unit_price: 110, line_amount: 110, gst_applicable: true },
    { description: 'Fee', quantity: 1, unit_price: 50, line_amount: 50, gst_applicable: false },
  ];
  ex.bill!.total_inc_gst = 160;
  ex.bill!.total_gst = 10;
  ex.bill!.subtotal_ex_gst = 150;
  const r = validateBill(ex, ctx);
  assert.deepEqual(r.issues, []);
  assert.equal(r.resolved?.subtotalExGst, 150);
});

test('day/month swaps between printed and ISO date are caught', () => {
  const ex = billExtraction();
  ex.bill!.issue_date_printed = '03/04/2026';
  ex.bill!.issue_date_iso = '2026-03-04'; // read as US order
  const r = validateBill(ex, ctx);
  assert.ok(r.issues.some((i) => i.includes('Issue date mismatch')));
});

test('future issue date, due before issue, wrong currency, negative total', () => {
  let ex = billExtraction();
  ex.bill!.issue_date_iso = '2026-12-01';
  ex.bill!.issue_date_printed = '01/12/2026';
  assert.ok(validateBill(ex, ctx).issues.some((i) => i.includes('future')));

  ex = billExtraction();
  ex.bill!.due_date_iso = '2026-10-01';
  ex.bill!.due_date_printed = '01/10/2026';
  assert.ok(validateBill(ex, ctx).issues.some((i) => i.includes('before the issue date')));

  ex = billExtraction();
  ex.bill!.currency = 'USD';
  assert.ok(validateBill(ex, ctx).issues.some((i) => i.includes('Currency')));

  ex = billExtraction();
  ex.bill!.total_inc_gst = -160;
  assert.ok(validateBill(ex, ctx).issues.some((i) => i.includes('negative') || i.includes('zero')));
});

test('due date derived from terms or due on receipt', () => {
  let ex = billExtraction();
  ex.bill!.due_date_iso = null;
  ex.bill!.due_date_printed = null;
  ex.bill!.payment_terms_days = 14;
  assert.equal(validateBill(ex, ctx).resolved?.dueDate, '2026-10-26');

  ex = billExtraction();
  ex.bill!.due_date_iso = null;
  ex.bill!.due_on_receipt = true;
  assert.equal(validateBill(ex, ctx).resolved?.dueDate, '2026-10-12');
});

test('missing supplier or bill number is flagged', () => {
  const ex = billExtraction({ supplier_name: null });
  ex.bill!.bill_number = null;
  const r = validateBill(ex, ctx);
  assert.ok(r.issues.some((i) => i.includes('Supplier name')));
  assert.ok(r.issues.some((i) => i.includes('bill number')));
});

test('statement validation', () => {
  assert.equal(validateStatement(statementExtraction(), ctx).asAt, '2026-10-31');
  const bad = statementExtraction();
  bad.statement!.statement_date_iso = null;
  assert.ok(validateStatement(bad, ctx).issues.length > 0);
});

test('two passes that agree produce no differences; disagreement is listed', () => {
  assert.deepEqual(compareBillPasses(billExtraction(), billExtraction()), []);
  const other = billExtraction();
  other.bill!.total_inc_gst = 161;
  other.bill!.bill_number = 'INV-1043';
  const diffs = compareBillPasses(billExtraction(), other);
  assert.ok(diffs.some((d) => d.startsWith('total')));
  assert.ok(diffs.some((d) => d.startsWith('bill number')));
  // legal-suffix and case differences in supplier name are not disagreement
  assert.deepEqual(compareBillPasses(billExtraction(), billExtraction({ supplier_name: 'ACME FOODS PTY. LTD.' })), []);
  assert.deepEqual(compareStatementPasses(statementExtraction(), statementExtraction()), []);
});
