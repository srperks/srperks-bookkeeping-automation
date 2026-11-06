/**
 * Accuracy tester. Runs the exact same reading, classification and validation the live service uses
 * on PDF files from your disk, and prints what would happen. Nothing is saved or sent anywhere.
 *
 *   npm run extract -- path/to/bill.pdf [more.pdf ...] [--json]
 *
 * Needs only ANTHROPIC_API_KEY (and optionally config/clients.json for extra headings / currencies).
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { loadDotEnv, loadExtractionConfig, loadClientsFile } from '../config.js';
import { ClaudeExtractor } from '../extract.js';
import { readPdfText, type PdfText } from '../pdftext.js';
import { buildRules, classifyLines, decideType, DEFAULT_RULES } from '../classify.js';
import { compareBillPasses, compareStatementPasses, validateBill, validateStatement } from '../validate.js';
import { billFileName, statementFileName } from '../naming.js';
import { buildDraftLines } from '../billmap.js';
import { moneyFmt, todayIso } from '../util.js';
import type { DocKind, Extraction } from '../types.js';

loadDotEnv();

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const files = args.filter((a) => !a.startsWith('--'));
  if (files.length === 0) {
    console.error('Usage: npm run extract -- <file.pdf> [more.pdf ...] [--json]');
    process.exit(2);
  }

  const ec = loadExtractionConfig();
  let rules = DEFAULT_RULES;
  let allowedCurrencies = ['AUD'];
  let taxTypes = { withGst: 'INPUT', noGst: 'EXEMPTEXPENSES' };
  try {
    const cf = loadClientsFile();
    rules = buildRules(cf.rules.extraBillHeadings, cf.rules.extraStatementHeadings);
    allowedCurrencies = cf.allowedCurrencies.map((c) => c.toUpperCase());
    const c0 = cf.clients[0];
    if (c0) taxTypes = { withGst: c0.xero.taxTypeWithGst, noGst: c0.xero.taxTypeNoGst };
  } catch {
    /* no client file: defaults are fine for testing */
  }
  const extractor = new ClaudeExtractor(ec.anthropicApiKey, ec.model);

  for (const file of files) {
    console.log(`\n=== ${basename(file)} ===`);
    const buf = readFileSync(file);
    let text: PdfText | null = null;
    try {
      text = await readPdfText(buf);
      console.log(`Text layer: ${text.hasText ? 'yes' : 'NO (scan or image)'}, ${text.pageCount} page(s)`);
      console.log('Top lines:', text.page1Lines.slice(0, 8).map((l) => `\n    ${l}`).join(''));
      console.log('Text-layer heading verdict:', classifyLines(text.page1Lines, rules));
    } catch (e) {
      console.log('Could not read text layer:', (e as Error).message);
    }

    const passes: Extraction[] = [];
    for (let i = 0; i < ec.passes; i++) passes.push(await extractor.extract(buf));
    const first = passes[0]!;
    if (asJson) console.log(JSON.stringify(first, null, 2));

    const decision = decideType(text, first, rules);
    console.log(`Claude read heading: "${first.document_heading}" (type ${first.document_type}, confidence ${first.confidence})`);

    if (decision.kind === 'other') {
      console.log(`RESULT: LEAVE IN INBOX. ${decision.reason}`);
      continue;
    }
    if (decision.kind === 'review') {
      console.log('RESULT: STOP FOR REVIEW');
      decision.reasons.forEach((r) => console.log('  -', r));
      continue;
    }
    const kind: DocKind = decision.kind;
    console.log(`Classified as ${kind.toUpperCase()} (${decision.basis})`);

    const diffs = passes.slice(1).flatMap((p) => [
      ...(p.document_type !== kind ? [`document type (${p.document_type})`] : []),
      ...(kind === 'bill' ? compareBillPasses(first, p) : compareStatementPasses(first, p)),
    ]);
    if (diffs.length) {
      console.log('RESULT: STOP FOR REVIEW. Independent readings disagree on:', diffs.join(', '));
      continue;
    }

    const ctx = { today: todayIso(), allowedCurrencies };
    if (kind === 'statement') {
      const v = validateStatement(first, ctx);
      if (v.issues.length || !v.asAt) {
        console.log('RESULT: STOP FOR REVIEW');
        v.issues.forEach((r) => console.log('  -', r));
        continue;
      }
      console.log(`RESULT: FILE AS STATEMENT\n  File name: ${statementFileName(first.supplier_name!, v.asAt)}`);
      continue;
    }

    const v = validateBill(first, ctx);
    if (v.issues.length || !v.resolved || !first.bill) {
      console.log('RESULT: STOP FOR REVIEW');
      v.issues.forEach((r) => console.log('  -', r));
      continue;
    }
    const r = v.resolved;
    console.log(`RESULT: FILE AS BILL AND CREATE XERO DRAFT`);
    console.log(`  File name : ${billFileName(r.issueDate, first.supplier_name!, first.bill.bill_number!)}`);
    console.log(`  Supplier  : ${first.supplier_name}  (ABN ${first.supplier_abn ?? 'n/a'})   Customer: ${first.customer_name ?? 'n/a'}`);
    console.log(`  Bill no   : ${first.bill.bill_number}   Issued ${r.issueDate}   Due ${r.dueDate ?? 'not stated'}`);
    console.log(`  Amounts   : ex GST ${moneyFmt(r.subtotalExGst)}   GST ${moneyFmt(r.totalGst)}   total ${moneyFmt(r.totalIncGst)}   (${r.amountsIncludeGst ? 'lines include GST' : 'lines exclude GST'})`);
    for (const l of buildDraftLines(first.bill, r, taxTypes)) {
      console.log(`    - ${l.description.slice(0, 60).padEnd(60)} ${l.quantity} x ${l.unitAmount}  = ${moneyFmt(l.lineAmount)}  ${l.taxType}  GST ${moneyFmt(l.taxAmount)}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
