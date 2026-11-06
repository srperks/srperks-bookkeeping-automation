import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRow, classifyHeader, planColumns, rowExists, type BillsRowData } from '../src/billslist.js';

const data: BillsRowData = { supplier: 'Acme Foods Pty Ltd', billNumber: 'INV-1042', issueDate: '2026-10-12', dueDate: '2026-10-26', exGst: 150, gst: 10, total: 160, fileName: 'f.pdf', notes: '' };

test('header classification', () => {
  const cases: Array<[string, string | null]> = [
    ['Supplier', 'supplier'], ['Supplier Name', 'supplier'], ['Vendor', 'supplier'],
    ['Invoice Number', 'billNumber'], ['Invoice No.', 'billNumber'], ['Bill #', 'billNumber'], ['Tax Invoice Number', 'billNumber'], ['Supplier Bill Number', 'billNumber'],
    ['Invoice Date', 'issueDate'], ['Date', 'issueDate'], ['Bill Date', 'issueDate'],
    ['Due Date', 'dueDate'], ['Amount Due', null], ['Date Paid', null], ['Date Received', null],
    ['Amount ex GST', 'exGst'], ['Net', 'exGst'], ['GST', 'gst'], ['Total', 'total'], ['Total inc GST', 'total'], ['Amount', 'total'],
    ['File', 'fileName'], ['Notes', 'notes'], ['Month', null], ['Description', null],
  ];
  for (const [h, want] of cases) assert.equal(classifyHeader(h), want, h);
});

test('columns are matched by header, any order; unknown columns stay blank', () => {
  const plan = planColumns(['Month', 'Supplier', 'Invoice No', 'Invoice Date', 'Due Date', 'Amount ex GST', 'GST', 'Total inc GST', 'Paid?']);
  assert.ok(plan.ok);
  if (!plan.ok) return;
  assert.deepEqual(buildRow(plan, data), [null, 'Acme Foods Pty Ltd', 'INV-1042', '2026-10-12', '2026-10-26', 150, 10, 160, null]);
});

test('a missing required column stops the write with a clear reason', () => {
  const plan = planColumns(['Supplier', 'Invoice Date', 'GST']);
  assert.equal(plan.ok, false);
  assert.match((plan as { reason: string }).reason, /missing Total, Bill\/Invoice number or File name/);
});

test('a second column of the same kind stays blank', () => {
  const plan = planColumns(['Supplier', 'Invoice Number', 'Invoice Date', 'Total', 'Amount']);
  assert.ok(plan.ok);
  if (plan.ok) assert.deepEqual(plan.columns, ['supplier', 'billNumber', 'issueDate', 'total', null]);
});

test('duplicate detection ignores case, punctuation and number formatting', () => {
  const plan = planColumns(['Supplier', 'Invoice Number', 'Invoice Date', 'Total']);
  assert.ok(plan.ok);
  if (!plan.ok) return;
  assert.equal(rowExists(plan, [['ACME FOODS PTY LTD', 'inv 1042', '', 160]], data), true);
  assert.equal(rowExists(plan, [['Acme Foods Pty Ltd', 'INV-1043', '', 160]], data), false);
  assert.equal(rowExists(plan, [['Other Supplier', 'INV-1042', '', 160]], data), false);
});

test("SR Perks' real Bills List (no number column): matched by file name, unknown columns left alone", () => {
  const headers = ['File Name', 'Date', 'Year', 'Quarter', 'Vendor', 'Gross', 'GST', 'Net', 'Category'];
  const plan = planColumns(headers);
  assert.ok(plan.ok);
  if (!plan.ok) return;
  assert.deepEqual(buildRow(plan, data), ['f.pdf', '2026-10-12', null, null, 'Acme Foods Pty Ltd', 160, 10, 150, null]);
  assert.equal(rowExists(plan, [['f.pdf', '2026-10-12', null, null, 'Acme Foods Pty Ltd', 160, 10, 150, null]], data), true);
  assert.equal(rowExists(plan, [['g.pdf', '2026-10-12', null, null, 'Acme', 160, 10, 150, null]], data), false);
  assert.equal(rowExists(plan, [['F.PDF ', '', '', '', '', '', '', '', '']], { ...data, fileName: 'f' }), true); // extension and case do not matter
});
