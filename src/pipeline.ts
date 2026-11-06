import type { ClientConfig, DocKind, Extraction, Extractor } from './types.js';
import { GraphError, type DriveItem, type DriveRef, type GraphPort, type MailAttachment, type MailMessage } from './graph.js';
import { XeroAuthError, XeroConfigError, XeroError, type XeroPort } from './xero.js';
import { decideType, type HeadingRules } from './classify.js';
import { readPdfText, type PdfText } from './pdftext.js';
import { compareBillPasses, compareStatementPasses, validateBill, validateStatement } from './validate.js';
import { billFileName, statementFileName, withSuffix } from './naming.js';
import { buildDraftLines, expectedXeroTotals } from './billmap.js';
import { errMsg, type Logger } from './logger.js';
import { moneyFmt, near, properName, sha256, todayIso } from './util.js';
import { expandFolder, financialYear, monthOf, pickMonthFolder } from './folders.js';
import { BillsList, BillsListError, type BillsListTarget } from './billslist.js';

/** Draft bills whose supplier could not be matched in Xero are created under this contact, to be changed by staff. */
export const UNCONFIRMED_CONTACT = 'Unconfirmed Supplier - choose the correct contact';

/** Outlook categories double as the service's memory: no database needed. Remove one to re-run an email. */
export const CAT = {
  review: 'BK Review',
  left: 'BK Left In Inbox',
  partial: 'BK Partial',
  error: 'BK Error',
} as const;
const ALL_CATS = new Set<string>(Object.values(CAT));

/** Problems that affect every email (bad folder name, expired Xero login). Not the email's fault, so it is not tagged. */
export class SystemicError extends Error {}

export interface Alerter {
  alert(subject: string, body: string, dedupeKey?: string): Promise<void>;
}

export interface LedgerRow {
  when: string;
  client: string;
  outcome: string;
  docType: string;
  supplier: string;
  number: string;
  docDate: string;
  total: string;
  file: string;
  xeroLink: string;
  emailSubject: string;
  notes: string;
}
export interface Ledger {
  add(row: LedgerRow): Promise<void>;
}

export interface PipelineConfig {
  dryRun: boolean;
  passes: number;
  allowedCurrencies: string[];
  contactFuzzyPolicy: 'review' | 'create';
  createMissingContacts: boolean;
  blockOnDmarcFail: boolean;
  clients: ClientConfig[];
}

export interface PipelineDeps {
  cfg: PipelineConfig;
  graph: GraphPort;
  xero: XeroPort;
  extractor: Extractor;
  rules: HeadingRules;
  log: Logger;
  alerter: Alerter;
  ledger: Ledger;
  now?: () => Date;
}

type ItemResult =
  | { kind: 'saved'; doc: DocKind; fileName: string; note?: string; ledger: Omit<LedgerRow, 'when' | 'client' | 'outcome' | 'emailSubject'> }
  | { kind: 'planned'; doc: DocKind; fileName: string; note: string }
  | { kind: 'other'; reason: string }
  | { kind: 'review'; reasons: string[]; ledger?: Partial<LedgerRow> };

export type MessageStatus = 'ignored' | 'left_no_pdf' | 'left_unrecognised' | 'review' | 'moved' | 'partial' | 'dry_run';

export interface MessageOutcome {
  status: MessageStatus;
  detail: string[];
}

const XERO_LINK = (id: string) => `https://go.xero.com/AccountsPayable/Edit.aspx?InvoiceID=${id}`;

export class Pipeline {
  private bySender = new Map<string, ClientConfig>();
  /** Bills this process has already started for a given email and PDF, so a retry of the same email completes instead of being called a duplicate. */
  private touched = new Set<string>();
  private targetCache = new Map<string, { at: number; drive: DriveRef; folderId: string }>();
  private readonly billsList: BillsList;

  constructor(private readonly d: PipelineDeps) {
    this.billsList = new BillsList(d.graph);
    for (const c of d.cfg.clients) for (const s of c.senders) this.bySender.set(s.toLowerCase(), c);
  }

  private now(): Date {
    return this.d.now ? this.d.now() : new Date();
  }

  clientFor(msg: MailMessage): ClientConfig | null {
    const addr = msg.from?.emailAddress?.address?.trim().toLowerCase();
    return addr ? (this.bySender.get(addr) ?? null) : null;
  }

