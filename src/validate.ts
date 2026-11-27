import type { BillData, Extraction, StatementData } from './types.js';
import {
  addDays,
  daysBetween,
  isValidIsoDate,
  near,
  normaliseBusinessName,
  normaliseDocNumber,
  parsePrintedDate,
  round2,
  sameBusinessName,
} from './util.js';

export interface ValidateContext {
  /** YYYY-MM-DD in the clients' timezone. */
  today: string;
  allowedCurrencies: string[];
}

const GST_RATE = 0.1;

/** Allowed rounding drift when summing per-line GST. */
const gstTolerance = (lineCount: number) => 0.02 + 0.006 * lineCount;

export interface ResolvedBill {
  issueDate: string;
  dueDate: string | null;
  currency: string;
  amountsIncludeGst: boolean;
  totalGst: number;
  totalIncGst: number;
  subtotalExGst: number;
  /** Relaxed mode only: things that did not add up. They are written on the Xero draft and the Bills List, they do not stop it. */
  warnings: string[];
  /** Relaxed mode only: the file is renamed and sent to review, with nothing entered in Xero. */
  reviewOnly?: string;
}

/**
 * Mathematical and logical checks on an extracted bill. Every failed check becomes a
 * reason for human review; nothing is "fixed up" silently.
 */
export function validateBill(
  ex: Extraction,
  ctx: ValidateContext,
  opts: { credit?: boolean } = {},
): { issues: string[]; resolved: ResolvedBill | null } {
  const issues: string[] = [];
  const b = ex.bill;
  const word = opts.credit ? 'Credit note' : 'Bill';

  if (!ex.supplier_name || ex.supplier_name.trim().length < 2) issues.push('Supplier name not found.');
  if (!b) return { issues: [...issues, 'No bill details were extracted.'], resolved: null };
  if (!b.bill_number || !b.bill_number.trim()) issues.push(opts.credit ? 'Credit note number not found.' : 'Supplier bill number not found.');

  // ----- dates -----
  let issueDate: string | null = null;
  // When Claude left the ISO date out but gave the date as printed, the printed text is read by code instead (no guessing).
  const isoFromPrinted = parsePrintedDate(b.issue_date_printed);
  const issueIso = isValidIsoDate(b.issue_date_iso) ? b.issue_date_iso : isoFromPrinted && isValidIsoDate(isoFromPrinted) ? isoFromPrinted : null;
  if (!issueIso) {
    issues.push(`${word} issue date missing or invalid.`);
  } else {
    issueDate = issueIso;
    const printed = parsePrintedDate(b.issue_date_printed);
    if (printed && printed !== issueDate) {
      issues.push(`Issue date mismatch: printed "${b.issue_date_printed}" reads as ${printed} but extraction gave ${issueDate}.`);
    }
    if (issueDate < '2000-01-01') issues.push(`Issue date ${issueDate} is implausibly old.`);
    if (daysBetween(ctx.today, issueDate) > 1) issues.push(`Issue date ${issueDate} is in the future.`);
  }

  let dueDate: string | null = null;
  if (b.due_date_iso) {
    if (!isValidIsoDate(b.due_date_iso)) {
      issues.push('Due date is not a valid date.');
    } else {
      dueDate = b.due_date_iso;
      const printed = parsePrintedDate(b.due_date_printed);
      if (printed && printed !== dueDate) {
        issues.push(`Due date mismatch: printed "${b.due_date_printed}" reads as ${printed} but extraction gave ${dueDate}.`);
      }
      if (issueDate && dueDate < issueDate) issues.push(`Due date ${dueDate} is before the issue date ${issueDate}.`);
    }
  } else if (issueDate) {
    if (b.due_on_receipt) dueDate = issueDate;
    else if (b.payment_terms_days !== null && Number.isInteger(b.payment_terms_days) && b.payment_terms_days >= 0 && b.payment_terms_days <= 120) {
      dueDate = addDays(issueDate, b.payment_terms_days);
    }
  }

  // ----- currency -----
  const currency = (b.currency ?? 'AUD').trim().toUpperCase();
  if (!ctx.allowedCurrencies.includes(currency)) issues.push(`Currency ${currency} is not enabled for automatic drafting.`);

  // ----- lines and totals -----
  if (b.lines.length === 0) issues.push('No line items were extracted.');
  for (const [i, l] of b.lines.entries()) {
    if (!Number.isFinite(l.line_amount)) issues.push(`Line ${i + 1} has an invalid amount.`);
    if (!l.description.trim()) issues.push(`Line ${i + 1} has no description.`);
  }

  let totalGst = 0;
  let totalInc = 0;
  let subtotalEx = 0;
  if (b.total_inc_gst === null || b.total_gst === null) {
    issues.push('Printed total or GST amount not found.');
  } else if (b.lines.length > 0) {
    totalGst = round2(b.total_gst);
    totalInc = round2(b.total_inc_gst);
    const lineSum = round2(b.lines.reduce((s, l) => s + l.line_amount, 0));
    const gstLines = b.lines.filter((l) => l.gst_applicable);
    const tol = gstTolerance(b.lines.length);

    if (totalInc === 0) issues.push(`Total is 0.00: the document shows nothing to pay (a free-of-charge or zero-value invoice), so it was not entered.`);
    else if (totalInc < 0) issues.push(opts.credit ? `Credit note total ${totalInc.toFixed(2)} is zero or negative (it should be read as a positive amount).` : `Total ${totalInc.toFixed(2)} is zero or negative (credit note or misread).`);
    if (totalGst < 0) issues.push('GST amount is negative.');

    if (!b.line_amounts_include_gst) {
      subtotalEx = lineSum;
      const gstBase = round2(gstLines.reduce((s, l) => s + l.line_amount, 0));
      const expectedGst = round2(gstBase * GST_RATE);
      if (b.subtotal_ex_gst !== null && !near(b.subtotal_ex_gst, lineSum, 0.05)) {
        issues.push(`Line items add to ${lineSum.toFixed(2)} but the printed subtotal is ${b.subtotal_ex_gst.toFixed(2)}.`);
      }
      if (!near(lineSum + totalGst, totalInc, 0.05)) {
        issues.push(`Lines (${lineSum.toFixed(2)}) plus GST (${totalGst.toFixed(2)}) do not equal the printed total ${totalInc.toFixed(2)}.`);
      }
      if (!near(totalGst, expectedGst, tol)) {
        issues.push(`GST ${totalGst.toFixed(2)} does not match 10% of the GST-applicable lines (${expectedGst.toFixed(2)}).`);
      }
    } else {
      const gstBase = round2(gstLines.reduce((s, l) => s + l.line_amount, 0));
      const expectedGst = round2(gstBase / 11);
      subtotalEx = round2(totalInc - totalGst);
      if (!near(lineSum, totalInc, 0.05)) {
        issues.push(`GST-inclusive lines add to ${lineSum.toFixed(2)} but the printed total is ${totalInc.toFixed(2)}.`);
      }
      if (!near(totalGst, expectedGst, tol)) {
        issues.push(`GST ${totalGst.toFixed(2)} does not match one eleventh of the GST-applicable lines (${expectedGst.toFixed(2)}).`);
      }
      if (b.subtotal_ex_gst !== null && !near(b.subtotal_ex_gst, subtotalEx, 0.05)) {
        issues.push(`Printed subtotal ${b.subtotal_ex_gst.toFixed(2)} does not equal total minus GST (${subtotalEx.toFixed(2)}).`);
      }
    }
  }

  if (issues.length > 0 || !issueDate) return { issues, resolved: null };
  return {
    issues,
    resolved: {
      issueDate,
      dueDate,
      currency,
      amountsIncludeGst: b.line_amounts_include_gst,
      totalGst,
      totalIncGst: totalInc,
      subtotalExGst: subtotalEx,
      warnings: [],
    },
  };
}


