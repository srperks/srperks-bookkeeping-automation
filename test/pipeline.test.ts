import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pipeline, CAT, SystemicError } from '../src/pipeline.js';
import { DEFAULT_RULES } from '../src/classify.js';
import { silentLogger } from '../src/logger.js';
import { XeroError } from '../src/xero.js';
import { ClientSchema } from '../src/types.js';
import { clients, FakeAlerter, FakeExtractor, FakeGraph, FakeLedger, FakeXero, HARCOURTS_TENANT, HOPPER_TENANT } from './fakes.js';
import { billExtraction, makePdf, statementExtraction } from './helpers.js';

const HOPPER = 'accounts@hopperjointmelbourne.com.au';
const HARCOURTS = 'accounts@harcourtscafe.com.au';

async function billPdf(tag: string) {
  return makePdf([{ text: 'Acme Foods Pty Ltd', y: 60 }, { text: 'TAX INVOICE', y: 110, size: 22 }, { text: `Invoice No ${tag}`, y: 150 }, { text: 'Total 160.00', y: 200 }]);
}
async function statementPdf(tag: string) {
  return makePdf([{ text: 'Acme Foods Pty Ltd', y: 60 }, { text: 'STATEMENT', y: 110, size: 22 }, { text: `Account ${tag}`, y: 150 }, { text: 'Statement Date 31/10/2026', y: 180 }]);
}
async function randomPdf(tag: string) {
  return makePdf([{ text: 'Acme Foods Pty Ltd', y: 60 }, { text: 'Purchase Order', y: 110, size: 22 }, { text: `PO ${tag}`, y: 150 }]);
}

function setup(over: { dryRun?: boolean; passes?: number; fuzzy?: 'review' | 'create' } = {}) {
  const graph = new FakeGraph();
  const xero = new FakeXero();
  const extractor = new FakeExtractor();
  const alerter = new FakeAlerter();
  const ledger = new FakeLedger();
  const pipeline = new Pipeline({
    cfg: { dryRun: over.dryRun ?? false, passes: over.passes ?? 2, allowedCurrencies: ['AUD'], contactFuzzyPolicy: over.fuzzy ?? 'review', createMissingContacts: true, blockOnDmarcFail: true, clients },
    graph, xero, extractor, rules: DEFAULT_RULES, log: silentLogger, alerter, ledger,
    now: () => new Date('2026-10-28T10:00:00+11:00'),
  });
  return { graph, xero, extractor, alerter, ledger, pipeline };
}

test('bill from Hopper: saved with agreed name, Xero draft + PDF attached, email moved to Hopper folder', async () => {
  const t = setup();
  const pdf = await billPdf('INV-1042');
  t.extractor.on(pdf, billExtraction());
  const m = t.graph.addMessage('m1', HOPPER, [{ name: 'inv.pdf', buf: pdf }]);

  const out = await t.pipeline.processMessage(m);

  assert.equal(out.status, 'moved');
  assert.deepEqual(t.graph.filesIn('Hopper/Bills'), ['12 10 2026 - Acme Foods Pty Ltd - INV-1042.pdf']);
  assert.deepEqual(t.graph.filesIn('Harcourts/Bills'), []);
  assert.equal(t.graph.moved.get('m1'), 'folder:Inbox/Hopper Joint');
  assert.equal(t.xero.bills.length, 1);
  const bill = t.xero.bills[0]!;
  assert.equal(bill.tenant, HOPPER_TENANT);
  assert.equal(bill.status, 'DRAFT');
  assert.deepEqual(bill.attachments, ['12 10 2026 - Acme Foods Pty Ltd - INV-1042.pdf']);
  assert.equal(bill.input!.invoiceNumber, 'INV-1042');
  assert.equal(bill.input!.dueDate, '2026-10-26');
  assert.equal(bill.input!.lines[0]!.accountCode, '300');
  assert.equal(bill.input!.lines[0]!.taxType, 'INPUT');
  assert.equal(bill.input!.lines[1]!.taxType, 'EXEMPTEXPENSES');
  assert.equal(t.xero.contactsCreated.length, 1);
  assert.equal(t.ledger.rows.length, 1);
  assert.equal(t.alerter.alerts.length, 0);
});

test('Harcourts mail goes to Harcourts folders and Harcourts Xero org only', async () => {
  const t = setup();
  const pdf = await billPdf('H-77');
  const ex = billExtraction();
  ex.bill!.bill_number = 'H-77';
  t.extractor.on(pdf, ex);
  const m = t.graph.addMessage('m2', HARCOURTS, [{ name: 'bill.pdf', buf: pdf }]);

  await t.pipeline.processMessage(m);

  assert.deepEqual(t.graph.filesIn('Hopper/Bills'), []);
  assert.equal(t.graph.filesIn('Harcourts/Bills').length, 1);
  assert.equal(t.xero.bills[0]!.tenant, HARCOURTS_TENANT);
  assert.equal(t.graph.moved.get('m2'), 'folder:Inbox/Harcourts Cafe');
  assert.equal(t.xero.bills[0]!.input!.lines[0]!.accountCode, undefined);
});

