import { formatDateParts, sanitiseFilePart } from './util.js';

/**
 * Supplier Bills:  <Issue Date DD MM YYYY> - <Supplier Name> - <Supplier Bill Number>.pdf
 * Statements:      <Supplier Name> - <Statement As At Date YYYY MM DD>.pdf
 */
export function billFileName(issueDateIso: string, supplierName: string, billNumber: string): string {
  const supplier = sanitiseFilePart(supplierName, 80) || 'Unknown Supplier';
  const number = sanitiseFilePart(billNumber, 50) || 'No Number';
  const [y, m, d] = issueDateIso.split('-');
  return `${d} ${m} ${y} - ${supplier} - ${number}.pdf`;
}

export function statementFileName(supplierName: string, asAtIso: string): string {
  const supplier = sanitiseFilePart(supplierName, 100) || 'Unknown Supplier';
  return `${supplier} - ${formatDateParts(asAtIso)}.pdf`;
}

/** "name.pdf" -> "name (2).pdf" */
export function withSuffix(fileName: string, n: number): string {
  return fileName.replace(/\.pdf$/i, ` (${n}).pdf`);
}
