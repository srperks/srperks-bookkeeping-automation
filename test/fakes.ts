import { GraphError, type DriveItem, type DriveRef, type GraphPort, type MailAttachment, type MailMessage } from '../src/graph.js';
import { XeroError, type ContactResolution, type XeroBill, type XeroContact, type XeroPort } from '../src/xero.js';
import type { DraftBillInput } from '../src/billmap.js';
import { ClientSchema, type ClientConfig, type Extraction, type Extractor } from '../src/types.js';
import type { Alerter, Ledger, LedgerRow } from '../src/pipeline.js';
import { normaliseBusinessName, normaliseDocNumber, nameSimilarity, sha256 } from '../src/util.js';

export const HOPPER_TENANT = '11111111-1111-4111-8111-111111111111';
export const HARCOURTS_TENANT = '22222222-2222-4222-8222-222222222222';

export const clients: ClientConfig[] = [
  ClientSchema.parse({
    key: 'hopper',
    name: 'Hopper Joint Melbourne',
    senders: ['accounts@hopperjointmelbourne.com.au'],
    outlookFolder: 'Inbox/Hopper Joint',
    sharepoint: { hostname: 'x.sharepoint.com', sitePath: '/sites/B', library: 'Documents', billsFolder: 'Hopper/Bills', statementsFolder: 'Hopper/Statements' },
    xero: { tenantId: HOPPER_TENANT, defaultAccountCode: '300' },
  }),
  ClientSchema.parse({
    key: 'harcourts',
    name: 'Harcourts Cafe',
    senders: ['accounts@harcourtscafe.com.au'],
    outlookFolder: 'Inbox/Harcourts Cafe',
    sharepoint: { hostname: 'x.sharepoint.com', sitePath: '/sites/B', library: 'Documents', billsFolder: 'Harcourts/Bills', statementsFolder: 'Harcourts/Statements' },
    xero: { tenantId: HARCOURTS_TENANT },
  }),
];

export class FakeGraph implements GraphPort {
  messages: MailMessage[] = [];
  attachments = new Map<string, Array<{ meta: MailAttachment; buf: Buffer }>>();
  files = new Map<string, Buffer>();
  folders = new Set(['Hopper/Bills', 'Hopper/Statements', 'Harcourts/Bills', 'Harcourts/Statements']);
  mailFolders = new Set(['Inbox/Hopper Joint', 'Inbox/Harcourts Cafe']);
  moved = new Map<string, string>();
  categories = new Map<string, string[]>();
  sent: Array<{ to: string[]; subject: string; body: string }> = [];
  authResults = 'spf=pass dkim=pass dmarc=pass';
  failUploadsOnce = 0;

  addMessage(id: string, from: string, atts: Array<{ name: string; buf: Buffer; odata?: string }>, subject = 'Fwd: supplier email'): MailMessage {
    const m: MailMessage = { id, subject, receivedDateTime: '2026-10-28T00:00:00Z', hasAttachments: atts.length > 0, categories: [], from: { emailAddress: { address: from } } };
    this.messages.push(m);
    this.attachments.set(
      id,
      atts.map((a, i) => ({
        meta: { id: `${id}-a${i}`, name: a.name, contentType: a.name.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream', size: a.buf.length, isInline: false, odataType: a.odata ?? '#microsoft.graph.fileAttachment' },
        buf: a.buf,
      })),
    );
    return m;
  }

  fileAt(folder: string, name: string): Buffer | undefined {
    return this.files.get(`${folder}/${name}`);
  }
  filesIn(folder: string): string[] {
    return [...this.files.keys()].filter((k) => k.startsWith(`${folder}/`)).map((k) => k.slice(folder.length + 1));
  }

  async listCandidateMessages() { return this.messages; }
  async getAuthenticationResults() { return this.authResults; }
  async listAttachments(id: string) { return (this.attachments.get(id) ?? []).map((a) => a.meta); }
  async downloadAttachment(id: string, attId: string) { return this.attachments.get(id)!.find((a) => a.meta.id === attId)!.buf; }
  async setCategories(id: string, cats: string[]) { this.categories.set(id, cats); }
  async resolveMailFolder(path: string) {
    if (!this.mailFolders.has(path)) throw new GraphError('nope', 404, 'FolderNotFound');
    return `folder:${path}`;
  }
  async moveMessage(id: string, folderId: string) { this.moved.set(id, folderId); }
  async sendMail(to: string[], subject: string, body: string) { this.sent.push({ to, subject, body }); }
  async resolveDrive(): Promise<DriveRef> { return { siteId: 's', driveId: 'd' }; }
  async folderExists(_d: DriveRef, p: string) { return this.folders.has(p) || [...this.folders].some((f) => f.startsWith(`${p}/`)); }
  async getItem(_d: DriveRef, path: string): Promise<DriveItem | null> {
    const b = this.files.get(path);
    return b ? { id: path, name: path.split('/').pop()!, size: b.length } : null;
  }
  async downloadItem(_d: DriveRef, id: string) { return this.files.get(id)!; }
  async uploadNew(_d: DriveRef, folder: string, name: string, content: Buffer): Promise<DriveItem> {
    if (this.failUploadsOnce > 0) {
      this.failUploadsOnce--;
      throw new GraphError('boom', 503);
    }
    const key = `${folder}/${name}`;
    if (this.files.has(key)) throw new GraphError('exists', 409, 'nameAlreadyExists');
    this.files.set(key, content);
    return { id: key, name, size: content.length };
  }
  tables = new Map<string, { name: string; headers: string[]; rows: Array<Array<string | number | null>> }[]>();
  addTable(filePath: string, headers: string[], name = 'Table1') {
    this.files.set(filePath, Buffer.from('xlsx'));
    this.tables.set(filePath, [...(this.tables.get(filePath) ?? []), { name, headers, rows: [] }]);
  }
  async appendTableRow(_d: DriveRef, filePath: string, table: string, values: (string | number | null)[]) {
    this.tables.get(filePath)!.find((t) => t.name === table)!.rows.push(values);
  }
  highlighted: string[] = [];
  failHighlight = false;
  async highlightTableRow(_d: DriveRef, filePath: string, _table: string, index: number) {
    if (this.failHighlight) throw new Error('format failed');
    this.highlighted.push(`${filePath}#${index}`);
  }
  async listChildFolders(_d: DriveRef, folderPath: string) {
    const prefix = `${folderPath}/`;
    return [...new Set([...this.folders].filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length).split('/')[0]!))];
  }
  async listTables(_d: DriveRef, filePath: string) { return (this.tables.get(filePath) ?? []).map((t) => t.name); }
  async getTableHeaders(_d: DriveRef, filePath: string, table: string) { return this.tables.get(filePath)!.find((t) => t.name === table)!.headers; }
  async getTableRows(_d: DriveRef, filePath: string, table: string) { return [...this.tables.get(filePath)!.find((t) => t.name === table)!.rows]; }
}