  static alreadyHandled(msg: MailMessage): boolean {
    return msg.categories.some((c) => ALL_CATS.has(c));
  }

  // -------------------------------------------------------------------------
  // One email
  // -------------------------------------------------------------------------

  async processMessage(msg: MailMessage): Promise<MessageOutcome> {
    const { graph, log, cfg } = this.d;
    const client = this.clientFor(msg);
    if (!client) return { status: 'ignored', detail: ['Sender is not one of the configured clients.'] };
    if (Pipeline.alreadyHandled(msg)) return { status: 'ignored', detail: ['Already tagged.'] };

    const mlog = { client: client.key, messageId: msg.id, subject: msg.subject ?? '' };
    log.info('Processing email', mlog);

    // Fail early, before any writes, if the destination is wrong.
    const target = await this.ensureTargets(client);

    // Spoofed "client" mail must never reach the books.
    if (cfg.blockOnDmarcFail) {
      const auth = await graph.getAuthenticationResults(msg.id);
      if (/dmarc\s*=\s*fail/i.test(auth)) {
        return this.finishReview(client, msg, [['Sender authentication failed (DMARC). The email may not really be from the client.']], [], true);
      }
    }

    const atts = await graph.listAttachments(msg.id);
    const pdfs = atts.filter(isPdfCandidate);
    const attachedEmails = atts.filter((a) => a.odataType.includes('itemAttachment'));

    if (pdfs.length === 0) {
      if (attachedEmails.length > 0) {
        return this.finishReview(client, msg, [['The email has an attached email (not a PDF). Forwarding "as attachment" is not supported; please forward normally or handle manually.']], [], true);
      }
      return this.finishLeft(client, msg, 'left_no_pdf', 'No PDF attached.');
    }

    const results: ItemResult[] = [];
    const seen = new Set<string>();
    for (const att of pdfs) {
      const buf = await graph.downloadAttachment(msg.id, att.id);
      if (buf.length < 100 || buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
        results.push({ kind: 'review', reasons: [`"${att.name}" is named like a PDF but is not a readable PDF file.`] });
        continue;
      }
      const hash = sha256(buf);
      if (seen.has(hash)) continue; // same PDF attached twice
      seen.add(hash);
      if (buf.length > 30 * 1024 * 1024) {
        results.push({ kind: 'review', reasons: [`"${att.name}" is larger than 30 MB.`] });
        continue;
      }
      results.push(await this.processPdf(client, msg, att, buf, hash, target));
    }

    // ----- decide what happens to the email -----
    const reviews = results.filter((r): r is Extract<ItemResult, { kind: 'review' }> => r.kind === 'review');
    const saved = results.filter((r) => r.kind === 'saved');
    const planned = results.filter((r) => r.kind === 'planned');
    const others = results.filter((r) => r.kind === 'other');

    if (reviews.length > 0) {
      if (!cfg.dryRun) {
        for (const s of saved) if (s.kind === 'saved') await this.writeLedger(client, msg, 'Saved; email left in inbox (another PDF needs review)', s.ledger);
        for (const r of reviews) await this.writeLedger(client, msg, 'Needs review', { ...r.ledger, notes: r.reasons.join(' | ') });
      }
      return this.finishReview(client, msg, reviews.map((r) => r.reasons), saved.map((s) => (s.kind === 'saved' ? s.fileName : '')), false);
    }
    if (cfg.dryRun) {
      const lines = [...planned.map((p) => `Would save "${p.fileName}". ${p.note}`), ...others.map((o) => `Would leave in inbox: ${o.reason}`)];
      log.info(`Dry run result: ${lines.join(' | ')}`, { ...mlog, lines });
      return { status: 'dry_run', detail: lines };
    }
    if (saved.length > 0 && others.length === 0) {
      await graph.moveMessage(msg.id, target.folderId);
      for (const s of saved) if (s.kind === 'saved') await this.writeLedger(client, msg, 'Saved and filed', s.ledger);
      log.info('Email filed', { ...mlog, files: saved.map((s) => (s.kind === 'saved' ? s.fileName : '')) });
      return { status: 'moved', detail: saved.map((s) => (s.kind === 'saved' ? `${s.fileName}${s.note ? ` (${s.note})` : ''}` : '')) };
    }
    if (saved.length > 0) {
      await graph.setCategories(msg.id, [...msg.categories, CAT.partial]);
      for (const s of saved) if (s.kind === 'saved') await this.writeLedger(client, msg, 'Saved; email left in inbox (also had an unrecognised PDF)', s.ledger);
      return { status: 'partial', detail: ['Some PDFs were saved, but the email also had a PDF that is not a bill or statement, so it stays in the inbox.'] };
    }
    return this.finishLeft(client, msg, 'left_unrecognised', others.map((o) => (o.kind === 'other' ? o.reason : '')).join(' '));
  }

