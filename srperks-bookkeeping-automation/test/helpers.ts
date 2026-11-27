import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { Extraction } from '../src/types.js';

export interface PdfLine {
  text: string;
  x?: number;
  y: number;
  size?: number;
}

/** Builds a one-page PDF with text at the given positions (top-left origin helper: y measured from top). */
export async function makePdf(lines: PdfLine[], extraPages = 0): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  for (const l of lines) {
    page.drawText(l.text, { x: l.x ?? 40, y: 842 - l.y, size: l.size ?? 12, font });
  }
  for (let i = 0; i < extraPages; i++) doc.addPage([595, 842]).drawText(`Page ${i + 2}`, { x: 40, y: 800, size: 10, font });
  return Buffer.from(await doc.save());
}

export function billExtraction(over: Partial<Extraction> = {}): Extraction {
  return {
    document_heading: 'TAX INVOICE',
    document_type: 'bill',
    confidence: 'high',
    invoice_count: 1,
    supplier_name: 'Acme Foods Pty Ltd',
    supplier_abn: '12 345 678 901',
    customer_name: 'Hopper Joint Melbourne',
    bill: {
      bill_number: 'INV-1042',
      issue_date_printed: '12/10/2026',
      issue_date_iso: '2026-10-12',
      due_date_printed: '26/10/2026',
      due_date_iso: '2026-10-26',
      due_on_receipt: false,
      payment_terms_days: null,
      currency: 'AUD',
      line_amounts_include_gst: false,
      lines: [
        { description: 'Burger buns x 20', quantity: 20, unit_price: 5, line_amount: 100, gst_applicable: true },
        { description: 'Fresh produce', quantity: 1, unit_price: 50, line_amount: 50, gst_applicable: false },
      ],
      subtotal_ex_gst: 150,
      total_gst: 10,
      total_inc_gst: 160,
    },
    statement: null,
    notes: null,
    ...over,
  };
}

export function statementExtraction(over: Partial<Extraction> = {}): Extraction {
  return {
    document_heading: 'Statement',
    document_type: 'statement',
    confidence: 'high',
    invoice_count: 0,
    supplier_name: 'Acme Foods Pty Ltd',
    supplier_abn: null,
    customer_name: 'Hopper Joint Melbourne',
    bill: null,
    statement: { statement_date_printed: '31/10/2026', statement_date_iso: '2026-10-31', statement_date_label: 'Statement Date' },
    notes: null,
    ...over,
  };
}
