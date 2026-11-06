/**
 * One-time Xero authorisation for BOTH client organisations.
 *
 *   npm run xero:auth
 *
 * 1. In the Xero developer portal, add this redirect URI to the app: http://localhost:8787/callback
 * 2. Run this on your own computer, open the printed link, sign in as a user who can access both
 *    client organisations, and tick both organisations on the consent screen.
 * 3. The script prints each organisation's tenant ID (put them in the client mapping) and writes
 *    xero-tokens.json. Put its refreshToken in Railway as XERO_BOOTSTRAP_REFRESH_TOKEN
 *    (or copy the file onto the Railway volume at TOKEN_STORE_PATH).
 */
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { loadDotEnv } from '../config.js';

loadDotEnv();

const clientId = process.env.XERO_CLIENT_ID?.trim();
const clientSecret = process.env.XERO_CLIENT_SECRET?.trim();
const scopes = process.env.XERO_SCOPES?.trim() || 'offline_access accounting.invoices accounting.contacts accounting.attachments accounting.settings.read';
const redirectUri = process.env.XERO_REDIRECT_URI?.trim() || 'http://localhost:8787/callback';

if (!clientId || !clientSecret) {
  console.error('Set XERO_CLIENT_ID and XERO_CLIENT_SECRET first (in .env).');
  process.exit(2);
}

const state = randomBytes(16).toString('hex');
const authUrl = new URL('https://login.xero.com/identity/connect/authorize');
authUrl.search = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: scopes, state }).toString();

const port = Number(new URL(redirectUri).port || 8787);
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', redirectUri);
  if (url.pathname !== new URL(redirectUri).pathname) {
    res.writeHead(404).end();
    return;
  }
  try {
    if (url.searchParams.get('state') !== state) throw new Error('State mismatch. Start again.');
    const err = url.searchParams.get('error');
    if (err) throw new Error(`Xero returned an error: ${err} ${url.searchParams.get('error_description') ?? ''}`);
    const code = url.searchParams.get('code');
    if (!code) throw new Error('No authorisation code returned.');

    const tokRes = await fetch('https://identity.xero.com/connect/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
    });
    const tok = (await tokRes.json()) as { access_token?: string; refresh_token?: string; error?: string };
    if (!tokRes.ok || !tok.access_token || !tok.refresh_token) throw new Error(`Token exchange failed: ${tok.error ?? tokRes.status}`);

    const conRes = await fetch('https://api.xero.com/connections', { headers: { Authorization: `Bearer ${tok.access_token}` } });
    const cons = (await conRes.json()) as Array<{ tenantId: string; tenantName: string; tenantType: string }>;

    writeFileSync('xero-tokens.json', JSON.stringify({ refreshToken: tok.refresh_token, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });

    console.log('\nAuthorised. Organisations available to this app:\n');
    for (const c of cons) console.log(`  ${c.tenantName.padEnd(40)} ${c.tenantId}  (${c.tenantType})`);
    console.log('\nWrote xero-tokens.json (keep it private, it is git-ignored).');
    console.log('Set XERO_BOOTSTRAP_REFRESH_TOKEN in Railway to the refreshToken value inside it.');
    console.log('Use the tenant IDs above in the client mapping (xero.tenantId).\n');

    res.writeHead(200, { 'Content-Type': 'text/html' }).end('<h2>Xero authorised.</h2><p>You can close this tab and return to the terminal.</p>');
  } catch (e) {
    console.error('\n' + (e as Error).message);
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end((e as Error).message);
  } finally {
    setTimeout(() => server.close(() => process.exit(0)), 300);
  }
});
server.listen(port, '127.0.0.1', () => {
  console.log('Open this link in your browser and approve BOTH client organisations:\n');
  console.log(authUrl.toString() + '\n');
  console.log(`Waiting for Xero to redirect to ${redirectUri} ...`);
});