  // -------------------------------------------------------------------------
  // One PDF
  // -------------------------------------------------------------------------

  private async processPdf(
    client: ClientConfig,
    msg: MailMessage,
    att: MailAttachment,
    buf: Buffer,
    hash: string,
    target: { drive: DriveRef },
  ): Promise<ItemResult> {
    const { extractor, rules, cfg, log } = this.d;
    const plog = { client: client.key, messageId: msg.id, attachment: att.name };

    let text: PdfText | null = null;
    try {
      text = await readPdfText(buf);
    } catch (e) {
      log.warn('Could not read PDF text layer, relying on Claude only', { ...plog, error: errMsg(e) });
    }
    if (text && text.pageCount > 100) return { kind: 'review', reasons: [`"${att.name}" has ${text.pageCount} pages (over 100).`] };

    const first = await extractor.extract(buf);
    const decision = decideType(text, first, rules);
    if (decision.kind === 'other') {
      log.info('PDF is not a bill or statement', { ...plog, heading: first.document_heading });
      return { kind: 'other', reason: `"${att.name}": ${decision.reason}` };
    }
    if (decision.kind === 'review') return { kind: 'review', reasons: decision.reasons.map((r) => `"${att.name}": ${r}`) };

    const kind: DocKind = decision.kind;
    if (kind === 'bill' && first.invoice_count > 1) {
      return { kind: 'review', reasons: [`"${att.name}": this PDF appears to contain ${first.invoice_count} separate invoices. It was not filed automatically, so each bill can be handled on its own.`] };
    }
    const passes: Extraction[] = [first];
    for (let i = 1; i < cfg.passes; i++) passes.push(await extractor.extract(buf));
    for (const p of passes.slice(1)) {
      const diffs = [
        ...(p.document_type !== kind ? [`document type (${kind} vs ${p.document_type})`] : []),
        ...(kind === 'bill' ? compareBillPasses(first, p) : compareStatementPasses(first, p)),
      ];
      if (diffs.length > 0) {
        return { kind: 'review', reasons: [`"${att.name}": two independent readings of the PDF disagree on ${diffs.join(', ')}.`] };
      }
    }

    const ctx = { today: todayIso(this.now()), allowedCurrencies: cfg.allowedCurrencies };
    const supplier = properName(first.supplier_name!);
    const scanned = !text || !text.hasText;

    // ----------------------------- statements -----------------------------
    if (kind === 'statement') {
      const v = validateStatement(first, ctx);
      if (v.issues.length > 0 || !v.asAt) return { kind: 'review', reasons: v.issues.map((i) => `"${att.name}": ${i}`) };
      const fileName = statementFileName(supplier, v.asAt);
      const loc = await this.resolveFolder(client, 'statement', v.asAt, target.drive);
      if (!loc.ok) return { kind: 'review', reasons: [`"${att.name}": ${loc.reason}`], ledger: { docType: 'Statement', supplier, docDate: v.asAt } };
      if (cfg.dryRun) return { kind: 'planned', doc: 'statement', fileName, note: `Statement from ${supplier} as at ${v.asAt} into ${loc.folder}.` };

      const saved = await this.saveUnique(target.drive, loc.folder, fileName, buf, hash);
      return {
        kind: 'saved',
        doc: 'statement',
        fileName: saved.fileName,
        note: saved.status === 'already_present' ? 'already in SharePoint' : undefined,
        ledger: { docType: 'Statement', supplier, number: '', docDate: v.asAt, total: '', file: saved.fileName, xeroLink: '', notes: saved.status === 'already_present' ? 'Identical file already in SharePoint' : '' },
      };
    }

    // ------------------------------- bills --------------------------------
    const v = validateBill(first, ctx);
    if (v.issues.length > 0 || !v.resolved || !first.bill) {
      return { kind: 'review', reasons: v.issues.map((i) => `"${att.name}": ${i}`), ledger: { docType: 'Bill', supplier, number: first.bill?.bill_number ?? '' } };
    }
    const bill = first.bill;
    const resolved = v.resolved;
    const billNumber = bill.bill_number!.trim();
    const fileName = billFileName(resolved.issueDate, supplier, billNumber);

    const loc = await this.resolveFolder(client, 'bill', resolved.issueDate, target.drive);
    if (!loc.ok) return { kind: 'review', reasons: [`"${att.name}": ${loc.reason}`], ledger: { docType: 'Supplier bill', supplier, number: billNumber, docDate: resolved.issueDate } };
    const list = await this.checkBillsList(client, target.drive, loc.base);

    if (cfg.dryRun) {
      const blocked = await this.guardXero<null>(async () => {
        await this.d.xero.ensureOrgReady(client);
        return null;
      });
      if (blocked) return blocked;
      return {
        kind: 'planned',
        doc: 'bill',
        fileName,
        note: `Draft bill ${billNumber} for ${supplier}, issued ${resolved.issueDate}, due ${resolved.dueDate ?? 'not stated'}, GST ${moneyFmt(resolved.totalGst)}, total ${moneyFmt(resolved.totalIncGst)}, ${bill.lines.length} line(s), into ${loc.folder}${list ? `, one row added to ${list.filePath.split('/').pop()}` : ''}.`,
      };
    }

    // Save to SharePoint first, so the source document is safe whatever happens in Xero.
    const saved = await this.saveUnique(target.drive, loc.folder, fileName, buf, hash);
    const ledgerBase = { docType: 'Supplier bill', supplier, number: billNumber, docDate: resolved.issueDate, total: moneyFmt(resolved.totalIncGst), file: saved.fileName };

    const touchKey = `${msg.id}|${hash}`;
    const mine = this.touched.has(touchKey);
    const billDesc = `${supplier} bill ${billNumber} (${resolved.issueDate}, total ${moneyFmt(resolved.totalIncGst)})`;
    const duplicate = (where: string, xeroLink = ''): ItemResult => ({
      kind: 'review',
      reasons: [
        `"${att.name}": DUPLICATE BILL. ${billDesc} has already been processed: ${where}.${saved.status === 'created_with_suffix' ? ` This email carries a different PDF of it, saved only as "${saved.fileName}".` : ''} Nothing new was added (no Bills List row, no Xero draft). The email was left in the inbox. If it is not really a duplicate, remove the BK Review category to try again.`,
      ],
      ledger: { ...ledgerBase, ...(xeroLink ? { xeroLink } : {}) },
    });

    // The Bills List row is written last, so a row means this bill went all the way through before.
    const rowData = (extraNote = '') => ({
      supplier,
      billNumber,
      issueDate: resolved.issueDate,
      dueDate: resolved.dueDate,
      exGst: resolved.subtotalExGst,
      gst: resolved.totalGst,
      total: resolved.totalIncGst,
      fileName: saved.fileName,
      notes: [scanned ? 'Scanned copy, check carefully' : '', extraNote].filter(Boolean).join('. '),
    });
    if (!mine) {
      if (saved.status === 'created_with_suffix') return duplicate(`the same bill is already filed in SharePoint under another PDF`);
      if (list && (await this.billsList.has(target.drive, list, rowData()))) return duplicate('it is already in the Bills List');
    }

    // Safe to repeat: a bill already listed is not added twice.
    const addListRow = async (extraNote = ''): Promise<void> => {
      if (!list) return;
      await this.billsList.addIfMissing(target.drive, list, rowData(extraNote), {
        highlight: scanned,
        onHighlightError: (e) => log.warn('Bills List row added but could not be coloured', { ...plog, error: errMsg(e) }),
      });
    };

    return this.guardXero(async () => {
      await this.d.xero.ensureOrgReady(client);
      const tenant = client.xero.tenantId;

      const resolved0 = await this.d.xero.resolveContact(tenant, supplier, first.supplier_abn, {
        fuzzyPolicy: cfg.contactFuzzyPolicy,
        createMissing: cfg.createMissingContacts,
      });
      // When the supplier cannot be matched with certainty, the draft is created under a placeholder contact instead of
      // stopping everything. The real supplier name stays in the file name, the Bills List and the Xero Reference field.
      let unconfirmed: string | null = null;
      let reference: string | undefined;
      let contact = resolved0;
      if (!resolved0.ok) {
        const ph = await this.d.xero.resolveContact(tenant, UNCONFIRMED_CONTACT, null, { fuzzyPolicy: 'create', createMissing: true });
        if (!ph.ok) {
          return { kind: 'review', reasons: [`"${att.name}": ${resolved0.reason} The placeholder contact could not be used either: ${ph.reason} (the PDF is saved as "${saved.fileName}").`], ledger: { ...ledgerBase, file: saved.fileName } };
        }
        contact = ph;
        unconfirmed = resolved0.reason;
        reference = `CHECK SUPPLIER: ${supplier}`;
      }
      if (!contact.ok) throw new Error('unreachable');
      const unconfirmedNote = unconfirmed ? `Xero supplier not confirmed: draft is under "${UNCONFIRMED_CONTACT}" (${unconfirmed})` : '';

      const existing = await this.d.xero.findBill(tenant, contact.contact.contactId, billNumber, reference);
      if (!mine) {
        // A completed earlier run attached the PDF. A draft without it is an interrupted run that is safe to finish.
        if (existing && (await this.d.xero.hasAttachment(tenant, existing.invoiceId, saved.fileName))) {
          return duplicate(`Xero already has it for ${contact.contact.name} (${existing.status})`, XERO_LINK(existing.invoiceId));
        }
        // The same number with the same total under any other supplier (entered by hand, or under the placeholder).
        const others = (await this.d.xero.findBillsByNumber(tenant, billNumber)).filter((x) => x.invoiceId !== existing?.invoiceId && near(x.total, resolved.totalIncGst, 0.02));
        if (others.length > 0) {
          return duplicate(`Xero already has bill ${billNumber} for the same total (${others.length > 1 ? `${others.length} bills, first status ${others[0]!.status}` : others[0]!.status})`, XERO_LINK(others[0]!.invoiceId));
        }
        if (existing && existing.status !== 'DRAFT') {
          return duplicate(`Xero already has it for ${contact.contact.name} (${existing.status})`, XERO_LINK(existing.invoiceId));
        }
      }
      if (existing) {
        this.touched.add(touchKey);
        if (!(await this.d.xero.hasAttachment(tenant, existing.invoiceId, saved.fileName))) {
          await this.d.xero.uploadAttachment(tenant, existing.invoiceId, saved.fileName, buf);
        }
        await addListRow(unconfirmed ? 'Xero supplier to be confirmed' : '');
        return {
          kind: 'saved',
          doc: 'bill',
          fileName: saved.fileName,
          note: `bill already in Xero as ${existing.status}`,
          ledger: { ...ledgerBase, xeroLink: XERO_LINK(existing.invoiceId), notes: `Finished an interrupted earlier run; Xero already had the draft (${existing.status})` },
        };
      }

      const accountCode = contact.contact.purchasesDefaultAccountCode || client.xero.defaultAccountCode || undefined;
      const lines = buildDraftLines(bill, resolved, { withGst: client.xero.taxTypeWithGst, noGst: client.xero.taxTypeNoGst }, accountCode);
      const expected = expectedXeroTotals(lines, resolved.amountsIncludeGst);
      const idKey = sha256(Buffer.from(`${client.key}|${msg.id}|${hash}|${ctx.today}`));

      const created = await this.d.xero.createDraftBill(
        tenant,
        {
          contactId: contact.contact.contactId,
          issueDate: resolved.issueDate,
          dueDate: resolved.dueDate,
          invoiceNumber: billNumber,
          currency: resolved.currency,
          amountsIncludeGst: resolved.amountsIncludeGst,
          lines,
          expectedTotal: expected.total,
          expectedGst: expected.gst,
          reference,
        },
        idKey,
      );
      this.touched.add(touchKey);
      await this.d.xero.uploadAttachment(tenant, created.invoiceId, saved.fileName, buf);

      const link = XERO_LINK(created.invoiceId);
      // Confirm what Xero holds equals what the PDF says.
      if (!near(created.total, resolved.totalIncGst, 0.02) || !near(created.totalTax, resolved.totalGst, 0.02)) {
        return {
          kind: 'review',
          reasons: [
            `"${att.name}": the Xero draft was created but its totals differ from the PDF (Xero total ${moneyFmt(created.total)} GST ${moneyFmt(created.totalTax)}; PDF total ${moneyFmt(resolved.totalIncGst)} GST ${moneyFmt(resolved.totalGst)}). Please check the draft: ${link}`,
          ],
          ledger: { ...ledgerBase, xeroLink: link },
        };
      }
      await addListRow(unconfirmed ? 'Xero supplier to be confirmed' : '');
      return {
        kind: 'saved',
        doc: 'bill',
        fileName: saved.fileName,
        note: unconfirmed ? unconfirmedNote : contact.created ? `new Xero contact "${contact.contact.name}" created` : undefined,
        ledger: { ...ledgerBase, xeroLink: link, notes: unconfirmed ? unconfirmedNote : contact.created ? `New Xero contact created: ${contact.contact.name}` : '' },
      };
    });
  }

