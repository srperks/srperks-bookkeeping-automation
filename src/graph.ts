import { errMsg } from './logger.js';
import { sleep } from './util.js';
import { pickFolderName } from './folders.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';

export class GraphError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export interface MailMessage {
  id: string;
  subject: string | null;
  receivedDateTime: string;
  hasAttachments: boolean;
  categories: string[];
  internetMessageId?: string;
  from?: { emailAddress?: { address?: string; name?: string } };
}

export interface MailAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  isInline: boolean;
  odataType: string;
}

export interface DriveRef {
  siteId: string;
  driveId: string;
}

export interface DriveItem {
  id: string;
  name: string;
  size: number;
  webUrl?: string;
}

/** The slice of Graph the pipeline depends on. The pipeline is tested against an in-memory fake of this. */
export interface GraphPort {
  listCandidateMessages(since: Date): Promise<MailMessage[]>;
  getAuthenticationResults(messageId: string): Promise<string>;
  listAttachments(messageId: string): Promise<MailAttachment[]>;
  downloadAttachment(messageId: string, attachmentId: string): Promise<Buffer>;
  setCategories(messageId: string, categories: string[]): Promise<void>;
  resolveMailFolder(path: string): Promise<string>;
  moveMessage(messageId: string, folderId: string): Promise<void>;
  sendMail(to: string[], subject: string, body: string): Promise<void>;
  resolveDrive(hostname: string, sitePath: string, library: string): Promise<DriveRef>;
  folderExists(drive: DriveRef, folderPath: string): Promise<boolean>;
  getItem(drive: DriveRef, path: string): Promise<DriveItem | null>;
  downloadItem(drive: DriveRef, itemId: string): Promise<Buffer>;
  uploadNew(drive: DriveRef, folderPath: string, fileName: string, content: Buffer): Promise<DriveItem>;
  appendTableRow(drive: DriveRef, filePath: string, table: string, values: (string | number | null)[]): Promise<void>;
  /** Colours one table row (0-based index among the data rows) light red with dark red text. */
  highlightTableRow(drive: DriveRef, filePath: string, table: string, index: number): Promise<void>;
  listChildFolders(drive: DriveRef, folderPath: string): Promise<string[]>;
  listTables(drive: DriveRef, filePath: string): Promise<string[]>;
  getTableHeaders(drive: DriveRef, filePath: string, table: string): Promise<string[]>;
  getTableRows(drive: DriveRef, filePath: string, table: string): Promise<Array<Array<string | number | null>>>;
}

const encodePath = (p: string) =>
  p
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');

