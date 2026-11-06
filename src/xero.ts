import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ClientConfig } from './types.js';
import type { DraftBillInput } from './billmap.js';
import { nameSimilarity, normaliseBusinessName, normaliseDocNumber, sleep } from './util.js';
import type { Logger } from './logger.js';

const API = 'https://api.xero.com/api.xro/2.0';
const IDENTITY = 'https://identity.xero.com/connect/token';

/** Network blips, rate limits and 5xx: safe to retry on the next poll. */
export class XeroError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}
/** Authorisation is broken (token expired or revoked). Needs a human to re-run xero:auth. */
export class XeroAuthError extends Error {}
/** The organisation is not set up the way the client config assumes. */
export class XeroConfigError extends Error {}

export interface XeroBill {
  invoiceId: string;
  invoiceNumber: string;
  status: string;
  total: number;
  totalTax: number;
  contactId: string;
  reference?: string;
}

export interface XeroContact {
  contactId: string;
  name: string;
  taxNumber: string | null;
  purchasesDefaultAccountCode: string | null;
}

export type ContactResolution =
  | { ok: true; contact: XeroContact; created: boolean }
  | { ok: false; reason: string };

export interface XeroPort {
  ensureOrgReady(client: ClientConfig): Promise<void>;
  resolveContact(
    tenantId: string,
    name: string,
    abn: string | null,
    opts: { fuzzyPolicy: 'review' | 'create'; createMissing: boolean },
  ): Promise<ContactResolution>;
  findBill(tenantId: string, contactId: string, billNumber: string, reference?: string): Promise<XeroBill | null>;
  /** Every purchase bill with this number under any contact (used to catch a bill already entered under another supplier). */
  findBillsByNumber(tenantId: string, billNumber: string): Promise<XeroBill[]>;
  createDraftBill(tenantId: string, bill: DraftBillInput, idempotencyKey: string): Promise<XeroBill>;
  hasAttachment(tenantId: string, invoiceId: string, fileName: string): Promise<boolean>;
  uploadAttachment(tenantId: string, invoiceId: string, fileName: string, content: Buffer): Promise<void>;
}

// ---------------------------------------------------------------------------
// Tokens: Xero refresh tokens are single use and rotate, so every refresh must be saved
// to disk before the new access token is used. Mount a persistent volume for the store.
// ---------------------------------------------------------------------------

interface TokenStore {
  refreshToken: string;
  updatedAt: string;
}

export class XeroAuth {
  private mem: { token: string; expiresAt: number } | null = null;
  private inflight: Promise<string> | null = null;

  constructor(
    private readonly cfg: { clientId: string; clientSecret: string; tokenStorePath: string; bootstrapRefreshToken: string },
    private readonly log: Logger,
  ) {}

  private readStore(): TokenStore | null {
    if (existsSync(this.cfg.tokenStorePath)) {
      try {
        return JSON.parse(readFileSync(this.cfg.tokenStorePath, 'utf8')) as TokenStore;
      } catch {
        this.log.error('Xero token store unreadable', { path: this.cfg.tokenStorePath });
      }
    }
    if (this.cfg.bootstrapRefreshToken) return { refreshToken: this.cfg.bootstrapRefreshToken, updatedAt: 'bootstrap' };
    return null;
  }

  private writeStore(refreshToken: string): void {
    const dir = dirname(this.cfg.tokenStorePath);
    mkdirSync(dir, { recursive: true });
    const tmp = `${this.cfg.tokenStorePath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ refreshToken, updatedAt: new Date().toISOString() } satisfies TokenStore), { mode: 0o600 });
    renameSync(tmp, this.cfg.tokenStorePath);
    try {
      chmodSync(this.cfg.tokenStorePath, 0o600);
    } catch {
      /* best effort */
    }
  }

  /** Exchanges a one-time authorisation code from the Xero consent screen for tokens, and stores the refresh token. */
  async exchangeCode(code: string, redirectUri: string): Promise<{ accessToken: string }> {
    const res = await fetch(IDENTITY, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
    }).catch((e) => {
      throw new XeroError(`Could not reach Xero sign-in: ${(e as Error).message}`, 0, true);
    });
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !json.access_token || !json.refresh_token) {
      throw new XeroAuthError(`Xero rejected the authorisation (${json.error ?? res.status}). Check the client ID, secret and that the redirect URI matches exactly.`);
    }
    this.writeStore(json.refresh_token);
    this.mem = { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 1800) * 1000 };
    return { accessToken: json.access_token };
  }

  async accessToken(force = false): Promise<string> {
    if (!force && this.mem && this.mem.expiresAt - 60_000 > Date.now()) return this.mem.token;
    if (!this.inflight) {
      this.inflight = this.refresh().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async refresh(): Promise<string> {
    const stored = this.readStore();
    if (!stored) throw new XeroAuthError('Xero is not authorised yet. Run `npm run xero:auth` and set XERO_BOOTSTRAP_REFRESH_TOKEN.');
    const res = await fetch(IDENTITY, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: stored.refreshToken }),
    }).catch((e) => {
      throw new XeroError(`Could not reach Xero sign-in: ${(e as Error).message}`, 0, true);
    });
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !json.access_token || !json.refresh_token) {
      if (res.status >= 500 || res.status === 429) throw new XeroError(`Xero sign-in unavailable (${res.status})`, res.status, true);
      throw new XeroAuthError(`Xero refused the refresh token (${json.error ?? res.status}). Re-run \`npm run xero:auth\` and update the token.`);
    }
    // Persist the rotated token BEFORE doing anything else with it.
    this.writeStore(json.refresh_token);
    this.mem = { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 1800) * 1000 };
    return json.access_token;
  }
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

