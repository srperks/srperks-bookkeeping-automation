import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPdfText } from '../src/pdftext.js';
import { classifyLines, DEFAULT_RULES } from '../src/classify.js';
import { makePdf } from './helpers.js';

test('reads visual lines top to bottom and detects a bill heading', async () => {
  const pdf = await makePdf([
    { text: 'Acme Foods Pty Ltd', y: 60, size: 16 },
    { text: 'ABN 12 345 678 901', y: 80 },
    { text: 'TAX INVOICE', y: 120, size: 22 },
    { text: 'Invoice No', x: 40, y: 160 },
    { text: 'INV-1042', x: 200, y: 160 },
  ], 1);
  const t = await readPdfText(pdf);
  assert.equal(t.pageCount, 2);
  assert.ok(t.hasText);
  assert.equal(t.page1Lines[0], 'Acme Foods Pty Ltd');
  assert.ok(t.page1Lines.includes('TAX INVOICE'));
  assert.ok(t.page1Lines.includes('Invoice No INV-1042'));
  assert.equal(classifyLines(t.page1Lines, DEFAULT_RULES), 'bill');
});

test('"Bill To" on a statement does not make it a bill', async () => {
  const pdf = await makePdf([
    { text: 'Acme Foods Pty Ltd', y: 60 },
    { text: 'STATEMENT', y: 100, size: 22 },
    { text: 'Bill To', x: 40, y: 140 },
    { text: 'Hopper Joint', x: 200, y: 140 },
    { text: 'Statement Date', x: 40, y: 160 },
    { text: '31/10/2026', x: 200, y: 160 },
  ]);
  const t = await readPdfText(pdf);
  assert.equal(classifyLines(t.page1Lines, DEFAULT_RULES), 'statement');
});

test('a PDF with no text layer reports hasText=false', async () => {
  const pdf = await makePdf([]);
  const t = await readPdfText(pdf);
  assert.equal(t.hasText, false);
});
