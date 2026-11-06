import { readFileSync, existsSync } from 'node:fs';
import { ClientsFileSchema, type ClientsFile } from './types.js';

/** Loads .env for local runs. On Railway the variables are injected, so a missing file is fine. */
export function loadDotEnv(): void {
  try {
    (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile?.('.env');
  } catch {
    /* no .env file */
  }
}

function env(name: string, fallback = ''): string {
  return (process.env[name] ?? fallback).trim();
}

function requireEnv(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

function bool(name: string, fallback: boolean): boolean {
  const v = env(name);
  if (!v) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export interface ExtractionConfig {
  anthropicApiKey: string;
  model: string;
  passes: number;
}

export function loadExtractionConfig(): ExtractionConfig {
  const passes = Number(env('EXTRACTION_PASSES', '2'));
  if (!Number.isInteger(passes) || passes < 1 || passes > 3) {
    throw new Error('EXTRACTION_PASSES must be 1, 2 or 3');
  }
  return {
    anthropicApiKey: requireEnv('ANTHROPIC_API_KEY'),
    model: env('ANTHROPIC_MODEL', 'claude-sonnet-5-5'),
    passes,
  };
}

export function loadClientsFile(): ClientsFile {
  let raw = env('CLIENTS_JSON');
  if (!raw) {
    const path = env('CLIENTS_CONFIG_PATH', 'config/clients.json');
    if (!existsSync(path)) {
      throw new Error(`No client mapping found. Set CLIENTS_JSON or create ${path} (see config/clients.example.json).`);
    }
    raw = readFileSync(path, 'utf8');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Client mapping is not valid JSON: ${(e as Error).message}`);
  }
  const file = ClientsFileSchema.parse(parsed);

  // A sender address must belong to exactly one client, otherwise files could land in the wrong place.
  const seen = new Map<string, string>();
  for (const c of file.clients) {
    for (const s of c.senders) {
      const k = s.toLowerCase();
      const prev = seen.get(k);
      if (prev && prev !== c.key) {
        throw new Error(`Sender ${s} is mapped to both "${prev}" and "${c.key}". Each sender must map to one client.`);
      }
      seen.set(k, c.key);
    }
  }
  const keys = new Set<string>();
  for (const c of file.clients) {
    if (keys.has(c.key)) throw new Error(`Duplicate client key "${c.key}"`);
    keys.add(c.key);
  }
  return file;
}

export interface AppConfig {
  dryRun: boolean;
  processFrom: Date | null;
  lookbackDays: number;
  pollIntervalSeconds: number;
  mailbox: string;
  ms: { tenantId: string; clientId: string; clientSecret: string };
  xero: { clientId: string; clientSecret: string; scopes: string; tokenStorePath: string; bootstrapRefreshToken: string; setupKey: string; redirectUri: string };
  extraction: ExtractionConfig;
  alertEmails: string[];
  contactFuzzyPolicy: 'review' | 'create';
  createMissingContacts: boolean;
  blockOnDmarcFail: boolean;
  port: number;
  clientsFile: ClientsFile;
}

export function loadAppConfig(): AppConfig {
  const dryRun = bool('DRY_RUN', true);
  const processFromRaw = env('PROCESS_FROM');
  let processFrom: Date | null = null;
  if (processFromRaw) {
    processFrom = new Date(processFromRaw);
    if (Number.isNaN(processFrom.getTime())) throw new Error(`PROCESS_FROM is not a valid date: ${processFromRaw}`);
  }
  if (!dryRun && !processFrom) {
    throw new Error('DRY_RUN=false requires PROCESS_FROM (go-live timestamp) so older inbox mail is never touched.');
  }

  const setupKey = env('XERO_SETUP_KEY');
  const redirectUri = env('XERO_REDIRECT_URI');
  if (setupKey && setupKey.length < 16) throw new Error('XERO_SETUP_KEY must be at least 16 characters.');
  if (setupKey && !redirectUri) throw new Error('XERO_SETUP_KEY is set but XERO_REDIRECT_URI is empty.');
  if (redirectUri && !/^https:\/\/[^/]+\/.+/.test(redirectUri)) throw new Error('XERO_REDIRECT_URI must be a full https URL, for example https://your-app.up.railway.app/xero/callback');

  const policy = env('CONTACT_FUZZY_POLICY', 'review');
  if (policy !== 'review' && policy !== 'create') throw new Error('CONTACT_FUZZY_POLICY must be review or create');

  return {
    dryRun,
    processFrom,
    lookbackDays: Number(env('LOOKBACK_DAYS', '7')),
    pollIntervalSeconds: Math.max(15, Number(env('POLL_INTERVAL_SECONDS', '60'))),
    mailbox: requireEnv('MAILBOX_UPN'),
    ms: {
      tenantId: requireEnv('MS_TENANT_ID'),
      clientId: requireEnv('MS_CLIENT_ID'),
      clientSecret: requireEnv('MS_CLIENT_SECRET'),
    },
    xero: {
      clientId: requireEnv('XERO_CLIENT_ID'),
      clientSecret: requireEnv('XERO_CLIENT_SECRET'),
      scopes: env('XERO_SCOPES', 'offline_access accounting.invoices accounting.contacts accounting.attachments accounting.settings.read'),
      tokenStorePath: env('TOKEN_STORE_PATH', './xero-tokens.json'),
      bootstrapRefreshToken: env('XERO_BOOTSTRAP_REFRESH_TOKEN'),
      setupKey: env('XERO_SETUP_KEY'),
      redirectUri: env('XERO_REDIRECT_URI'),
    },
    extraction: loadExtractionConfig(),
    alertEmails: env('ALERT_EMAILS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    contactFuzzyPolicy: policy,
    createMissingContacts: bool('CREATE_MISSING_CONTACTS', true),
    blockOnDmarcFail: bool('BLOCK_ON_DMARC_FAIL', true),
    port: Number(env('PORT', '3000')),
    clientsFile: loadClientsFile(),
  };
}