interface Req {
  query?: Record<string, string>;
  json?: unknown;
  body?: Buffer;
  headers?: Record<string, string>;
}

const digits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '');

export class XeroClient implements XeroPort {
  private contactCache = new Map<string, { at: number; contacts: XeroContact[] }>();
  private readyTenants = new Set<string>();

  constructor(
    private readonly auth: XeroAuth,
    private readonly log: Logger,
  ) {}

  private async raw(tenantId: string | null, method: string, url: string, req: Req = {}, attempt = 0, force = false): Promise<Response> {
    const u = new URL(url);
    for (const [k, v] of Object.entries(req.query ?? {})) u.searchParams.set(k, v);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.auth.accessToken(force)}`,
      Accept: 'application/json',
      ...req.headers,
    };
    if (tenantId) headers['xero-tenant-id'] = tenantId;
    let body: Buffer | string | undefined = req.body;
    if (req.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(req.json);
    }
    let res: Response;
    try {
      res = await fetch(u, { method, headers, body: body as RequestInit['body'] });
    } catch (e) {
      if (attempt < 3) {
        await sleep(1000 * 2 ** attempt);
        return this.raw(tenantId, method, url, req, attempt + 1, force);
      }
      throw new XeroError(`Could not reach Xero: ${(e as Error).message}`, 0, true);
    }
    if (res.status === 401 && !force) return this.raw(tenantId, method, url, req, attempt, true);
    if (res.status === 429 && attempt < 4) {
      const ra = Number(res.headers.get('retry-after'));
      await sleep((Number.isFinite(ra) && ra > 0 ? ra : 5 * 2 ** attempt) * 1000);
      return this.raw(tenantId, method, url, req, attempt + 1, force);
    }
    if (res.status >= 500 && attempt < 2) {
      await sleep(1500 * 2 ** attempt);
      return this.raw(tenantId, method, url, req, attempt + 1, force);
    }
    return res;
  }

  private async call<T>(tenantId: string | null, method: string, path: string, req: Req = {}): Promise<T> {
    const url = path.startsWith('http') ? path : `${API}${path}`;
    const res = await this.raw(tenantId, method, url, req);
    const text = await res.text();
    if (!res.ok) {
      throw new XeroError(`Xero ${method} ${path.slice(0, 80)} failed (${res.status}): ${describeXeroBody(text)}`, res.status, res.status >= 500 || res.status === 429);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  // ----- readiness -----
  async connections(): Promise<Array<{ tenantId: string; tenantName: string; tenantType: string }>> {
    return this.call('', 'GET', 'https://api.xero.com/connections');
  }

  async ensureOrgReady(client: ClientConfig): Promise<void> {
    const tenantId = client.xero.tenantId;
    if (this.readyTenants.has(tenantId)) return;

    const conns = await this.connections();
    if (!conns.some((c) => c.tenantId === tenantId)) {
      throw new XeroConfigError(
        `Xero organisation for ${client.name} (${tenantId}) is not authorised for this app. Authorised: ${conns.map((c) => `${c.tenantName} ${c.tenantId}`).join(', ') || 'none'}`,
      );
    }
    const rates = await this.call<{ TaxRates: Array<{ TaxType: string; Status: string }> }>(tenantId, 'GET', '/TaxRates');
    const active = new Set(rates.TaxRates.filter((r) => r.Status === 'ACTIVE').map((r) => r.TaxType));
    for (const t of [client.xero.taxTypeWithGst, client.xero.taxTypeNoGst]) {
      if (!active.has(t)) {
        throw new XeroConfigError(`Tax type "${t}" is not an active tax rate in Xero for ${client.name}. Active types: ${[...active].join(', ')}`);
      }
    }
    if (client.xero.defaultAccountCode) {
      const code = client.xero.defaultAccountCode;
      const acc = await this.call<{ Accounts: Array<{ Code: string; Status: string }> }>(tenantId, 'GET', '/Accounts', {
        query: { where: `Code=="${code.replace(/"/g, '')}"` },
      });
      if (!acc.Accounts.some((a) => a.Status === 'ACTIVE')) {
        throw new XeroConfigError(`Default account code "${code}" does not exist or is archived in Xero for ${client.name}.`);
      }
    }
    this.readyTenants.add(tenantId);
    this.log.info('Xero organisation verified', { client: client.key });
  }

  // ----- contacts -----
  private async loadContacts(tenantId: string, fresh = false): Promise<XeroContact[]> {
    const cached = this.contactCache.get(tenantId);
    if (!fresh && cached && Date.now() - cached.at < 5 * 60_000) return cached.contacts;
    const all: XeroContact[] = [];
    for (let page = 1; page < 200; page++) {
      const j = await this.call<{ Contacts: Array<Record<string, unknown>> }>(tenantId, 'GET', '/Contacts', {
        query: { page: String(page), includeArchived: 'false' },
      });
      for (const c of j.Contacts) {
        all.push({
          contactId: String(c.ContactID),
          name: String(c.Name ?? ''),
          taxNumber: (c.TaxNumber as string | undefined) ?? null,
          purchasesDefaultAccountCode: (c.PurchasesDefaultAccountCode as string | undefined) ?? null,
        });
      }
      if (j.Contacts.length < 100) break;
    }
    this.contactCache.set(tenantId, { at: Date.now(), contacts: all });
    return all;
  }

  async resolveContact(
    tenantId: string,
    name: string,
    abn: string | null,
    opts: { fuzzyPolicy: 'review' | 'create'; createMissing: boolean },
  ): Promise<ContactResolution> {
    const contacts = await this.loadContacts(tenantId);
    const norm = normaliseBusinessName(name);
    const abnDigits = digits(abn);

    const exact = contacts.filter((c) => normaliseBusinessName(c.name) === norm);
    if (exact.length === 1) {
      const c = exact[0]!;
      const cAbn = digits(c.taxNumber);
      if (abnDigits.length === 11 && cAbn.length === 11 && abnDigits !== cAbn) {
        return { ok: false, reason: `Xero contact "${c.name}" has the same name but a different ABN (${c.taxNumber}) from the bill (${abn}).` };
      }
      return { ok: true, contact: c, created: false };
    }
    if (exact.length > 1) {
      return { ok: false, reason: `More than one Xero contact is named "${name}". Resolve the duplicates, then clear the review tag.` };
    }

    if (abnDigits.length === 11) {
      const byAbn = contacts.filter((c) => digits(c.taxNumber) === abnDigits);
      if (byAbn.length === 1 && nameSimilarity(byAbn[0]!.name, name) >= 0.5) {
        return { ok: true, contact: byAbn[0]!, created: false };
      }
    }

    const close = contacts
      .map((c) => ({ c, s: nameSimilarity(c.name, name) }))
      .filter((x) => x.s >= 0.6)
      .sort((a, b) => b.s - a.s)
      .slice(0, 3);
    if (close.length > 0 && opts.fuzzyPolicy === 'review') {
      return { ok: false, reason: `Supplier "${name}" is similar to existing Xero contact(s): ${close.map((x) => `"${x.c.name}"`).join(', ')}. Confirm which one is correct.` };
    }

    if (!opts.createMissing) {
      return { ok: false, reason: `Supplier "${name}" does not exist in Xero and automatic contact creation is off.` };
    }
    const created = await this.call<{ Contacts: Array<Record<string, unknown>> }>(tenantId, 'POST', '/Contacts', {
      json: { Contacts: [{ Name: name.trim(), ...(abnDigits.length === 11 ? { TaxNumber: abnDigits } : {}) }] },
      headers: { 'Idempotency-Key': `contact-${tenantId}-${norm}`.slice(0, 128) },
    });
    const c = created.Contacts[0]!;
    await this.loadContacts(tenantId, true);
    return {
      ok: true,
      created: true,
      contact: {
        contactId: String(c.ContactID),
        name: String(c.Name ?? name),
        taxNumber: (c.TaxNumber as string | undefined) ?? null,
        purchasesDefaultAccountCode: null,
      },
    };
  }

  // ----- bills -----
  private toBill(i: Record<string, unknown>): XeroBill {
    return {
      invoiceId: String(i.InvoiceID),
      invoiceNumber: String(i.InvoiceNumber ?? ''),
      status: String(i.Status ?? ''),
      total: Number(i.Total ?? 0),
      totalTax: Number(i.TotalTax ?? 0),
      contactId: String((i.Contact as { ContactID?: string } | undefined)?.ContactID ?? ''),
      reference: String(i.Reference ?? ''),
    };
  }

  async findBill(tenantId: string, contactId: string, billNumber: string, reference?: string): Promise<XeroBill | null> {
    const wanted = normaliseDocNumber(billNumber);
    for (let page = 1; page < 50; page++) {
      const j = await this.call<{ Invoices: Array<Record<string, unknown>> }>(tenantId, 'GET', '/Invoices', {
        query: {
          ContactIDs: contactId,
          Statuses: 'DRAFT,SUBMITTED,AUTHORISED,PAID',
          where: 'Type=="ACCPAY"',
          page: String(page),
          order: 'InvoiceNumber',
        },
      });
      const hit = j.Invoices.find((i) => normaliseDocNumber(String(i.InvoiceNumber ?? '')) === wanted && (reference === undefined || String(i.Reference ?? '') === reference.slice(0, 255)));
      if (hit) return this.toBill(hit);
      if (j.Invoices.length < 100) break;
    }
    return null;
  }

  async findBillsByNumber(tenantId: string, billNumber: string): Promise<XeroBill[]> {
    const wanted = normaliseDocNumber(billNumber);
    const j = await this.call<{ Invoices: Array<Record<string, unknown>> }>(tenantId, 'GET', '/Invoices', {
      query: { InvoiceNumbers: billNumber.trim(), Statuses: 'DRAFT,SUBMITTED,AUTHORISED,PAID', where: 'Type=="ACCPAY"' },
    });
    return j.Invoices.filter((i) => normaliseDocNumber(String(i.InvoiceNumber ?? '')) === wanted).map((i) => this.toBill(i));
  }

  async createDraftBill(tenantId: string, bill: DraftBillInput, idempotencyKey: string): Promise<XeroBill> {
    const payload = {
      Type: 'ACCPAY',
      Status: 'DRAFT', // never anything else: a human submits and approves
      Contact: { ContactID: bill.contactId },
      Date: bill.issueDate,
      ...(bill.dueDate ? { DueDate: bill.dueDate } : {}),
      InvoiceNumber: bill.invoiceNumber,
      ...(bill.reference ? { Reference: bill.reference.slice(0, 255) } : {}),
      CurrencyCode: bill.currency,
      LineAmountTypes: bill.amountsIncludeGst ? 'Inclusive' : 'Exclusive',
      LineItems: bill.lines.map((l) => ({
        Description: l.description,
        Quantity: l.quantity,
        UnitAmount: l.unitAmount,
        LineAmount: l.lineAmount,
        TaxType: l.taxType,
        TaxAmount: l.taxAmount,
        ...(l.accountCode ? { AccountCode: l.accountCode } : {}),
      })),
    };
    const j = await this.call<{ Invoices: Array<Record<string, unknown>> }>(tenantId, 'POST', '/Invoices', {
      json: { Invoices: [payload] },
      headers: { 'Idempotency-Key': idempotencyKey.slice(0, 128) },
    });
    const inv = j.Invoices[0];
    if (!inv) throw new XeroError('Xero returned no invoice after create', 500, true);
    const errs = (inv.ValidationErrors as Array<{ Message: string }> | undefined)?.map((e) => e.Message);
    if (errs?.length) throw new XeroError(`Xero rejected the draft bill: ${errs.join('; ')}`, 400, false);
    return this.toBill(inv);
  }

  async hasAttachment(tenantId: string, invoiceId: string, fileName: string): Promise<boolean> {
    const j = await this.call<{ Attachments?: Array<{ FileName: string }> }>(tenantId, 'GET', `/Invoices/${invoiceId}/Attachments`);
    return (j.Attachments ?? []).some((a) => a.FileName.toLowerCase() === fileName.toLowerCase());
  }

  async uploadAttachment(tenantId: string, invoiceId: string, fileName: string, content: Buffer): Promise<void> {
    if (content.length > 10 * 1024 * 1024) throw new XeroError('PDF is larger than Xero\'s 10 MB attachment limit.', 400, false);
    await this.call(tenantId, 'PUT', `/Invoices/${invoiceId}/Attachments/${encodeURIComponent(fileName)}`, {
      body: content,
      headers: { 'Content-Type': 'application/pdf' },
    });
  }
}

function describeXeroBody(text: string): string {
  try {
    const j = JSON.parse(text) as {
      Message?: string;
      Detail?: string;
      Elements?: Array<{ ValidationErrors?: Array<{ Message: string }> }>;
    };
    const el = j.Elements?.flatMap((e) => e.ValidationErrors?.map((v) => v.Message) ?? []).join('; ');
    return el || j.Message || j.Detail || text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

export async function listXeroConnections(accessToken: string): Promise<Array<{ tenantId: string; tenantName: string; tenantType: string }>> {
  const res = await fetch('https://api.xero.com/connections', { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
  if (!res.ok) throw new XeroError(`Could not list Xero organisations (${res.status})`, res.status, res.status >= 500);
  return (await res.json()) as Array<{ tenantId: string; tenantName: string; tenantType: string }>;
}
