import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePrintedDate, isValidIsoDate, sanitiseFilePart, normaliseBusinessName, nameSimilarity, addDays, todayIso } from '../src/util.js';
import { properName } from '../src/util.js';
import { billFileName, statementFileName, withSuffix } from '../src/naming.js';

test('parsePrintedDate reads Australian day-first numeric dates', () => {
  assert.equal(parsePrintedDate('03/04/2026'), '2026-04-03');
  assert.equal(parsePrintedDate('3-4-26'), '2026-04-03');
  assert.equal(parsePrintedDate('31.10.2026'), '2026-10-31');
});

test('parsePrintedDate reads written months and ordinals', () => {
  assert.equal(parsePrintedDate('28 Oct 2026'), '2026-10-28');
  assert.equal(parsePrintedDate('28th October 2026'), '2026-10-28');
  assert.equal(parsePrintedDate('Wed 28 Oct 2026'), '2026-10-28');
  assert.equal(parsePrintedDate('October 28, 2026'), '2026-10-28');
  assert.equal(parsePrintedDate('2026-10-28'), '2026-10-28');
});

test('parsePrintedDate returns null when it cannot be sure', () => {
  assert.equal(parsePrintedDate('10/28/2026'), null); // US order, month 28 invalid
  assert.equal(parsePrintedDate('31/02/2026'), null);
  assert.equal(parsePrintedDate('soon'), null);
  assert.equal(parsePrintedDate(null), null);
});

test('isValidIsoDate and addDays', () => {
  assert.ok(isValidIsoDate('2026-02-28'));
  assert.ok(!isValidIsoDate('2026-02-30'));
  assert.equal(addDays('2026-10-25', 14), '2026-11-08');
  assert.match(todayIso(new Date('2026-10-28T20:00:00Z')), /^2026-10-2[89]$/);
});

test('sanitiseFilePart removes characters SharePoint rejects', () => {
  assert.equal(sanitiseFilePart('INV/2026:001*?'), 'INV-2026001');
  assert.equal(sanitiseFilePart('  Smith & Sons "Bakery" Pty. Ltd.  '), 'Smith Sons Bakery Pty. Ltd');
  assert.equal(sanitiseFilePart('A'.repeat(200), 50).length, 50);
});

test('name normalisation ignores legal suffixes and punctuation', () => {
  assert.equal(normaliseBusinessName('ACME Foods Pty. Ltd.'), normaliseBusinessName('Acme Foods'));
  assert.ok(nameSimilarity('Bunnings Warehouse', 'Bunnings') >= 0.8);
  assert.ok(nameSimilarity('Acme Foods', 'Zenith Plumbing') < 0.2);
});

test('file names follow the agreed formats', () => {
  assert.equal(billFileName('2026-10-12', 'Acme Foods Pty Ltd', 'INV-1042'), '12 10 2026 - Acme Foods Pty Ltd - INV-1042.pdf');
  assert.equal(statementFileName('Acme Foods Pty Ltd', '2026-10-31'), 'Acme Foods Pty Ltd - 2026 10 31.pdf');
  assert.equal(withSuffix('a - b.pdf', 2), 'a - b (2).pdf');
  assert.equal(billFileName('2026-10-12', 'Acme', 'INV/9'), '12 10 2026 - Acme - INV-9.pdf');
});

test('supplier names are shown in proper case', () => {
  assert.equal(properName('Flick Anticimex PTY LTD'), 'Flick Anticimex Pty Ltd');
  assert.equal(properName('FLICK ANTICIMEX PTY LTD'), 'Flick Anticimex Pty Ltd');
  assert.equal(properName('NATOORA AUSTRALIA PTY. LTD.'), 'Natoora Australia Pty. Ltd.');
  assert.equal(properName('Gamekeepers of Australia Pty Ltd'), 'Gamekeepers of Australia Pty Ltd');
  assert.equal(properName('IGA PLUS LIQUOR PTY LTD'), 'IGA Plus Liquor Pty Ltd');
  assert.equal(properName("O'BRIEN & SONS PTY LTD"), "O'Brien & Sons Pty Ltd");
  assert.equal(properName('Cookers Bulk Oil System Pty Ltd'), 'Cookers Bulk Oil System Pty Ltd');
  assert.equal(properName('McDonald Bros PTY LTD'), 'McDonald Bros Pty Ltd');
});