/**
 * Relaxed checks (per client). Only what is needed to name the file and find duplicates must be right: supplier, number and
 * issue date. Everything else (amounts, GST, totals, due date, currency) is drafted from the lines as best as possible and
 * the differences are returned as warnings. A zero or negative bill is renamed and sent to review, not entered in Xero.
 * Mutates ex.bill (fills in a missing line, a missing description).
 */
export function validateBillRelaxed(
  ex: Extraction,
  ctx: ValidateContext,
  opts: { credit?: boolean } = {},
): { issues: string[]; resolved: ResolvedBill | null } {
  const issues: string[] = [];
  const warnings: string[] = [];
  const b = ex.bill;
  const word = opts.credit ? 'Credit note' : 'Bill';
  if (!ex.supplier_name || ex.supplier_name.trim().length < 2) issues.push('Supplier name not found.');
  if (!b) return { issues: [...issues, 'No bill details were extracted.'], resolved: null };
  if (!b.bill_number || !b.bill_number.trim()) issues.push(opts.credit ? 'Credit note number not found.' : 'Supplier bill number not found.');

  let issueDate: string | null = null;
  const isoFromPrinted = parsePrintedDate(b.issue_date_printed);
  const issueIso = isValidIsoDate(b.issue_date_iso) ? b.issue_date_iso : isoFromPrinted && isValidIsoDate(isoFromPrinted) ? isoFromPrinted : null;
  if (!issueIso) {
    issues.push(`${word} issue date missing or invalid.`);
  } else {
    issueDate = issueIso;
    const printed = parsePrintedDate(b.issue_date_printed);
    if (printed && printed !== issueDate) issues.push(`Issue date mismatch: printed "${b.issue_date_printed}" reads as ${printed} but extraction gave ${issueDate}.`);
    if (issueDate < '2000-01-01') issues.push(`Issue date ${issueDate} is implausibly old.`);
    if (daysBetween(ctx.today, issueDate) > 1) issues.push(`Issue date ${issueDate} is in the future.`);
  }

  let dueDate: string | null = null;
  if (b.due_date_iso) {
    if (!isValidIsoDate(b.due_date_iso)) warnings.push('due date not valid, left blank');
    else if (issueDate && b.due_date_iso < issueDate) warnings.push(`due date ${b.due_date_iso} is before the issue date, left blank`);
    else dueDate = b.due_date_iso;
  } else if (issueDate) {
    if (b.due_on_receipt) dueDate = issueDate;
    else if (b.payment_terms_days !== null && Number.isInteger(b.payment_terms_days) && b.payment_terms_days >= 0 && b.payment_terms_days <= 120) dueDate = addDays(issueDate, b.payment_terms_days);
  }

  let currency = (b.currency ?? 'AUD').trim().toUpperCase();
  if (!ctx.allowedCurrencies.includes(currency)) {
    warnings.push(`currency ${currency} entered as AUD`);
    currency = 'AUD';
  }

  for (const [i, l] of b.lines.entries()) {
    if (!Number.isFinite(l.line_amount)) issues.push(`Line ${i + 1} has an invalid amount.`);
    if (!l.description.trim()) l.description = 'Item';
  }

  const printedTotal = b.total_inc_gst === null ? null : round2(b.total_inc_gst);
  const printedGst = b.total_gst === null ? null : round2(b.total_gst);
  if (b.lines.length === 0 && issues.length === 0) {
    if (printedTotal === null) {
      issues.push('No line items and no total were found, so there is nothing to enter.');
    } else if (printedTotal !== 0) {
      const gst = printedGst ?? 0;
      const amount = b.line_amounts_include_gst ? printedTotal : round2(b.subtotal_ex_gst ?? printedTotal - gst);
      b.lines.push({ description: 'See attached invoice', quantity: 1, unit_price: amount, line_amount: amount, gst_applicable: gst > 0 });
      warnings.push('no line items were found, one line was made from the total');
    }
  }
  if (issues.length > 0 || !issueDate) return { issues, resolved: null };

  const lineSum = round2(b.lines.reduce((s, l) => s + l.line_amount, 0));
  const gstBase = round2(b.lines.filter((l) => l.gst_applicable).reduce((s, l) => s + l.line_amount, 0));
  const incl = b.line_amounts_include_gst;
  const tol = gstTolerance(b.lines.length);
  const expectedGst = round2(incl ? gstBase / 11 : gstBase * GST_RATE);
  const totalGst = printedGst !== null && printedGst >= 0 && near(printedGst, expectedGst, tol) ? printedGst : expectedGst;
  const totalInc = incl ? lineSum : round2(lineSum + totalGst);
  const subtotalEx = incl ? round2(totalInc - totalGst) : lineSum;

  if (printedTotal !== null && !near(printedTotal, totalInc, 0.05)) warnings.push(`printed total ${printedTotal.toFixed(2)}, lines make ${totalInc.toFixed(2)}`);
  if (printedGst !== null && !near(printedGst, totalGst, 0.05)) warnings.push(`printed GST ${printedGst.toFixed(2)}, drafted ${totalGst.toFixed(2)}`);
  if (!incl && b.subtotal_ex_gst !== null && !near(b.subtotal_ex_gst, lineSum, 0.05)) warnings.push(`printed subtotal ${b.subtotal_ex_gst.toFixed(2)}, lines add to ${lineSum.toFixed(2)}`);

  let reviewOnly: string | undefined;
  const checkTotal = printedTotal ?? totalInc;
  if (checkTotal === 0 || (b.lines.length > 0 && totalInc === 0)) {
    reviewOnly = 'Total is 0.00: the document shows nothing to pay (a free-of-charge or zero-value invoice), so it was renamed but not entered in Xero.';
  } else if (checkTotal < 0 || totalInc < 0) {
    reviewOnly = `Total ${(printedTotal ?? totalInc).toFixed(2)} is negative, so it was renamed but not entered in Xero. Enter it by hand if it is a credit.`;
  }

  return {
    issues,
    resolved: { issueDate, dueDate, currency, amountsIncludeGst: incl, totalGst, totalIncGst: totalInc, subtotalExGst: subtotalEx, warnings, ...(reviewOnly ? { reviewOnly } : {}) },
  };
}

