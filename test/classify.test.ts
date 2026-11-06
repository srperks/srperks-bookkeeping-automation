import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLines, classifyHeadingString, decideType, DEFAULT_RULES, buildRules } from '../src/classify.js';
import type { PdfText } from '../src/pdftext.js';
import { billExtraction, statementExtraction } from './helpers.js';

const R = DEFAULT_RULES;
const txt = (lines: string[]): PdfText => ({ pageCount: 1, page1Lines: lines, page1Text: lines.join('\n'), hasText: true });

test('headings in the brief are recognised', () => {
  for (const h of ['TAX INVOICE', 'Tax Invoice', 'Supplier Bill', 'Bill', 'Tax Invoice #1234', 'ORIGINAL TAX INVOICE', 'Bill No: 4471']) {
    assert.equal(classifyHeadingString(h, R), 'bill', h);
  }
  for (const h of ['Statement', 'STATEMENT', 'Client Statement', 'Debtor Statement', 'Statement of Account']) {
    assert.equal(classifyHeadingString(h, R), 'statement', h);
  }
});

test('labels and unrelated headings are not headings', () => {
  for (const h of ['Bill To', 'Bill Date', 'Bill Number', 'Statement Date', 'Invoice', 'Purchase Order', 'Remittance Advice', 'Credit Note', 'Tax Invoice Total', '']) {
    assert.equal(classifyHeadingString(h, R), 'none', h);
  }
});

test('combined heading is ambiguous, not guessed', () => {
  assert.equal(classifyLines(['Acme', 'TAX INVOICE', 'STATEMENT'], R), 'ambiguous');
});

test('only the top of the page counts', () => {
  const lines = ['Acme Foods', 'ABN 12 345', ...Array.from({ length: 40 }, (_, i) => `row ${i}`), 'Bill'];
  assert.equal(classifyLines(lines, R), 'none');
});

test('text layer and Claude agree -> accepted', () => {
  const d = decideType(txt(['Acme', 'TAX INVOICE', 'No 1042']), billExtraction(), R);
  assert.equal(d.kind, 'bill');
  const s = decideType(txt(['Acme', 'Statement', 'As at 31/10/2026']), statementExtraction(), R);
  assert.equal(s.kind, 'statement');
});

test('random PDF is left alone, not flagged', () => {
  const d = decideType(txt(['Purchase Order', 'PO 123']), billExtraction({ document_heading: 'Purchase Order', document_type: 'other', bill: null }), R);
  assert.equal(d.kind, 'other');
});

test('conflict between text layer and Claude goes to review', () => {
  const d = decideType(txt(['Acme', 'Statement']), billExtraction(), R);
  assert.equal(d.kind, 'review');
});

test('Claude says bill but nothing in the text confirms it -> review', () => {
  const d = decideType(txt(['Acme Foods', 'Order confirmation', 'Total 160.00 and some more words here']), billExtraction(), R);
  assert.equal(d.kind, 'review');
});

test('scanned PDF is accepted at high or medium confidence, never at low', () => {
  const scan: PdfText = { pageCount: 1, page1Lines: [], page1Text: '', hasText: false };
  assert.equal(decideType(scan, billExtraction({ confidence: 'high' }), R).kind, 'bill');
  assert.equal(decideType(scan, billExtraction({ confidence: 'medium' }), R).kind, 'bill');
  assert.equal(decideType(scan, billExtraction({ confidence: 'low' }), R).kind, 'review');
});

test('a scanned receipt is accepted as a bill only when "Receipt" is configured as a bill heading', () => {
  const scan: PdfText = { pageCount: 1, page1Lines: [], page1Text: '', hasText: false };
  const receipt = billExtraction({ document_heading: 'Receipt', confidence: 'medium' });
  assert.notEqual(decideType(scan, receipt, R).kind, 'bill');
  assert.equal(decideType(scan, receipt, buildRules(['receipt', 'tax receipt'])).kind, 'bill');
});

test('heading present in text but below the top lines still accepted when Claude is highly confident', () => {
  const lines = ['Acme', ...Array.from({ length: 35 }, (_, i) => `l${i}`), 'TAX INVOICE'];
  const d = decideType(txt(lines), billExtraction(), R);
  assert.equal(d.kind, 'bill');
});

test('extra headings from config extend, never replace, the defaults', () => {
  const rules = buildRules(['Invoice'], ['Customer Statement']);
  assert.equal(classifyHeadingString('Invoice', rules), 'bill');
  assert.equal(classifyHeadingString('Customer Statement', rules), 'statement');
  assert.equal(classifyHeadingString('Tax Invoice', rules), 'bill');
});

test('Claude copying a label such as "Tax Invoice No" is accepted when the text layer shows a real Tax Invoice heading', () => {
  const d = decideType(txt(['Cookers Bulk Oil System', 'TAX INVOICE', 'Tax Invoice No 10294539']), billExtraction({ document_heading: 'Tax Invoice No' }), R);
  assert.equal(d.kind, 'bill');
});

test('a label-only Claude heading is still rejected when the text layer shows no heading', () => {
  const d = decideType(txt(['Cookers Bulk Oil System', 'Some letter']), billExtraction({ document_heading: 'Tax Invoice No' }), R);
  assert.notEqual(d.kind, 'bill');
});

test('a label-only Claude heading is rejected when its type disagrees with the text layer', () => {
  const d = decideType(txt(['Acme', 'Statement']), billExtraction({ document_heading: 'Tax Invoice No' }), R);
  assert.equal(d.kind, 'review');
});