  // -------------------------------------------------------------------------
  // SharePoint
  // -------------------------------------------------------------------------

  private async ensureTargets(client: ClientConfig): Promise<{ drive: DriveRef; folderId: string }> {
    const cached = this.targetCache.get(client.key);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached;
    const sp = client.sharepoint;
    try {
      const drive = await this.d.graph.resolveDrive(sp.hostname, sp.sitePath, sp.library);
      const today = todayIso(this.now());
      for (const f of [expandFolder(sp.billsFolder, today), expandFolder(sp.statementsFolder, today)]) {
        if (!(await this.d.graph.folderExists(drive, f))) {
          throw new SystemicError(`SharePoint folder "${f}" does not exist for ${client.name}. Create it or fix the client mapping.`);
        }
      }
      const folderId = await this.d.graph.resolveMailFolder(client.outlookFolder);
      const entry = { at: Date.now(), drive, folderId };
      this.targetCache.set(client.key, entry);
      return entry;
    } catch (e) {
      if (e instanceof SystemicError) throw e;
      if (e instanceof GraphError && (e.status === 404 || e.status === 403 || e.status === 401 || e.code === 'FolderNotFound')) {
        throw new SystemicError(`Cannot reach the destinations for ${client.name}: ${e.message}`);
      }
      throw e;
    }
  }