export function validateStatement(ex: Extraction, ctx: ValidateContext): { issues: string[]; asAt: string | null } {
  const issues: string[] = [];
  if (!ex.supplier_name || ex.supplier_name.trim().length < 2) issues.push('Supplier name not found.');
  const s = ex.statement;
  if (!s) return { issues: [...issues, 'No statement details were extracted.'], asAt: null };
  if (!isValidIsoDate(s.statement_date_iso)) {
    issues.push('Statement "as at" date missing or invalid.');
    return { issues, asAt: null };
  }
  const printed = parsePrintedDate(s.statement_date_printed);
  if (printed && printed !== s.statement_date_iso) {
    issues.push(`Statement date mismatch: printed "${s.statement_date_printed}" reads as ${printed} but extraction gave ${s.statement_date_iso}.`);
  }
  if (s.statement_date_iso < '2000-01-01') issues.push(`Statement date ${s.statement_date_iso} is implausibly old.`);
  if (daysBetween(ctx.today, s.statement_date_iso) > 7) issues.push(`Statement date ${s.statement_date_iso} is in the future.`);
  return { issues, asAt: issues.length ? null : s.statement_date_iso };
}

// ---------------------------------------------------------------------------
// Agreement between independent extraction passes
// ---------------------------------------------------------------------------