test('statement: saved in statements folder with agreed name, no Xero draft, email moved', async () => {
  const t = setup();
  const pdf = await statementPdf('A1');
  t.extractor.on(pdf, statementExtraction());
  const m = t.graph.addMessage('m3', HOPPER, [{ name: 'stmt.pdf', buf: pdf }]);

  const out = await t.pipeline.processMessage(m);

  assert.equal(out.status, 'moved');
  assert.deepEqual(t.graph.filesIn('Hopper/Statements'), ['Acme Foods Pty Ltd - 2026 10 31.pdf']);
  assert.equal(t.xero.bills.length, 0);
  assert.equal(t.graph.moved.get('m3'), 'folder:Inbox/Hopper Joint');
});

test('random PDF is left in the inbox, nothing saved, no alert', async () => {
  const t = setup();
  const pdf = await randomPdf('9');
  t.extractor.on(pdf, billExtraction({ document_heading: 'Purchase Order', document_type: 'other', bill: null }));
  const m = t.graph.addMessage('m4', HOPPER, [{ name: 'po.pdf', buf: pdf }]);

  const out = await t.pipeline.processMessage(m);

  assert.equal(out.status, 'left_unrecognised');
  assert.equal(t.graph.moved.has('m4'), false);
  assert.deepEqual([...t.graph.files.keys()], []);
  assert.deepEqual(t.graph.categories.get('m4'), [CAT.left]);
  assert.equal(t.alerter.alerts.length, 0);
});

test('email with no PDF stays in the inbox', async () => {
  const t = setup();
  const m = t.graph.addMessage('m5', HOPPER, [{ name: 'photo.png', buf: Buffer.from('x'.repeat(200)) }]);
  const out = await t.pipeline.processMessage(m);
  assert.equal(out.status, 'left_no_pdf');
  assert.equal(t.graph.moved.has('m5'), false);
  assert.equal(t.extractor.total, 0);
});

test('unknown senders are ignored completely', async () => {
  const t = setup();
  const pdf = await billPdf('X');
  const m = t.graph.addMessage('m6', 'someone@else.com', [{ name: 'a.pdf', buf: pdf }]);
  const out = await t.pipeline.processMessage(m);
  assert.equal(out.status, 'ignored');
  assert.equal(t.graph.categories.has('m6'), false);
  assert.equal(t.extractor.total, 0);
});

test('two readings that disagree stop for review: nothing saved, nothing drafted, alert sent', async () => {
  const t = setup();
  const pdf = await billPdf('INV-5');
  t.extractor.on(pdf, (pass) => {
    const ex = billExtraction();
    if (pass === 1) { ex.bill!.total_inc_gst = 161; ex.bill!.lines[0]!.line_amount = 101; ex.bill!.subtotal_ex_gst = 151; }
    return ex;
  });
  const m = t.graph.addMessage('m7', HOPPER, [{ name: 'a.pdf', buf: pdf }]);

  const out = await t.pipeline.processMessage(m);

  assert.equal(out.status, 'review');
  assert.deepEqual([...t.graph.files.keys()], []);
  assert.equal(t.xero.bills.length, 0);
  assert.equal(t.graph.moved.has('m7'), false);
  assert.deepEqual(t.graph.categories.get('m7'), [CAT.review]);
  assert.equal(t.alerter.alerts.length, 1);
  assert.match(t.alerter.alerts[0]!.body, /disagree/);
});

test('totals that do not reconcile stop for review', async () => {
  const t = setup();
  const pdf = await billPdf('INV-6');
  const ex = billExtraction();
  ex.bill!.total_inc_gst = 175;
  t.extractor.on(pdf, ex);
  const m = t.graph.addMessage('m8', HOPPER, [{ name: 'a.pdf', buf: pdf }]);
  const out = await t.pipeline.processMessage(m);
  assert.equal(out.status, 'review');
  assert.deepEqual([...t.graph.files.keys()], []);
});

test('same bill forwarded twice: one draft, one file, second email flagged as a duplicate and left in the inbox', async () => {
  const t = setup();
  const pdf = await billPdf('INV-1042');
  t.extractor.on(pdf, billExtraction());
  await t.pipeline.processMessage(t.graph.addMessage('a', HOPPER, [{ name: 'x.pdf', buf: pdf }]));
  const out = await t.pipeline.processMessage(t.graph.addMessage('b', HOPPER, [{ name: 'x.pdf', buf: pdf }]));

  assert.equal(out.status, 'review');
  assert.equal(t.xero.bills.length, 1);
  assert.equal(t.graph.filesIn('Hopper/Bills').length, 1);
  assert.equal(t.graph.moved.has('b'), false);
  assert.match(t.alerter.alerts[0]!.body, /DUPLICATE BILL/);
});

