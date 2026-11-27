/**
 * Creates "Bookkeeping Log.xlsx" with the Excel table the service appends to.
 * Upload it to the SharePoint path set in the client mapping (log.filePath), then staff can
 * see every email the system filed or stopped on.
 *
 *   npm run make-log-template
 */
import ExcelJS from 'exceljs';
import { LEDGER_COLUMNS } from '../ops.js';

const TABLE = process.env.LOG_TABLE_NAME?.trim() || 'BookkeepingLog';

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('Log');
ws.addTable({
  name: TABLE,
  ref: 'A1',
  headerRow: true,
  style: { theme: 'TableStyleMedium2', showRowStripes: true },
  columns: LEDGER_COLUMNS.map((name) => ({ name, filterButton: true })),
  rows: [['Log created', '', 'Template', '', '', '', '', '', '', '', '', 'You can delete this row']],
});
const widths = [20, 24, 28, 14, 30, 18, 14, 14, 52, 40, 40, 60];
widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));
ws.views = [{ state: 'frozen', ySplit: 1 }];

await wb.xlsx.writeFile('Bookkeeping Log.xlsx');
console.log(`Wrote "Bookkeeping Log.xlsx" with table "${TABLE}". Upload it to SharePoint at the path in your client mapping.`);