export class FakeXero implements XeroPort {
  contacts = new Map<string, XeroContact[]>();
  bills: Array<XeroBill & { tenant: string; attachments: string[]; input?: DraftBillInput }> = [];
  failCreateOnce: XeroError | null = null;
  readyCalls = 0;
  contactsCreated: string[] = [];
  totalOverride: number | null = null;

  addContact(tenant: string, name: string, abn: string | null = null, acct: string | null = null): XeroContact {
    const c: XeroContact = { contactId: `c-${name}`, name, taxNumber: abn, purchasesDefaultAccountCode: acct };
    this.contacts.set(tenant, [...(this.contacts.get(tenant) ?? []), c]);
    return c;
  }

  async ensureOrgReady() { this.readyCalls++; }

  async resolveContact(tenant: string, name: string, _abn: string | null, opts: { fuzzyPolicy: 'review' | 'create'; createMissing: boolean }): Promise<ContactResolution> {
    const list = this.contacts.get(tenant) ?? [];
    const exact = list.find((c) => normaliseBusinessName(c.name) === normaliseBusinessName(name));
    if (exact) return { ok: true, contact: exact, created: false };
    const close = list.filter((c) => nameSimilarity(c.name, name) >= 0.6);
    if (close.length && opts.fuzzyPolicy === 'review') return { ok: false, reason: `Supplier "${name}" is similar to existing Xero contact(s): ${close.map((c) => `"${c.name}"`).join(', ')}.` };
    if (!opts.createMissing) return { ok: false, reason: 'creation off' };
    const c = this.addContact(tenant, name);
    this.contactsCreated.push(name);
    return { ok: true, contact: c, created: true };
  }

  async findBill(tenant: string, contactId: string, num: string, reference?: string) {
    return this.bills.find((b) => b.tenant === tenant && b.contactId === contactId && normaliseDocNumber(b.invoiceNumber) === normaliseDocNumber(num) && (reference === undefined || b.reference === reference)) ?? null;
  }

  async findBillsByNumber(tenant: string, num: string) {
    return this.bills.filter((b) => b.tenant === tenant && normaliseDocNumber(b.invoiceNumber) === normaliseDocNumber(num));
  }

  async createDraftBill(tenant: string, bill: DraftBillInput): Promise<XeroBill> {
    if (this.failCreateOnce) {
      const e = this.failCreateOnce;
      this.failCreateOnce = null;
      throw e;
    }
    const b = {
      tenant,
      invoiceId: `inv-${this.bills.length + 1}`,
      invoiceNumber: bill.invoiceNumber,
      status: 'DRAFT',
      total: this.totalOverride ?? bill.expectedTotal,
      totalTax: bill.expectedGst,
      contactId: bill.contactId,
      reference: bill.reference ?? '',
      attachments: [] as string[],
      input: bill,
    };
    this.bills.push(b);
    return b;
  }

  async hasAttachment(_t: string, invoiceId: string, fileName: string) {
    return this.bills.find((b) => b.invoiceId === invoiceId)!.attachments.includes(fileName);
  }
  async uploadAttachment(_t: string, invoiceId: string, fileName: string) {
    this.bills.find((b) => b.invoiceId === invoiceId)!.attachments.push(fileName);
  }
}

/** Returns a canned extraction per PDF content hash. A function value is called with the pass number. */
export class FakeExtractor implements Extractor {
  private map = new Map<string, Extraction | ((pass: number) => Extraction)>();
  private calls = new Map<string, number>();
  total = 0;
  on(pdf: Buffer, ex: Extraction | ((pass: number) => Extraction)) { this.map.set(sha256(pdf), ex); }
  async extract(pdf: Buffer): Promise<Extraction> {
    this.total++;
    const k = sha256(pdf);
    const n = this.calls.get(k) ?? 0;
    this.calls.set(k, n + 1);
    const v = this.map.get(k);
    if (!v) throw new Error('FakeExtractor: unknown PDF');
    return typeof v === 'function' ? v(n) : structuredClone(v);
  }
}

export class FakeAlerter implements Alerter {
  alerts: Array<{ subject: string; body: string }> = [];
  async alert(subject: string, body: string) { this.alerts.push({ subject, body }); }
}
export class FakeLedger implements Ledger {
  rows: LedgerRow[] = [];
  async add(r: LedgerRow) { this.rows.push(r); }
}