test('same bill number but a different PDF is flagged, kept as "(2)", and no second draft is made', async () => {
  const t = setup();
  const pdf1 = await billPdf('INV-1042');
  const pdf2 = await makePdf([{ text: 'Acme Foods Pty Ltd', y: 60 }, { text: 'TAX INVOICE', y: 110, size: 22 }, { text: 'REVISED copy', y: 150 }]);
  t.extractor.on(pdf1, billExtraction());
  t.extractor.on(pdf2, billExtraction());
  await t.pipeline.processMessage(t.graph.addMessage('a', HOPPER, [{ name: 'x.pdf', buf: pdf1 }]));
  const out = await t.pipeline.processMessage(t.graph.addMessage('b', HOPPER, [{ name: 'y.pdf', buf: pdf2 }]));

  assert.equal(out.status, 'review');
  assert.equal(t.xero.bills.length, 1);
  assert.equal(t.graph.filesIn('Hopper/Bills').length, 2);
  assert.ok(t.graph.filesIn('Hopper/Bills').some((f) => f.endsWith('(2).pdf')));
  assert.equal(t.graph.moved.has('b'), false);
});

test('retry after a Xero outage completes without duplicating the SharePoint file', async () => {
  const t = setup();
  const pdf = await billPdf('INV-1042');
  t.extractor.on(pdf, billExtraction());
  const m = t.graph.addMessage('m9', HOPPER, [{ name: 'x.pdf', buf: pdf }]);
  t.xero.failCreateOnce = new XeroError('Xero is down', 503, true);

  await assert.rejects(() => t.pipeline.processMessage(m), /Xero is down/);
  assert.equal(t.graph.moved.has('m9'), false, 'email must stay in the inbox until everything succeeded');
  assert.equal(t.graph.filesIn('Hopper/Bills').length, 1);
  assert.equal(t.xero.bills.length, 0);

  const out = await t.pipeline.processMessage(m);
  assert.equal(out.status, 'moved');
  assert.equal(t.graph.filesIn('Hopper/Bills').length, 1);
  assert.equal(t.xero.bills.length, 1);
  assert.equal(t.xero.bills[0]!.attachments.length, 1);
});

test('a crash between creating the draft and attaching the PDF is repaired on retry', async () => {
  const t = setup();
  const pdf = await billPdf('INV-1042');
  t.extractor.on(pdf, billExtraction());
  const contact = t.xero.addContact(HOPPER_TENANT, 'Acme Foods Pty Ltd');
  t.xero.bills.push({ tenant: HOPPER_TENANT, invoiceId: 'inv-pre', invoiceNumber: 'INV-1042', status: 'DRAFT', total: 160, totalTax: 10, contactId: contact.contactId, attachments: [] });
  // File already saved earlier too:
  t.graph.files.set('Hopper/Bills/12 10 2026 - Acme Foods Pty Ltd - INV-1042.pdf', pdf);

  const out = await t.pipeline.processMessage(t.graph.addMessage('m10', HOPPER, [{ name: 'x.pdf', buf: pdf }]));
  assert.equal(out.status, 'moved');
  assert.equal(t.xero.bills.length, 1);
  assert.deepEqual(t.xero.bills[0]!.attachments, ['12 10 2026 - Acme Foods Pty Ltd - INV-1042.pdf']);
});

test('supplier name close to an existing Xero contact: draft goes under the placeholder contact, nothing is guessed', async () => {
  const t = setup();
  t.xero.addContact(HOPPER_TENANT, 'Acme Foods Wholesale');
  const pdf = await billPdf('INV-1');
  t.extractor.on(pdf, billExtraction({ supplier_name: 'Acme Foods' }));
  const out = await t.pipeline.processMessage(t.graph.addMessage('m11', HOPPER, [{ name: 'x.pdf', buf: pdf }]));
  assert.equal(out.status, 'moved');
  assert.equal(t.xero.bills.length, 1);
  const bill = t.xero.bills[0]!;
  assert.equal(bill.contactId, 'c-Unconfirmed Supplier - choose the correct contact');
  assert.equal(bill.input?.reference, 'CHECK SUPPLIER: Acme Foods');
  assert.deepEqual(t.xero.contactsCreated, ['Unconfirmed Supplier - choose the correct contact']);
  assert.ok(!t.xero.contacts.get(HOPPER_TENANT)!.some((c) => c.name === 'Acme Foods'));
});