  /** Year folder from the financial year, then (if enabled) the existing month folder. Never creates anything. */
  private async resolveFolder(
    client: ClientConfig,
    kind: DocKind,
    dateIso: string,
    drive: DriveRef,
  ): Promise<{ ok: true; base: string; folder: string } | { ok: false; reason: string }> {
    const sp = client.sharepoint;
    const base = expandFolder(kind === 'bill' ? sp.billsFolder : sp.statementsFolder, dateIso);
    if (!(await this.d.graph.folderExists(drive, base))) {
      return { ok: false, reason: `The folder "${base}" does not exist (financial year ${financialYear(dateIso)} for ${dateIso}). Create it, then remove the "BK Review" category to retry.` };
    }
    if (!sp.monthFolders) return { ok: true, base, folder: base };
    const names = await this.d.graph.listChildFolders(drive, base);
    const pick = pickMonthFolder(names, monthOf(dateIso), base);
    return pick.ok ? { ok: true, base, folder: `${base}/${pick.name}` } : { ok: false, reason: pick.reason };
  }

  private async checkBillsList(client: ClientConfig, drive: DriveRef, base: string): Promise<BillsListTarget | null> {
    const cfg = client.sharepoint.billsList;
    if (!cfg) return null;
    try {
      return await this.billsList.check(drive, base, { fileName: cfg.fileName, table: cfg.table });
    } catch (e) {
      if (e instanceof BillsListError) throw new SystemicError(`Bills List for ${client.name}: ${e.message}`);
      throw e;
    }
  }

