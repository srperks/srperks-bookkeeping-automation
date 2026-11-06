import type { DriveRef, GraphPort } from './graph.js';
import { normaliseBusinessName, normaliseDocNumber } from './util.js';

/**
 * The "Bills List" Excel workbook kept in each client's Accounts Payable folder.
 * Each filed bill adds one row. Columns are matched by their header text, so staff can keep
 * their own column order. A column the service does not know is left blank. The four columns
 * Supplier, Bill number, Issue date and Total are required: without them nothing is written.
 */

export type Field = 'supplier' | 'billNumber' | 'issueDate' | 'dueDate' | 'exGst' | 'gst' | 'total' | 'fileName' | 'notes';

export interface BillsRowData {
  supplier: string;
  billNumber: string;
  issueDate: string; // ISO yyyy-mm-dd
  dueDate: string | null;
  exGst: number | null;
  gst: number | null;
  total: number;
  fileName: string;
  notes: string;
}

const REQUIRED: Field[] = ['supplier', 'issueDate', 'total'];
const REQUIRED_LABEL: Record<string, string> = { supplier: 'Supplier', billNumber: 'Bill/Invoice number', issueDate: 'Issue date', total: 'Total' };

const norm = (h: string): string => h.toLowerCase().replace(/[^a-z0-9#]+/g, ' ').trim();

/** Classifies one header. Order matters: "Total inc GST" must not be read as the GST column. */
export function classifyHeader(header: string): Field | null {
  const h = norm(header);
  if (!h) return null;
  if (/\bdue\b/.test(h)) return /\b(amount|balance|total|owing|paid)\b/.test(h) ? null : 'dueDate';
  if (/\b(paid|payment|received|approved|posted|entered|statement)\b/.test(h)) return null;
  if (/\b(ex|excl|excluding|net|subtotal|before)\b/.test(h) && /(gst|tax|total|amount|sub|net|ex)/.test(h)) return 'exGst';
  if (/(\b(invoice|inv|bill|reference|ref|supplier invoice|supplier bill)\b.*(\bno\b|\bnum\b|number|#|ref)|^(invoice|inv|bill|reference|ref|invoice #|bill #)$|^(no|number|#)$)/.test(h)) return 'billNumber';
  if (/\b(total|gross|inc|incl|including|invoice amount|bill amount|amount)\b/.test(h)) return 'total';
  if (/\b(gst|tax)\b/.test(h)) return 'gst';
  if (/(^|\s)(file|pdf|document|link|filename)(\s|$)/.test(h)) return 'fileName';
  if (/\b(notes?|comments?|remarks?)\b/.test(h)) return 'notes';
  if (/\b(supplier|vendor|creditor|payee)\b/.test(h) && !/\b(number|no|ref|code|id)\b/.test(h)) return 'supplier';
  if (/\bdate\b/.test(h)) return 'issueDate';
  return null;
}

export type ColumnPlan =
  | { ok: true; columns: Array<Field | null>; headers: string[] }
  | { ok: false; reason: string };

export function planColumns(headers: string[]): ColumnPlan {
  const used = new Set<Field>();
  const columns = headers.map((h) => {
    const f = classifyHeader(h);
    if (!f || used.has(f)) return null; // first column wins; a repeat stays blank
    used.add(f);
    return f;
  });
  const missing = REQUIRED.filter((f) => !used.has(f)).map((m) => REQUIRED_LABEL[m]!);
  // A bill must be recognisable later (so it is never listed twice): by its number or by its file name.
  if (!used.has('billNumber') && !used.has('fileName')) missing.push('Bill/Invoice number or File name');
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `The Bills List columns could not be matched: missing ${missing.join(', ')}. Columns found: ${headers.map((h) => `"${h}"`).join(', ')}.`,
    };
  }
  return { ok: true, columns, headers };
}

/** Cells the service has no value for are sent as null, which leaves the cell (or a calculated column) as it is. */
export function buildRow(plan: Extract<ColumnPlan, { ok: true }>, d: BillsRowData): Array<string | number | null> {
  return plan.columns.map((f) => {
    switch (f) {
      case 'supplier': return d.supplier;
      case 'billNumber': return d.billNumber;
      case 'issueDate': return d.issueDate;
      case 'dueDate': return d.dueDate;
      case 'exGst': return d.exGst;
      case 'gst': return d.gst;
      case 'total': return d.total;
      case 'fileName': return d.fileName;
      case 'notes': return d.notes || null;
      default: return null;
    }
  });
}

const stripPdf = (n: string): string => n.trim().toLowerCase().replace(/\.pdf$/, '');

/**
 * Is this bill already listed? By supplier plus bill number when the list has a number column,
 * otherwise by the saved file name (which contains date, supplier and bill number).
 */
export function rowExists(plan: Extract<ColumnPlan, { ok: true }>, rows: Array<Array<string | number | null>>, d: BillsRowData): boolean {
  const ni = plan.columns.indexOf('billNumber');
  if (ni >= 0) {
    const si = plan.columns.indexOf('supplier');
    const wantSupplier = normaliseBusinessName(d.supplier);
    const wantNumber = normaliseDocNumber(d.billNumber);
    return rows.some((r) => normaliseBusinessName(String(r[si] ?? '')) === wantSupplier && normaliseDocNumber(String(r[ni] ?? '')) === wantNumber);
  }
  const fi = plan.columns.indexOf('fileName');
  const want = stripPdf(d.fileName);
  return rows.some((r) => stripPdf(String(r[fi] ?? '')) === want);
}

export interface BillsListTarget {
  filePath: string;
  table: string;
  plan: Extract<ColumnPlan, { ok: true }>;
}

export class BillsListError extends Error {}

export class BillsList {
  constructor(private readonly graph: GraphPort) {}

  /** Checks the workbook exists, has one usable table and recognisable columns. Writes nothing. */
  async check(drive: DriveRef, folder: string, cfg: { fileName: string; table?: string }): Promise<BillsListTarget> {
    const filePath = `${folder}/${cfg.fileName}`;
    if (!(await this.graph.getItem(drive, filePath))) {
      throw new BillsListError(`The Bills List file "${cfg.fileName}" was not found in "${folder}".`);
    }
    const tables = await this.graph.listTables(drive, filePath);
    let table = cfg.table;
    if (table) {
      if (!tables.includes(table)) throw new BillsListError(`"${cfg.fileName}" has no table named "${table}". Tables found: ${tables.join(', ') || 'none'}.`);
    } else if (tables.length === 1) {
      table = tables[0]!;
    } else if (tables.length === 0) {
      throw new BillsListError(`"${cfg.fileName}" has no Excel table, so rows cannot be added. In Excel, select the list including its header row and use Insert > Table (tick "My table has headers").`);
    } else {
      throw new BillsListError(`"${cfg.fileName}" has several tables (${tables.join(', ')}). Set billsList.table in the client mapping.`);
    }
    const headers = await this.graph.getTableHeaders(drive, filePath, table);
    const plan = planColumns(headers);
    if (!plan.ok) throw new BillsListError(`"${cfg.fileName}": ${plan.reason}`);
    return { filePath, table, plan };
  }

  /** True if this bill already has a row in the list. */
  async has(drive: DriveRef, target: BillsListTarget, d: BillsRowData): Promise<boolean> {
    return rowExists(target.plan, await this.graph.getTableRows(drive, target.filePath, target.table), d);
  }

  /**
   * Adds the bill unless it is already listed. Returns true if a row was added.
   * With highlight, the new row is coloured red. A failure to colour never fails the bill: the row is
   * already written, and the callback is told so it can be logged.
   */
  async addIfMissing(
    drive: DriveRef,
    target: BillsListTarget,
    d: BillsRowData,
    opts: { highlight?: boolean; onHighlightError?: (e: unknown) => void } = {},
  ): Promise<boolean> {
    const rows = await this.graph.getTableRows(drive, target.filePath, target.table);
    if (rowExists(target.plan, rows, d)) return false;
    await this.graph.appendTableRow(drive, target.filePath, target.table, buildRow(target.plan, d));
    if (opts.highlight) {
      try {
        await this.graph.highlightTableRow(drive, target.filePath, target.table, rows.length);
      } catch (e) {
        opts.onHighlightError?.(e);
      }
    }
    return true;
  }
}