const odataString = (s: string) => s.replace(/'/g, "''");

export class GraphClient implements GraphPort {
  private token: { value: string; expiresAt: number } | null = null;
  private folderCache = new Map<string, string>();
  private driveCache = new Map<string, DriveRef>();

  constructor(
    private readonly cfg: { tenantId: string; clientId: string; clientSecret: string; mailbox: string },
  ) {}

  // ----- auth -----
  private async getToken(force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAt - 120_000 > Date.now()) return this.token.value;
    const res = await fetch(`https://login.microsoftonline.com/${this.cfg.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!res.ok || !json.access_token) {
      throw new GraphError(`Microsoft sign-in failed: ${json.error_description ?? res.status}`, res.status);
    }
    this.token = { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  private async raw(
    method: string,
    urlOrPath: string,
    opts: { json?: unknown; body?: Buffer; headers?: Record<string, string> } = {},
    attempt = 0,
    forceAuth = false,
  ): Promise<Response> {
    const url = urlOrPath.startsWith('http') ? urlOrPath : `${GRAPH}${urlOrPath}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${await this.getToken(forceAuth)}`, ...opts.headers };
    let body: Buffer | string | undefined = opts.body;
    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.json);
    }
    const res = await fetch(url, { method, headers, body: body as RequestInit['body'] });
    if (res.status === 401 && !forceAuth) {
      // Token may have been revoked or rotated: fetch a fresh one and try once more.
      return this.raw(method, urlOrPath, opts, attempt, true);
    }
    if ([429, 502, 503, 504].includes(res.status) && attempt < 4) {
      const ra = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** attempt);
      return this.raw(method, urlOrPath, opts, attempt + 1, forceAuth);
    }
    return res;
  }

  private async request<T>(method: string, path: string, opts: { json?: unknown; body?: Buffer; headers?: Record<string, string> } = {}): Promise<T> {
    const res = await this.raw(method, path, opts);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let code: string | undefined;
      let msg = text.slice(0, 300);
      try {
        const j = JSON.parse(text) as { error?: { code?: string; message?: string } };
        code = j.error?.code;
        msg = j.error?.message ?? msg;
      } catch {
        /* keep text */
      }
      throw new GraphError(`Graph ${method} ${path.slice(0, 120)} failed (${res.status} ${code ?? ''}): ${msg}`, res.status, code);
    }
    if (res.status === 204) return undefined as T;
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) return (await res.json()) as T;
    return undefined as T;
  }

  private get mb(): string {
    return `/users/${encodeURIComponent(this.cfg.mailbox)}`;
  }

  // ----- mail -----
  async listCandidateMessages(since: Date): Promise<MailMessage[]> {
    const out: MailMessage[] = [];
    const filter = `receivedDateTime ge ${since.toISOString()} and hasAttachments eq true`;
    let next: string | undefined =
      `${this.mb}/mailFolders/inbox/messages?$filter=${encodeURIComponent(filter)}&$orderby=${encodeURIComponent('receivedDateTime asc')}` +
      `&$select=id,subject,receivedDateTime,hasAttachments,categories,internetMessageId,from&$top=50`;
    for (let page = 0; next && page < 10; page++) {
      const j: { value: MailMessage[]; '@odata.nextLink'?: string } = await this.request('GET', next);
      out.push(...j.value);
      next = j['@odata.nextLink'];
    }
    return out;
  }

  async getAuthenticationResults(messageId: string): Promise<string> {
    const j = await this.request<{ internetMessageHeaders?: Array<{ name: string; value: string }> }>(
      'GET',
      `${this.mb}/messages/${encodeURIComponent(messageId)}?$select=internetMessageHeaders`,
    );
    return (j.internetMessageHeaders ?? [])
      .filter((h) => h.name.toLowerCase() === 'authentication-results')
      .map((h) => h.value)
      .join(' ');
  }

  async listAttachments(messageId: string): Promise<MailAttachment[]> {
    const j = await this.request<{ value: Array<Record<string, unknown>> }>(
      'GET',
      `${this.mb}/messages/${encodeURIComponent(messageId)}/attachments?$select=id,name,contentType,size,isInline`,
    );
    return j.value.map((a) => ({
      id: String(a.id),
      name: String(a.name ?? ''),
      contentType: String(a.contentType ?? ''),
      size: Number(a.size ?? 0),
      isInline: Boolean(a.isInline),
      odataType: String(a['@odata.type'] ?? ''),
    }));
  }

  async downloadAttachment(messageId: string, attachmentId: string): Promise<Buffer> {
    const res = await this.raw('GET', `${this.mb}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}/$value`);
    if (!res.ok) throw new GraphError(`Attachment download failed (${res.status})`, res.status);
    return Buffer.from(await res.arrayBuffer());
  }

  async setCategories(messageId: string, categories: string[]): Promise<void> {
    await this.request('PATCH', `${this.mb}/messages/${encodeURIComponent(messageId)}`, { json: { categories } });
  }

  /** "Inbox/Hopper Joint" or "Hopper Joint" (relative to the mailbox root). */
  async resolveMailFolder(path: string): Promise<string> {
    const cached = this.folderCache.get(path);
    if (cached) return cached;
    const segments = path.split('/').map((s) => s.trim()).filter(Boolean);
    let parent = 'msgfolderroot';
    for (const seg of segments) {
      const names = new Map<string, string>(); // display name -> id
      let next: string | undefined = `${this.mb}/mailFolders/${parent}/childFolders?$select=id,displayName&$top=100`;
      for (let page = 0; next && page < 10; page++) {
        const j: { value: Array<{ id: string; displayName: string }>; '@odata.nextLink'?: string } = await this.request('GET', next);
        for (const f of j.value) names.set(f.displayName, f.id);
        next = j['@odata.nextLink'];
      }
      const pick = pickFolderName([...names.keys()], seg);
      if (!pick.ok) throw new GraphError(`Outlook folder "${seg}" not found while resolving "${path}": ${pick.reason}`, 404, 'FolderNotFound');
      parent = names.get(pick.name)!;
    }
    this.folderCache.set(path, parent);
    return parent;
  }

  async moveMessage(messageId: string, folderId: string): Promise<void> {
    await this.request('POST', `${this.mb}/messages/${encodeURIComponent(messageId)}/move`, { json: { destinationId: folderId } });
  }

  async sendMail(to: string[], subject: string, body: string): Promise<void> {
    if (to.length === 0) return;
    await this.request('POST', `${this.mb}/sendMail`, {
      json: {
        message: {
          subject,
          body: { contentType: 'Text', content: body },
          toRecipients: to.map((address) => ({ emailAddress: { address } })),
        },
        saveToSentItems: true,
      },
    });
  }

  // ----- SharePoint -----
  async resolveDrive(hostname: string, sitePath: string, library: string): Promise<DriveRef> {
    const key = `${hostname}|${sitePath}|${library}`;
    const cached = this.driveCache.get(key);
    if (cached) return cached;
    const site = await this.request<{ id: string }>('GET', `/sites/${hostname}:${sitePath.startsWith('/') ? sitePath : `/${sitePath}`}`);
    const drives = await this.request<{ value: Array<{ id: string; name: string }> }>('GET', `/sites/${site.id}/drives?$select=id,name`);
    const wanted = library.toLowerCase();
    const drive = drives.value.find((d) => d.name.toLowerCase() === wanted) ?? (wanted === 'documents' ? drives.value.find((d) => d.name.toLowerCase() === 'shared documents') : undefined);
    if (!drive) {
      throw new GraphError(`Document library "${library}" not found on ${hostname}${sitePath}. Found: ${drives.value.map((d) => d.name).join(', ')}`, 404);
    }
    const ref = { siteId: site.id, driveId: drive.id };
    this.driveCache.set(key, ref);
    return ref;
  }

  async getItem(drive: DriveRef, path: string): Promise<DriveItem | null> {
    try {
      const j = await this.request<DriveItem>('GET', `/drives/${drive.driveId}/root:/${encodePath(path)}?$select=id,name,size,webUrl`);
      return j;
    } catch (e) {
      if (e instanceof GraphError && e.status === 404) return null;
      throw e;
    }
  }

  async folderExists(drive: DriveRef, folderPath: string): Promise<boolean> {
    return (await this.getItem(drive, folderPath)) !== null;
  }

  async downloadItem(drive: DriveRef, itemId: string): Promise<Buffer> {
    const res = await this.raw('GET', `/drives/${drive.driveId}/items/${itemId}/content`);
    if (!res.ok) throw new GraphError(`SharePoint download failed (${res.status})`, res.status);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Uploads a new file and refuses to overwrite anything (conflictBehavior=fail). */
  async uploadNew(drive: DriveRef, folderPath: string, fileName: string, content: Buffer): Promise<DriveItem> {
    const path = `${encodePath(folderPath)}/${encodeURIComponent(fileName)}`;
    if (content.length < 4 * 1024 * 1024) {
      return this.request<DriveItem>('PUT', `/drives/${drive.driveId}/root:/${path}:/content?@microsoft.graph.conflictBehavior=fail`, {
        body: content,
        headers: { 'Content-Type': 'application/pdf' },
      });
    }
    const session = await this.request<{ uploadUrl: string }>('POST', `/drives/${drive.driveId}/root:/${path}:/createUploadSession`, {
      json: { item: { '@microsoft.graph.conflictBehavior': 'fail', name: fileName } },
    });
    const chunk = 320 * 1024 * 10;
    let last: DriveItem | undefined;
    for (let start = 0; start < content.length; start += chunk) {
      const end = Math.min(start + chunk, content.length);
      const res = await fetch(session.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Length': String(end - start), 'Content-Range': `bytes ${start}-${end - 1}/${content.length}` },
        body: content.subarray(start, end) as unknown as RequestInit['body'],
      });
      if (!res.ok && res.status !== 202) throw new GraphError(`Chunked upload failed (${res.status}): ${(await res.text()).slice(0, 200)}`, res.status);
      if (res.status === 200 || res.status === 201) last = (await res.json()) as DriveItem;
    }
    if (!last) throw new GraphError('Chunked upload finished without a file record', 500);
    return last;
  }

  /**
   * Excel (workbook) calls are addressed by the file's item ID, not its path: path-based workbook
   * calls fail with 403 "Could not obtain a WAC access token" on some tenants.
   */
  private async workbookBase(drive: DriveRef, filePath: string): Promise<string> {
    const item = await this.getItem(drive, filePath);
    if (!item) throw new GraphError(`Excel file not found: ${filePath}`, 404, 'itemNotFound');
    return `/drives/${drive.driveId}/items/${item.id}/workbook`;
  }

  async appendTableRow(drive: DriveRef, filePath: string, table: string, values: (string | number | null)[]): Promise<void> {
    const base = await this.workbookBase(drive, filePath);
    await this.request('POST', `${base}/tables/${encodeURIComponent(table)}/rows/add`, { json: { values: [values] } });
  }

  async highlightTableRow(drive: DriveRef, filePath: string, table: string, index: number): Promise<void> {
    const base = await this.workbookBase(drive, filePath);
    const r = await this.request<{ address: string }>('GET', `${base}/tables/${encodeURIComponent(table)}/rows/itemAt(index=${index})/range?$select=address`);
    const bang = r.address.lastIndexOf('!');
    const sheet = r.address.slice(0, bang).replace(/^'|'$/g, '').replace(/''/g, "'");
    const cells = r.address.slice(bang + 1);
    const range = `${base}/worksheets/${encodeURIComponent(sheet)}/range(address='${cells}')/format`;
    await this.request('PATCH', `${range}/fill`, { json: { color: '#FFC7CE' } });
    await this.request('PATCH', `${range}/font`, { json: { color: '#9C0006' } });
  }

  async listChildFolders(drive: DriveRef, folderPath: string): Promise<string[]> {
    const out: string[] = [];
    let next: string | undefined = `/drives/${drive.driveId}/root:/${encodePath(folderPath)}:/children?$select=name,folder&$top=200`;
    for (let page = 0; next && page < 10; page++) {
      const j: { value: Array<{ name: string; folder?: unknown }>; '@odata.nextLink'?: string } = await this.request('GET', next);
      out.push(...j.value.filter((i) => i.folder).map((i) => i.name));
      next = j['@odata.nextLink'];
    }
    return out;
  }

  async listTables(drive: DriveRef, filePath: string): Promise<string[]> {
    const base = await this.workbookBase(drive, filePath);
    const j = await this.request<{ value: Array<{ name: string }> }>('GET', `${base}/tables?$select=name`);
    return j.value.map((t) => t.name);
  }

  async getTableHeaders(drive: DriveRef, filePath: string, table: string): Promise<string[]> {
    const base = await this.workbookBase(drive, filePath);
    const j = await this.request<{ values: Array<Array<string | number>> }>('GET', `${base}/tables/${encodeURIComponent(table)}/headerRowRange?$select=values`);
    return (j.values[0] ?? []).map((v) => String(v));
  }

  async getTableRows(drive: DriveRef, filePath: string, table: string): Promise<Array<Array<string | number | null>>> {
    const out: Array<Array<string | number | null>> = [];
    const base = await this.workbookBase(drive, filePath);
    let next: string | undefined = `${base}/tables/${encodeURIComponent(table)}/rows?$top=500`;
    for (let page = 0; next && page < 40; page++) {
      const j: { value: Array<{ values: Array<Array<string | number>> }>; '@odata.nextLink'?: string } = await this.request('GET', next);
      for (const r of j.value) out.push(r.values[0] ?? []);
      next = j['@odata.nextLink'];
    }
    return out;
  }
}

export function describeGraphError(e: unknown): string {
  if (e instanceof GraphError) return e.message;
  return errMsg(e);
}
