import type { BillData } from './types.js';
import type { ResolvedBill } from './validate.js';
import { near, round2 } from './util.js';

export interface DraftLine {
  description: string;
  quantity: number;
  unitAmount: number;
  lineAmount: number;
  taxType: string;
  taxAmount: number;
  accountCode?: string;
}

export interface DraftBillInput {
  contactId: string;
  issueDate: string;
  dueDate: string | null;
  invoiceNumber: string;
  currency: string;
  amountsIncludeGst: boolean;
  lines: DraftLine[];
  expectedTotal: number;
  expectedGst: number;
  /** Optional free text shown in Xero's Reference field. */
  reference?: string;
}

const decimals = (n: number): number => {
  const s = n.toString();
  const i = s.indexOf('.');
  return i === -1 ? 0 : s.length - i - 1;
};

/**
 * Turns the validated extraction into Xero lines whose totals equal the printed totals.
 * GST is set per line, with any cent-level rounding difference pushed onto one GST line,
 * so Xero's total matches the supplier's document exactly.
 */
export function buildDraftLines(
  bill: BillData,
  resolved: ResolvedBill,
  tax: { withGst: string; noGst: string },
  accountCode?: string,
): DraftLine[] {
  const lines: DraftLine[] = bill.lines.map((l) => {
    const amount = round2(l.line_amount);
    let quantity = 1;
    let unitAmount = amount;
    if (l.quantity !== null && l.unit_price !== null && l.quantity !== 0 && near(l.quantity * l.unit_price, amount, 0.005) && decimals(l.unit_price) <= 2 && decimals(l.quantity) <= 4) {
      quantity = l.quantity;
      unitAmount = l.unit_price;
    }
    const taxAmount = !l.gst_applicable ? 0 : resolved.amountsIncludeGst ? round2(amount / 11) : round2(amount * 0.1);
    return {
      description: l.description.trim().slice(0, 4000),
      quantity,
      unitAmount,
      lineAmount: amount,
      taxType: l.gst_applicable ? tax.withGst : tax.noGst,
      taxAmount,
      ...(accountCode ? { accountCode } : {}),
    };
  });

  const diff = round2(resolved.totalGst - lines.reduce((s, l) => s + l.taxAmount, 0));
  if (diff !== 0) {
    const gstLines = lines.filter((l) => l.taxType === tax.withGst);
    const target = gstLines.sort((a, b) => Math.abs(b.lineAmount) - Math.abs(a.lineAmount))[0];
    if (target) target.taxAmount = round2(target.taxAmount + diff);
  }
  return lines;
}

/** What Xero should total to, computed from our own lines, used to confirm Xero's response. */
export function expectedXeroTotals(lines: DraftLine[], amountsIncludeGst: boolean): { total: number; gst: number } {
  const lineSum = round2(lines.reduce((s, l) => s + l.lineAmount, 0));
  const gst = round2(lines.reduce((s, l) => s + l.taxAmount, 0));
  return { total: amountsIncludeGst ? lineSum : round2(lineSum + gst), gst };
}
