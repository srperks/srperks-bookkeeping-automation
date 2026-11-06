import type { GraphPort } from './graph.js';
import type { Alerter, Ledger, LedgerRow } from './pipeline.js';
import type { Logger } from './logger.js';
import { errMsg } from './logger.js';
import type { ClientsFile } from './types.js';

/** Sends alert emails from the bookkeeping mailbox. Repeats of the same alert are throttled. */
export class MailAlerter implements Alerter {
  private last = new Map<string, number>();

  constructor(
    private readonly graph: GraphPort,
    private readonly to: string[],
    private readonly log: Logger,
    private readonly dryRun: boolean,
    private readonly cooldownMs = 6 * 3600_000,
  ) {}

  async alert(subject: string, body: string, dedupeKey?: string): Promise<void> {
    const key = dedupeKey ?? subject;
    const prev = this.last.get(key);
    if (prev && Date.now() - prev < this.cooldownMs) return;
    this.last.set(key, Date.now());
    this.log.warn('ALERT', { subject, body });
    if (this.dryRun || this.to.length === 0) return;
    try {
      await this.graph.sendMail(this.to, subject, body);
    } catch (e) {
      this.log.error('Alert email failed to send', { error: errMsg(e) });
    }
  }
}

export const nullLedger: Ledger = { async add() {} };

/** Appends one row per processed document to an Excel table in SharePoint, so staff can see what happened. */
export class ExcelLedger implements Ledger {
  constructor(
    private readonly graph: GraphPort,
    private readonly cfg: NonNullable<ClientsFile['log']>,
  ) {}

  async add(r: LedgerRow): Promise<void> {
    const drive = await this.graph.resolveDrive(this.cfg.hostname, this.cfg.sitePath, this.cfg.library);
    await this.graph.appendTableRow(drive, this.cfg.filePath, this.cfg.table, ledgerValues(r));
  }
}

export const LEDGER_COLUMNS = [
  'When (Melbourne)',
  'Client',
  'Outcome',
  'Document',
  'Supplier',
  'Number',
  'Document date',
  'Total inc GST',
  'File',
  'Xero draft',
  'Email subject',
  'Notes',
] as const;

export function ledgerValues(r: LedgerRow): string[] {
  return [r.when, r.client, r.outcome, r.docType, r.supplier, r.number, r.docDate, r.total, r.file, r.xeroLink, r.emailSubject, r.notes];
}
