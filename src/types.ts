import { z } from 'zod';

// ---------------------------------------------------------------------------
// What Claude returns for one PDF (validated with zod before anything trusts it)
// ---------------------------------------------------------------------------

export const LineSchema = z.object({
  description: z.string(),
  quantity: z.number().nullable(),
  unit_price: z.number().nullable(),
  line_amount: z.number(),
  gst_applicable: z.boolean(),
});

export const BillSchema = z.object({
  bill_number: z.string().nullable(),
  issue_date_printed: z.string().nullable(),
  issue_date_iso: z.string().nullable(),
  due_date_printed: z.string().nullable(),
  due_date_iso: z.string().nullable(),
  due_on_receipt: z.boolean(),
  payment_terms_days: z.number().nullable(),
  currency: z.string().nullable(),
  line_amounts_include_gst: z.boolean(),
  lines: z.array(LineSchema),
  subtotal_ex_gst: z.number().nullable(),
  total_gst: z.number().nullable(),
  total_inc_gst: z.number().nullable(),
});

export const StatementSchema = z.object({
  statement_date_printed: z.string().nullable(),
  statement_date_iso: z.string().nullable(),
  statement_date_label: z.string().nullable(),
});

export const ExtractionSchema = z.object({
  document_heading: z.string(),
  document_type: z.enum(['bill', 'statement', 'credit_note', 'other']),
  confidence: z.enum(['high', 'medium', 'low']),
  invoice_count: z.number().int().min(0),
  supplier_name: z.string().nullable(),
  supplier_abn: z.string().nullable(),
  customer_name: z.string().nullable(),
  bill: BillSchema.nullable(),
  statement: StatementSchema.nullable(),
  notes: z.string().nullable(),
});

export type BillLine = z.infer<typeof LineSchema>;
export type BillData = z.infer<typeof BillSchema>;
export type StatementData = z.infer<typeof StatementSchema>;
export type Extraction = z.infer<typeof ExtractionSchema>;

export interface Extractor {
  extract(pdf: Buffer): Promise<Extraction>;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const ClientSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  /** A client that only uses a drop folder (no bookkeeping inbox) leaves senders and outlookFolder out. */
  senders: z.array(z.string().email()).default([]),
  outlookFolder: z.string().min(1).optional(),
  sharepoint: z.object({
    hostname: z.string().min(1),
    sitePath: z.string().min(1),
    library: z.string().default('Documents'),
    /** Folder templates. {FY} becomes the Australian financial-year folder (year the FY ends, e.g. 2027 for Jul 2026 to Jun 2027). */
    billsFolder: z.string().min(1),
    statementsFolder: z.string().min(1),
    /** true = file inside the existing month folder (October, 10 Oct, ...) under the folder above. Folders are never created. */
    monthFolders: z.boolean().default(false),
    /** Excel list in the billsFolder (year level) that gets one row per bill. */
    /**
     * Optional drop folder. A PDF saved here is processed like an emailed one (the folder decides the client).
     * Two subfolders must already exist inside it: "Processed" (filed originals) and "Needs Review".
     */
    dropFolder: z.string().min(1).optional(),
    billsList: z.object({ fileName: z.string().default('Bills List.xlsx'), table: z.string().optional() }).optional(),
  }),
  xero: z.object({
    tenantId: z.string().uuid(),
    defaultAccountCode: z.string().default(''),
    taxTypeWithGst: z.string().default('INPUT'),
    taxTypeNoGst: z.string().default('EXEMPTEXPENSES'),
  }),
});

export const ClientsFileSchema = z.object({
  clients: z.array(ClientSchema).min(1),
  rules: z
    .object({
      extraBillHeadings: z.array(z.string()).default([]),
      extraStatementHeadings: z.array(z.string()).default([]),
      extraCreditHeadings: z.array(z.string()).default([]),
      /** Suppliers (part of the name) whose invoices print no invoice date: the ORDER DATE is used as the issue date. */
      orderDateSuppliers: z.array(z.string()).default([]),
      /** Suppliers (part of the name) whose invoices carry no invoice number: the "Payment Ref" is used as the bill number and the "Statement Date" as the issue date. */
      paymentRefSuppliers: z.array(z.string()).default([]),
      /** Currencies entered as if they were AUD (amounts as printed, no GST, flagged for a person to convert). */
      foreignCurrencyAsAud: z.array(z.string()).default([]),
    })
    .default({ extraBillHeadings: [], extraStatementHeadings: [], extraCreditHeadings: [], orderDateSuppliers: [], paymentRefSuppliers: [], foreignCurrencyAsAud: [] }),
  allowedCurrencies: z.array(z.string()).default(['AUD']),
  log: z
    .object({
      hostname: z.string(),
      sitePath: z.string(),
      library: z.string().default('Documents'),
      filePath: z.string(),
      table: z.string(),
    })
    .optional(),
});

export type ClientConfig = z.infer<typeof ClientSchema>;
export type ClientsFile = z.infer<typeof ClientsFileSchema>;

export type DocKind = 'bill' | 'statement' | 'credit';