  /**
   * Saves under the final file name. Identical content already there = resume/duplicate (no-op).
   * Different content with the same name = keep both, "(2)" suffix. Never overwrites.
   */
  private async saveUnique(
    drive: DriveRef,
    folder: string,
    fileName: string,
    buf: Buffer,
    hash: string,
  ): Promise<{ fileName: string; item: DriveItem; status: 'created' | 'created_with_suffix' | 'already_present' }> {
    const g = this.d.graph;
    for (let n = 1; n <= 9; n++) {
      const candidate = n === 1 ? fileName : withSuffix(fileName, n);
      const existing = await g.getItem(drive, `${folder}/${candidate}`);
      if (!existing) {
        try {
          const item = await g.uploadNew(drive, folder, candidate, buf);
          return { fileName: candidate, item, status: n === 1 ? 'created' : 'created_with_suffix' };
        } catch (e) {
          if (e instanceof GraphError && e.status === 409) continue; // lost a race, try the next name
          throw e;
        }
      }
      if (existing.size === buf.length && sha256(await g.downloadItem(drive, existing.id)) === hash) {
        return { fileName: candidate, item: existing, status: 'already_present' };
      }
    }
    throw new Error(`Too many different files already named like "${fileName}".`);
  }

  private async guardXero<T>(fn: () => Promise<T>): Promise<T | ItemResult> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof XeroAuthError || e instanceof XeroConfigError) throw new SystemicError(e.message);
      if (e instanceof XeroError && (e.status === 401 || e.status === 403)) {
        throw new SystemicError(`Xero refused access (${e.status}). Check the app's scopes and that it is authorised for this organisation. ${e.message}`);
      }
      if (e instanceof XeroError && !e.retryable) {
        return { kind: 'review', reasons: [e.message] } satisfies ItemResult;
      }
      throw e;
    }
  }

  // -------------------------------------------------------------------------
  // Endings
  // -------------------------------------------------------------------------

  private async finishLeft(client: ClientConfig, msg: MailMessage, status: 'left_no_pdf' | 'left_unrecognised', why: string): Promise<MessageOutcome> {
    if (!this.d.cfg.dryRun) await this.d.graph.setCategories(msg.id, [...msg.categories, CAT.left]);
    this.d.log.info('Left in inbox', { client: client.key, messageId: msg.id, why });
    return { status, detail: [why] };
  }

  private async finishReview(client: ClientConfig, msg: MailMessage, reasonGroups: string[][], savedFiles: string[], logRow: boolean): Promise<MessageOutcome> {
    const reasons = reasonGroups.flat();
    this.d.log.warn('Needs review', { client: client.key, messageId: msg.id, reasons });
    if (this.d.cfg.dryRun) return { status: 'review', detail: reasons };

    await this.d.graph.setCategories(msg.id, [...msg.categories, CAT.review]);
    if (logRow) await this.writeLedger(client, msg, 'Needs review', { notes: reasons.join(' | ') });
    await this.d.alerter.alert(
      `Bookkeeping: email needs a look (${client.name})`,
      [
        `Client: ${client.name}`,
        `Email: ${msg.subject ?? '(no subject)'}`,
        `Received: ${msg.receivedDateTime}`,
        '',
        'Why it was not filed automatically:',
        ...reasons.map((r) => `- ${r}`),
        ...(savedFiles.filter(Boolean).length ? ['', `Already saved to SharePoint: ${savedFiles.filter(Boolean).join(', ')}`] : []),
        '',
        `The email is still in the ${this.d.cfg.dryRun ? '' : 'Inbox, tagged "BK Review". '}Handle it manually. To have the system try again, remove the "BK Review" category from the email.`,
      ].join('\n'),
      `review:${msg.id}`,
    );
    return { status: 'review', detail: reasons };
  }

  private async writeLedger(client: ClientConfig, msg: MailMessage, outcome: string, fields: Partial<LedgerRow>): Promise<void> {
    try {
      await this.d.ledger.add({
        when: new Date(this.now()).toLocaleString('en-AU', { timeZone: 'Australia/Melbourne', hour12: false }),
        client: client.name,
        outcome,
        docType: '',
        supplier: '',
        number: '',
        docDate: '',
        total: '',
        file: '',
        xeroLink: '',
        notes: '',
        ...fields,
        emailSubject: msg.subject ?? '',
      });
    } catch (e) {
      this.d.log.warn('Could not write to the log workbook', { error: errMsg(e) });
    }
  }
}

function isPdfCandidate(a: MailAttachment): boolean {
  if (!a.odataType.includes('fileAttachment') && a.odataType !== '') return false;
  return /pdf/i.test(a.contentType) || /\.pdf$/i.test(a.name);
}
