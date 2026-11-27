import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandFolder, financialYear, monthOf, pickFolderName, pickMonthFolder } from '../src/folders.js';

test('financial year follows 1 July to 30 June, named by the year it ends', () => {
  assert.equal(financialYear('2026-07-01'), 2027);
  assert.equal(financialYear('2026-10-12'), 2027);
  assert.equal(financialYear('2027-06-30'), 2027);
  assert.equal(financialYear('2027-07-01'), 2028); // never the 2027 folder
  assert.equal(financialYear('2027-01-15'), 2027);
});

test('{FY} template expands per document date', () => {
  const t = 'A/{FY}/Bookkeeping/Accounts Payable';
  assert.equal(expandFolder(t, '2026-10-12'), 'A/2027/Bookkeeping/Accounts Payable');
  assert.equal(expandFolder(t, '2027-07-03'), 'A/2028/Bookkeeping/Accounts Payable');
  assert.equal(monthOf('2027-07-03'), 7);
});

const names = ['July', 'August', 'September', 'October', 'November', 'December', 'January', 'February', 'March', 'April', 'May', 'June'];

test('month folder: plain names, abbreviations, numbered and mixed styles', () => {
  assert.deepEqual(pickMonthFolder(names, 10, 'x'), { ok: true, name: 'October' });
  assert.deepEqual(pickMonthFolder(['2026 07 Jul', '2026 10 Oct', 'Archive'], 10, 'x'), { ok: true, name: '2026 10 Oct' });
  assert.deepEqual(pickMonthFolder(['Oct 2026', 'Nov 2026'], 11, 'x'), { ok: true, name: 'Nov 2026' });
  assert.deepEqual(pickMonthFolder(['04 October', '05 November'], 10, 'x'), { ok: true, name: '04 October' }); // word beats the number
  assert.deepEqual(pickMonthFolder(['07', '10', '11'], 10, 'x'), { ok: true, name: '10' });
  assert.deepEqual(pickMonthFolder(['Sept 2026'], 9, 'x'), { ok: true, name: 'Sept 2026' });
});

test('month folder: missing or ambiguous is never guessed', () => {
  const none = pickMonthFolder(['July', 'August'], 10, 'A/2027');
  assert.equal(none.ok, false);
  assert.match((none as { reason: string }).reason, /No october folder/);
  const two = pickMonthFolder(['October', 'October old'], 10, 'A/2027');
  assert.equal(two.ok, false);
  assert.match((two as { reason: string }).reason, /More than one/);
  assert.equal(pickMonthFolder([], 3, 'x').ok, false);
});

test('Outlook folder: exact name wins, a unique starting text works, ambiguity is not guessed', () => {
  const names = ['CHE001H1 - Hopper Joint PL', 'HAR001H1 - Harcourts Hospitality Ventures PL', 'PIE100RT - Pierr Cortes', 'SAI002C1 - Clintop SH PL', 'SAI002E1 - Evelyn Faye Nutrition'];
  assert.deepEqual(pickFolderName(names, 'CHE001H1 - Hopper Joint PL'), { ok: true, name: 'CHE001H1 - Hopper Joint PL' });
  assert.deepEqual(pickFolderName(names, 'har001h1'), { ok: true, name: 'HAR001H1 - Harcourts Hospitality Ventures PL' });
  assert.equal(pickFolderName(names, 'SAI002').ok, false);
  assert.equal(pickFolderName(names, 'Hopper Joint').ok, false); // must be the start, never a loose contains
  assert.equal(pickFolderName(['Inbox'], 'Hopper').ok, false);
});