function sortedAmounts(b: BillData): string {
  return b.lines
    .map((l) => round2(l.line_amount).toFixed(2))
    .sort()
    .join('|');
}

/**
 * A supplier bill in a currency the team enters as AUD (they convert by hand): the amounts stay as printed, the currency
 * becomes AUD, and the foreign tax (for example Indian GST) is kept as a GST-free line so the total still equals the PDF.
 * Returns the original currency when something was changed, otherwise null.
 */
export function treatCurrencyAsAud(b: BillData, list: string[]): string | null {
  const cur = (b.currency ?? '').trim().toUpperCase();
  if (!cur || cur === 'AUD' || !list.includes(cur)) return null;
  const tax = round2(b.total_gst ?? 0);
  b.lines = b.lines.map((l) => ({ ...l, gst_applicable: false }));
  if (!b.line_amounts_include_gst && tax > 0) {
    b.lines.push({ description: `Overseas tax (${cur}), not claimable`, quantity: 1, unit_price: tax, line_amount: tax, gst_applicable: false });
  }
  b.total_gst = 0;
  if (b.total_inc_gst !== null) b.subtotal_ex_gst = b.total_inc_gst;
  b.currency = 'AUD';
  return cur;
}

export function compareBillPasses(a: Extraction, b: Extraction, keyFieldsOnly = false): string[] {
  const diffs: string[] = [];
  if (!sameBusinessName(a.supplier_name ?? '', b.supplier_name ?? '')) diffs.push(`supplier name ("${a.supplier_name}" vs "${b.supplier_name}")`);

  const ba = a.bill;
  const bb = b.bill;
  if (!ba || !bb) return [...diffs, 'bill details missing in one pass'];

  if (normaliseDocNumber(ba.bill_number ?? '') !== normaliseDocNumber(bb.bill_number ?? '')) {
    diffs.push(`bill number ("${ba.bill_number}" vs "${bb.bill_number}")`);
  }
  if (ba.issue_date_iso !== bb.issue_date_iso) diffs.push(`issue date (${ba.issue_date_iso} vs ${bb.issue_date_iso})`);
  if (keyFieldsOnly) return diffs; // relaxed mode: only supplier, number and issue date must agree
  const dueA = ba.due_date_iso ?? (ba.due_on_receipt ? ba.issue_date_iso : null);
  const dueB = bb.due_date_iso ?? (bb.due_on_receipt ? bb.issue_date_iso : null);
  if (dueA !== dueB && !(dueA === null || dueB === null)) diffs.push(`due date (${dueA} vs ${dueB})`);
  if (ba.total_inc_gst !== bb.total_inc_gst) diffs.push(`total (${ba.total_inc_gst} vs ${bb.total_inc_gst})`);
  if (ba.total_gst !== bb.total_gst) diffs.push(`GST (${ba.total_gst} vs ${bb.total_gst})`);
  if (ba.lines.length !== bb.lines.length) diffs.push(`line count (${ba.lines.length} vs ${bb.lines.length})`);
  else if (sortedAmounts(ba) !== sortedAmounts(bb)) diffs.push('line amounts');
  return diffs;
}

export function compareStatementPasses(a: Extraction, b: Extraction): string[] {
  const diffs: string[] = [];
  if (!sameBusinessName(a.supplier_name ?? '', b.supplier_name ?? '')) {
    diffs.push(`supplier name ("${a.supplier_name}" vs "${b.supplier_name}")`);
  }
  const da = (a.statement as StatementData | null)?.statement_date_iso ?? null;
  const db = (b.statement as StatementData | null)?.statement_date_iso ?? null;
  if (da !== db) diffs.push(`statement date (${da} vs ${db})`);
  return diffs;
}