test('an unconfirmed-supplier bill sent again is recognised as the same bill, not drafted twice', async () => {
  const t = setup();
  t.xero.addContact(HOPPER_TENANT, 'Acme Foods Wholesale');
  const pdf = await billPdf('INV-1');
  t.extractor.on(pdf, billExtraction({ supplier_name: 'Acme Foods' }));
  await t.pipeline.processMessage(t.graph.addMessage('m11a', HOPPER, [{ name: 'x.pdf', buf: pdf }]));
  await t.pipeline.processMessage(t.graph.addMessage('m11b', HOPPER, [{ name: 'x.pdf', buf: pdf }]));
  assert.equal(t.xero.bills.length, 1);
});

test('the same bill number and total under a different supplier is flagged as a possible duplicate, not filed twice', async () => {
  const t = setup();
  t.xero.addContact(HOPPER_TENANT, 'Acme Foods Wholesale');
  t.xero.addContact(HOPPER_TENANT, 'Zenith Plumbing Services');
  const a = await billPdf('SAME-1');
  const b = await makePdf([{ text: 'Zenith Plumbing', y: 60 }, { text: 'TAX INVOICE', y: 110, size: 22 }, { text: 'Invoice No SAME-1', y: 150 }, { text: 'Total 160.00', y: 200 }]);
  t.extractor.on(a, billExtraction({ supplier_name: 'Acme Foods' }));
  t.extractor.on(b, billExtraction({ supplier_name: 'Zenith Plumbing Services Group' }));
  await t.pipeline.processMessage(t.graph.addMessage('m11c', HOPPER, [{ name: 'a.pdf', buf: a }]));
  const out = await t.pipeline.processMessage(t.graph.addMessage('m11d', HOPPER, [{ name: 'b.pdf', buf: b }]));
  assert.equal(out.status, 'review');
  assert.equal(t.xero.bills.length, 1);
});

test('bill plus an unrecognised PDF: bill is processed, email stays in the inbox', async () => {
  const t = setup();
  const bill = await billPdf('INV-1042');
  const po = await randomPdf('3');
  t.extractor.on(bill, billExtraction());
  t.extractor.on(po, billExtraction({ document_heading: 'Purchase Order', document_type: 'other', bill: null }));
  const out = await t.pipeline.processMessage(t.graph.addMessage('m12', HOPPER, [{ name: 'a.pdf', buf: bill }, { name: 'b.pdf', buf: po }]));
  assert.equal(out.status, 'partial');
  assert.equal(t.xero.bills.length, 1);
  assert.equal(t.graph.moved.has('m12'), false);
  assert.deepEqual(t.graph.categories.get('m12'), [CAT.partial]);
});

test('dry run performs no writes at all', async () => {
  const t = setup({ dryRun: true });
  const bill = await billPdf('INV-1042');
  const stmt = await statementPdf('A1');
  t.extractor.on(bill, billExtraction());
  t.extractor.on(stmt, statementExtraction());
  const out = await t.pipeline.processMessage(t.graph.addMessage('m13', HOPPER, [{ name: 'a.pdf', buf: bill }, { name: 'b.pdf', buf: stmt }]));
  assert.equal(out.status, 'dry_run');
  assert.deepEqual([...t.graph.files.keys()], []);
  assert.equal(t.graph.moved.size, 0);
  assert.equal(t.graph.categories.size, 0);
  assert.equal(t.xero.bills.length, 0);
  assert.equal(t.xero.contactsCreated.length, 0);
  assert.equal(t.ledger.rows.length, 0);
  assert.ok(out.detail.some((l) => l.includes('12 10 2026 - Acme Foods Pty Ltd - INV-1042.pdf')));
});

test('DMARC failure on a "client" email is stopped before anything is read', async () => {
  const t = setup();
  t.graph.authResults = 'spf=fail dkim=none dmarc=fail action=quarantine';
  const pdf = await billPdf('INV-1');
  t.extractor.on(pdf, billExtraction());
  const out = await t.pipeline.processMessage(t.graph.addMessage('m14', HOPPER, [{ name: 'a.pdf', buf: pdf }]));
  assert.equal(out.status, 'review');
  assert.equal(t.extractor.total, 0);
  assert.deepEqual([...t.graph.files.keys()], []);
});

test('a missing destination folder is a setup problem, caught before any write', async () => {
  const t = setup();
  t.graph.folders.delete('Hopper/Bills');
  const pdf = await billPdf('INV-1');
  t.extractor.on(pdf, billExtraction());
  await assert.rejects(() => t.pipeline.processMessage(t.graph.addMessage('m15', HOPPER, [{ name: 'a.pdf', buf: pdf }])), SystemicError);
  assert.equal(t.extractor.total, 0);
});

