import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, type Logger } from './logger.js';

/**
 * One-time Xero authorisation that runs on the deployed service itself (no localhost).
 *
 *   https://<your-railway-domain>/xero/connect?key=<XERO_SETUP_KEY>
 *
 * The page is off unless BOTH XERO_SETUP_KEY and XERO_REDIRECT_URI are set. Only someone who
 * knows the key can start the flow, and the callback only accepts a state value this server
 * issued in the last 10 minutes, once. Delete XERO_SETUP_KEY after authorising to switch it off.
 */

export interface SetupConfig {
  clientId: string;
  scopes: string;
  setupKey: string;
  redirectUri: string;
}

export interface XeroConnection {
  tenantId: string;
  tenantName: string;
  tenantType: string;
}

export interface SetupDeps {
  cfg: SetupConfig;
  exchangeCode(code: string, redirectUri: string): Promise<{ accessToken: string }>;
  listConnections(accessToken: string): Promise<XeroConnection[]>;
  log: Logger;
  now?: () => number;
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

function page(res: ServerResponse, status: number, title: string, body: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>` +
      `<body style="font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;line-height:1.5"><h2>${esc(title)}</h2>${body}</body>`,
  );
}

export function createXeroSetupHandler(d: SetupDeps): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const pending = new Map<string, number>(); // state -> expiry (ms)
  const now = () => (d.now ? d.now() : Date.now());
  const enabled = d.cfg.setupKey.length > 0 && d.cfg.redirectUri.length > 0;
  const callbackPath = new URL(d.cfg.redirectUri || 'https://placeholder.invalid/xero/callback').pathname;

  const purge = () => {
    for (const [s, exp] of pending) if (exp < now()) pending.delete(s);
    while (pending.size > 20) pending.delete(pending.keys().next().value as string);
  };

  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const isConnect = url.pathname === '/xero/connect';
    const isCallback = url.pathname === callbackPath;
    if (!isConnect && !isCallback) return false;
    if (!enabled) {
      res.writeHead(404).end();
      return true;
    }

    if (isConnect) {
      const key = url.searchParams.get('key') ?? '';
      if (!timingSafeEqual(digest(key), digest(d.cfg.setupKey))) {
        d.log.warn('Xero setup: wrong key');
        res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Forbidden');
        return true;
      }
      purge();
      const state = randomBytes(16).toString('hex');
      pending.set(state, now() + 10 * 60_000);
      const auth = new URL('https://login.xero.com/identity/connect/authorize');
      auth.search = new URLSearchParams({
        response_type: 'code',
        client_id: d.cfg.clientId,
        redirect_uri: d.cfg.redirectUri,
        scope: d.cfg.scopes,
        state,
      }).toString();
      res.writeHead(302, { Location: auth.toString(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }).end();
      return true;
    }

    // ----- callback -----
    const state = url.searchParams.get('state') ?? '';
    const expiry = pending.get(state);
    pending.delete(state);
    if (!expiry || expiry < now()) {
      page(res, 400, 'Link expired', '<p>This link is invalid or has expired. Start again from the connect link.</p>');
      return true;
    }
    const err = url.searchParams.get('error');
    if (err) {
      page(res, 400, 'Xero did not authorise', `<p>Xero returned: <b>${esc(err)}</b> ${esc(url.searchParams.get('error_description') ?? '')}</p>`);
      return true;
    }
    const code = url.searchParams.get('code');
    if (!code) {
      page(res, 400, 'No authorisation code', '<p>Xero did not return a code. Start again.</p>');
      return true;
    }
    try {
      const { accessToken } = await d.exchangeCode(code, d.cfg.redirectUri);
      const conns = await d.listConnections(accessToken);
      d.log.info('Xero authorised via setup page', { organisations: conns.map((c) => c.tenantName) });
      const rows = conns
        .map((c) => `<tr><td style="padding:4px 12px 4px 0">${esc(c.tenantName)}</td><td><code>${esc(c.tenantId)}</code></td></tr>`)
        .join('');
      page(
        res,
        200,
        'Xero authorised',
        `<p>The login is saved on the server. These are the organisations this app can now reach. Copy each tenant ID into the client mapping (<code>xero.tenantId</code>).</p>` +
          `<table>${rows || '<tr><td>No organisations were ticked. Start again and tick them.</td></tr>'}</table>` +
          `<p>When you have copied them, delete <code>XERO_SETUP_KEY</code> in Railway to switch this page off.</p>`,
      );
    } catch (e) {
      d.log.error('Xero setup failed', { error: errMsg(e) });
      page(res, 502, 'Could not finish', `<p>${esc(errMsg(e))}</p><p>Start again from the connect link.</p>`);
    }
    return true;
  };
}