test('a missing Outlook folder is a setup problem, caught before any write', async () => {
  const t = setup();
  t.graph.mailFolders.delete('Inbox/Hopper Joint');
  const pdf = await billPdf('INV-1');
  t.extractor.on(pdf, billExtraction());
  await assert.rejects(() => t.pipeline.processMessage(t.graph.addMessage('m16', HOPPER, [{ name: 'a.pdf', buf: pdf }])), SystemicError);
  assert.deepEqual([...t.graph.files.keys()], []);
});

test('Xero totals that differ from the PDF are flagged for a human even though a draft exists', async () => {
  const t = setup();
  t.xero.totalOverride = 161.5;
  const pdf = await billPdf('INV-1042');
  t.extractor.on(pdf, billExtraction());
  const out = await t.pipeline.processMessage(t.graph.addMessage('m17', HOPPER, [{ name: 'a.pdf', buf: pdf }]));
  assert.equal(out.status, 'review');
  assert.equal(t.graph.moved.has('m17'), false);
  assert.match(t.alerter.alerts[0]!.body, /totals differ/);
});

test('a file that is not really a PDF is not processed', async () => {
  const t = setup();
  const m = t.graph.addMessage('m18', HOPPER, [{ name: 'fake.pdf', buf: Buffer.from('MZ' + 'x'.repeat(300)) }]);
  const out = await t.pipeline.processMessage(m);
  assert.equal(out.status, 'review');
  assert.equal(t.extractor.total, 0);
});

test('already-tagged emails are skipped', async () => {
  const t = setup();
  const pdf = await billPdf('INV-1');
  const m = t.graph.addMessage('m19', HOPPER, [{ name: 'a.pdf', buf: pdf }]);
  m.categories = [CAT.review];
  assert.equal((await t.pipeline.processMessage(m)).status, 'ignored');
});

test('Xero refusing access (e.g. missing scope) is one setup problem, not a flag on every email', async () => {
  const t = setup();
  const pdf = await billPdf('INV-1042');
  t.extractor.on(pdf, billExtraction());
  t.xero.failCreateOnce = new XeroError('forbidden', 403, false);
  await assert.rejects(() => t.pipeline.processMessage(t.graph.addMessage('m20', HOPPER, [{ name: 'a.pdf', buf: pdf }])), SystemicError);
  assert.equal(t.graph.categories.has('m20'), false, 'email must not be tagged for a setup problem');
});

test('review path logs each item with supplier and number, and logs the bills that were saved', async () => {
  const t = setup();
  const good = await billPdf('INV-1042');
  const bad = await makePdf([{ text: 'Zed Supplies', y: 60 }, { text: 'TAX INVOICE', y: 110, size: 22 }, { text: 'No 9', y: 150 }]);
  t.extractor.on(good, billExtraction());
  const badEx = billExtraction({ supplier_name: 'Zed Supplies' });
  badEx.bill!.bill_number = 'Z-9';
  badEx.bill!.total_inc_gst = 999;
  t.extractor.on(bad, badEx);
  const out = await t.pipeline.processMessage(t.graph.addMessage('m21', HOPPER, [{ name: 'a.pdf', buf: good }, { name: 'b.pdf', buf: bad }]));
  assert.equal(out.status, 'review');
  assert.equal(t.graph.moved.has('m21'), false);
  assert.equal(t.ledger.rows.length, 2);
  assert.ok(t.ledger.rows.some((r) => r.outcome.startsWith('Saved') && r.number === 'INV-1042'));
  assert.ok(t.ledger.rows.some((r) => r.outcome === 'Needs review' && r.supplier === 'Zed Supplies' && r.number === 'Z-9'));
  assert.match(t.alerter.alerts[0]!.body, /Already saved to SharePoint: 12 10 2026/);
});

// ---------------------------------------------------------------------------
// Financial-year folders, month folders and the Bills List workbook
// ---------------------------------------------------------------------------

const AP = 'Clients/HOP/{FY}/Bookkeeping/Accounts Payable';
const fyClient = ClientSchema.parse({
  key: 'hopper',
  name: 'Hopper Joint Melbourne',
  senders: [HOPPER],
  outlookFolder: 'Inbox/Hopper Joint',
  sharepoint: { hostname: 'x.sharepoint.com', sitePath: '/sites/B', library: 'Documents', billsFolder: AP, statementsFolder: AP, monthFolders: true, billsList: { fileName: 'Bills List.xlsx' } },
  xero: { tenantId: HOPPER_TENANT },
});
const LIST_HEADERS = ['Supplier', 'Invoice No', 'Invoice Date', 'Due Date', 'Amount ex GST', 'GST', 'Total inc GST'];

function setupFy(now = '2026-10-28T10:00:00+11:00') {
  const graph = new FakeGraph();
  for (const m of ['July', 'August', 'September', 'October', 'November']) graph.folders.add(`Clients/HOP/2027/Bookkeeping/Accounts Payable/${m}`);
  for (const m of ['July', 'August']) graph.folders.add(`Clients/HOP/2028/Bookkeeping/Accounts Payable/${m}`);
  graph.addTable('Clients/HOP/2027/Bookkeeping/Accounts Payable/Bills List.xlsx', LIST_HEADERS);
  graph.addTable('Clients/HOP/2028/Bookkeeping/Accounts Payable/Bills List.xlsx', LIST_HEADERS);
  const xero = new FakeXero();
  const extractor = new FakeExtractor();
  const alerter = new FakeAlerter();
  const ledger = new FakeLedger();
  const pipeline = new Pipeline({
    cfg: { dryRun: false, passes: 2, allowedCurrencies: ['AUD'], contactFuzzyPolicy: 'review', createMissingContacts: true, blockOnDmarcFail: true, clients: [fyClient] },
    graph, xero, extractor, rules: DEFAULT_RULES, log: silentLogger, alerter, ledger,
    now: () => new Date(now),
  });
  return { graph, xero, extractor, alerter, pipeline };
}

test('bill is filed in the financial-year folder, the right month folder, and listed in Bills List once everything has succeeded', async () => {
  const t = setupFy();
  const pdf = await billPdf('FY-1');
  t.extractor.on(pdf, billExtraction());
  const m = t.graph.addMessage('f1', HOPPER, [{ name: 'a.pdf', buf: pdf }]);

  const out = await t.pipeline.processMessage(m);

  assert.equal(out.status, 'moved');
  assert.deepEqual(t.graph.filesIn('Clients/HOP/2027/Bookkeeping/Accounts Payable/October'), ['12 10 2026 - Acme Foods Pty Ltd - INV-1042.pdf']);
  const rows = t.graph.tables.get('Clients/HOP/2027/Bookkeeping/Accounts Payable/Bills List.xlsx')![0]!.rows;
  assert.deepEqual(rows, [['Acme Foods Pty Ltd', 'INV-1042', '2026-10-12', '2026-10-26', 150, 10, 160]]);
  assert.equal(t.xero.bills.length, 1);
});

test('a bill dated July 2027 goes to the 2028 folder, never the 2027 folder', async () => {
  const t = setupFy('2027-07-20T10:00:00+10:00');
  const pdf = await billPdf('FY-2');
  const ex = billExtraction();
  ex.bill!.bill_number = 'J-1';
  ex.bill!.issue_date_printed = '05/07/2027';
  ex.bill!.issue_date_iso = '2027-07-05';
  ex.bill!.due_date_printed = '19/07/2027';
  ex.bill!.due_date_iso = '2027-07-19';
  t.extractor.on(pdf, ex);
  const m = t.graph.addMessage('f2', HOPPER, [{ name: 'a.pdf', buf: pdf }]);

  const out = await t.pipeline.processMessage(m);

  assert.equal(out.status, 'moved');
  assert.deepEqual(t.graph.filesIn('Clients/HOP/2028/Bookkeeping/Accounts Payable/July'), ['05 07 2027 - Acme Foods Pty Ltd - J-1.pdf']);
  assert.deepEqual(t.graph.filesIn('Clients/HOP/2027/Bookkeeping/Accounts Payable/July'), []);
  assert.equal(t.graph.tables.get('Clients/HOP/2028/Bookkeeping/Accounts Payable/Bills List.xlsx')![0]!.rows.length, 1);
});

test('missing month folder: stops for review, nothing saved or drafted, no folder created', async () => {
  const t = setupFy();
  t.graph.folders.delete('Clients/HOP/2027/Bookkeeping/Accounts Payable/October');
  const pdf = await billPdf('FY-3');
  t.extractor.on(pdf, billExtraction());
  const m = t.graph.addMessage('f3', HOPPER, [{ name: 'a.pdf', buf: pdf }]);

  const out = await t.pipeline.processMessage(m);

  assert.equal(out.status, 'review');
  assert.match(out.detail.join(' '), /No october folder/);
  assert.equal(t.xero.bills.length, 0);
  assert.equal([...t.graph.files.keys()].filter((k) => k.endsWith('.pdf')).length, 0);
  assert.equal(t.graph.moved.has('f3'), false);
});

test('missing financial-year folder stops for review instead of using another year', async () => {
  const t = setupFy();
  const pdf = await billPdf('FY-4');
  const ex = billExtraction();
  ex.bill!.bill_number = 'K-9';
  ex.bill!.issue_date_printed = '10/03/2026';
  ex.bill!.issue_date_iso = '2026-03-10';
  ex.bill!.due_date_printed = '20/03/2026';
  ex.bill!.due_date_iso = '2026-03-20';
  t.extractor.on(pdf, ex);
  const m = t.graph.addMessage('f4', HOPPER, [{ name: 'a.pdf', buf: pdf }]);

  const out = await t.pipeline.processMessage(m);
  assert.equal(out.status, 'review');
  assert.match(out.detail.join(' '), /2026\/Bookkeeping\/Accounts Payable" does not exist/);
  assert.equal(t.xero.bills.length, 0);
});

test('Bills List not usable (no table or unrecognised columns): setup problem, nothing written, email untouched', async () => {
  const t = setupFy();
  t.graph.tables.set('Clients/HOP/2027/Bookkeeping/Accounts Payable/Bills List.xlsx', [{ name: 'Table1', headers: ['Supplier', 'Notes'], rows: [] }]);
  const pdf = await billPdf('FY-5');
  t.extractor.on(pdf, billExtraction());
  const m = t.graph.addMessage('f5', HOPPER, [{ name: 'a.pdf', buf: pdf }]);

  await assert.rejects(() => t.pipeline.processMessage(m), (e: unknown) => e instanceof SystemicError && /could not be matched/.test((e as Error).message));
  assert.equal(t.xero.bills.length, 0);
  assert.equal(t.graph.moved.has('f5'), false);
  assert.equal([...t.graph.files.keys()].filter((k) => k.endsWith('.pdf')).length, 0);
});

test('nothing is written to the Bills List while Xero is failing; the retry lists the bill exactly once', async () => {
  const t = setupFy();
  const pdf = await billPdf('FY-6');
  t.extractor.on(pdf, billExtraction());
  const m = t.graph.addMessage('f6', HOPPER, [{ name: 'a.pdf', buf: pdf }]);
  t.xero.failCreateOnce = new XeroError('Xero down', 503, true);

  await assert.rejects(() => t.pipeline.processMessage(m));
  assert.equal(t.graph.tables.get('Clients/HOP/2027/Bookkeeping/Accounts Payable/Bills List.xlsx')![0]!.rows.length, 0);

  const out = await t.pipeline.processMessage(m);
  assert.equal(out.status, 'moved');
  assert.equal(t.graph.tables.get('Clients/HOP/2027/Bookkeeping/Accounts Payable/Bills List.xlsx')![0]!.rows.length, 1);
  assert.equal(t.xero.bills.length, 1);
});

test('statement goes to the month of its as-at date in the same financial-year structure', async () => {
  const t = setupFy();
  const pdf = await statementPdf('S1');
  t.extractor.on(pdf, statementExtraction());
  const m = t.graph.addMessage('f7', HOPPER, [{ name: 's.pdf', buf: pdf }]);

  const out = await t.pipeline.processMessage(m);

  assert.equal(out.status, 'moved');
  assert.deepEqual(t.graph.filesIn('Clients/HOP/2027/Bookkeeping/Accounts Payable/October'), ['Acme Foods Pty Ltd - 2026 10 31.pdf']);
});

// ---------------------------------------------------------------------------
// Duplicates, reminders and multi-bill PDFs
// ---------------------------------------------------------------------------

test('the same bill arriving again in a second email is not saved, listed or drafted twice', async () => {
  const t = setup();
  const pdf = await billPdf('INV-1042');
  t.extractor.on(pdf, billExtraction());
  const first = await t.pipeline.processMessage(t.graph.addMessage('d1', HOPPER, [{ name: 'a.pdf', buf: pdf }]));
  assert.equal(first.status, 'moved');
  const second = await t.pipeline.processMessage(t.graph.addMessage('d2', HOPPER, [{ name: 'reminder.pdf', buf: pdf }]));
  assert.equal(second.status, 'review');
  assert.match(t.alerter.alerts[0]!.body, /DUPLICATE BILL.*already in the Bills List|DUPLICATE BILL/);
  assert.equal(t.graph.filesIn('Hopper/Bills').length, 1);
  assert.equal(t.xero.bills.length, 1);
});

test('a reminder with a different PDF for an already filed bill is kept as a copy for review, with no extra draft', async () => {
  const t = setup();
  const pdf = await billPdf('INV-1042');
  t.extractor.on(pdf, billExtraction());
  assert.equal((await t.pipeline.processMessage(t.graph.addMessage('r1', HOPPER, [{ name: 'a.pdf', buf: pdf }]))).status, 'moved');
  const reminder = await makePdf([{ text: 'Acme Foods Pty Ltd', y: 60 }, { text: 'TAX INVOICE', y: 110, size: 22 }, { text: 'Invoice No INV-1042 OVERDUE REMINDER', y: 150 }, { text: 'Total 160.00', y: 200 }]);
  t.extractor.on(reminder, billExtraction());
  const out = await t.pipeline.processMessage(t.graph.addMessage('r2', HOPPER, [{ name: 'b.pdf', buf: reminder }]));
  assert.equal(out.status, 'review');
  assert.equal(t.xero.bills.length, 1);
  assert.equal(t.graph.moved.has('r2'), false);
  assert.match(t.alerter.alerts[0]!.body, /DUPLICATE BILL/);
});

test('a PDF holding several invoices is not filed automatically', async () => {
  const t = setup();
  const pdf = await billPdf('MULTI');
  t.extractor.on(pdf, billExtraction({ invoice_count: 2 }));
  const out = await t.pipeline.processMessage(t.graph.addMessage('mb1', HOPPER, [{ name: 'two.pdf', buf: pdf }]));
  assert.equal(out.status, 'review');
  assert.equal(t.graph.filesIn('Hopper/Bills').length, 0);
  assert.equal(t.xero.bills.length, 0);
  assert.match(t.alerter.alerts[0]!.body, /2 separate invoices/);
});

test('a bill whose supplier is not confirmed in Xero is still listed in the Bills List, with the real supplier name and a note', async () => {
  const t = setupFy();
  t.xero.addContact(HOPPER_TENANT, 'Acme Foods Wholesale');
  const pdf = await billPdf('FY-9');
  t.extractor.on(pdf, billExtraction({ supplier_name: 'Acme Foods' }));
  const out = await t.pipeline.processMessage(t.graph.addMessage('f9', HOPPER, [{ name: 'a.pdf', buf: pdf }]));
  assert.equal(out.status, 'moved');
  const rows = t.graph.tables.get('Clients/HOP/2027/Bookkeeping/Accounts Payable/Bills List.xlsx')![0]!.rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]![0], 'Acme Foods');
});

test('a scanned bill is written to the Bills List in red with a scanned note, and the bill is still filed', async () => {
  const t = setupFy();
  const scan = await makePdf([]);
  t.extractor.on(scan, billExtraction({ confidence: 'medium' }));
  const out = await t.pipeline.processMessage(t.graph.addMessage('f12', HOPPER, [{ name: 'scan.pdf', buf: scan }]));
  assert.equal(out.status, 'moved');
  assert.equal(t.xero.bills.length, 1);
  assert.deepEqual(t.graph.highlighted, ['Clients/HOP/2027/Bookkeeping/Accounts Payable/Bills List.xlsx#0']);
});

test('if colouring the row fails, the bill is still filed and listed', async () => {
  const t = setupFy();
  t.graph.failHighlight = true;
  const scan = await makePdf([]);
  t.extractor.on(scan, billExtraction({ confidence: 'high' }));
  const out = await t.pipeline.processMessage(t.graph.addMessage('f13', HOPPER, [{ name: 'scan.pdf', buf: scan }]));
  assert.equal(out.status, 'moved');
  assert.equal(t.graph.tables.get('Clients/HOP/2027/Bookkeeping/Accounts Payable/Bills List.xlsx')![0]!.rows.length, 1);
});

test('a bill already in Xero under a different supplier (entered by hand) is flagged as a duplicate', async () => {
  const t = setup();
  const pdf = await billPdf('INV-1042');
  t.extractor.on(pdf, billExtraction());
  t.xero.bills.push({ tenant: HOPPER_TENANT, invoiceId: 'manual-1', invoiceNumber: 'INV-1042', status: 'AUTHORISED', total: 160, totalTax: 14.55, contactId: 'c-someone-else', reference: '', attachments: [] });
  const out = await t.pipeline.processMessage(t.graph.addMessage('x1', HOPPER, [{ name: 'a.pdf', buf: pdf }]));
  assert.equal(out.status, 'review');
  assert.equal(t.xero.bills.length, 1);
  assert.equal(t.graph.moved.has('x1'), false);
  assert.match(t.alerter.alerts[0]!.body, /DUPLICATE BILL.*Xero/);
});

test('an interrupted earlier run (draft without the PDF attached, no list row) is finished, not called a duplicate', async () => {
  const t = setup();
  const pdf = await billPdf('INV-1042');
  t.extractor.on(pdf, billExtraction());
  t.xero.addContact(HOPPER_TENANT, 'Acme Foods Pty Ltd');
  t.xero.bills.push({ tenant: HOPPER_TENANT, invoiceId: 'half-1', invoiceNumber: 'INV-1042', status: 'DRAFT', total: 160, totalTax: 14.55, contactId: 'c-Acme Foods Pty Ltd', reference: '', attachments: [] });
  const out = await t.pipeline.processMessage(t.graph.addMessage('x2', HOPPER, [{ name: 'a.pdf', buf: pdf }]));
  assert.equal(out.status, 'moved');
  assert.equal(t.xero.bills.length, 1);
  assert.equal(t.xero.bills[0]!.attachments.length, 1);
});
