import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createXeroSetupHandler, type SetupDeps } from '../src/xero-setup.js';
import { silentLogger } from '../src/logger.js';

const KEY = 'a-long-random-setup-key-123';
const REDIRECT = 'https://bookkeeping.up.railway.app/xero/callback';

async function withServer(over: Partial<SetupDeps['cfg']>, fn: (base: string, calls: { exchanged: string[] }, clock: { t: number }) => Promise<void>, failExchange = false) {
  const calls = { exchanged: [] as string[] };
  const clock = { t: 1_000_000 };
  const handler = createXeroSetupHandler({
    cfg: { clientId: 'cid', scopes: 'offline_access accounting.invoices', setupKey: KEY, redirectUri: REDIRECT, ...over },
    exchangeCode: async (code) => {
      if (failExchange) throw new Error('bad code');
      calls.exchanged.push(code);
      return { accessToken: 'tok' };
    },
    listConnections: async () => [
      { tenantId: '11111111-1111-4111-8111-111111111111', tenantName: 'Hopper <Joint>', tenantType: 'ORGANISATION' },
    ],
    log: silentLogger,
    now: () => clock.t,
  });
  const server = http.createServer(async (req, res) => {
    if (await handler(req, res)) return;
    res.writeHead(200).end('other');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn(base, calls, clock);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const get = (url: string) => fetch(url, { redirect: 'manual' });

async function startFlow(base: string): Promise<string> {
  const r = await get(`${base}/xero/connect?key=${KEY}`);
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get('location')!);
  assert.equal(loc.origin + loc.pathname, 'https://login.xero.com/identity/connect/authorize');
  assert.equal(loc.searchParams.get('client_id'), 'cid');
  assert.equal(loc.searchParams.get('redirect_uri'), REDIRECT);
  assert.equal(loc.searchParams.get('response_type'), 'code');
  assert.match(loc.searchParams.get('scope')!, /accounting\.invoices/);
  return loc.searchParams.get('state')!;
}

test('wrong or missing key is refused', async () => {
  await withServer({}, async (base) => {
    assert.equal((await get(`${base}/xero/connect?key=nope`)).status, 403);
    assert.equal((await get(`${base}/xero/connect`)).status, 403);
  });
});

test('routes are switched off (404) when no setup key is configured', async () => {
  await withServer({ setupKey: '', redirectUri: '' }, async (base) => {
    assert.equal((await get(`${base}/xero/connect?key=anything`)).status, 404);
    assert.equal((await get(`${base}/xero/callback?code=x&state=y`)).status, 404);
    assert.equal(await (await get(`${base}/health`)).text(), 'other');
  });
});

test('full flow: redirect to Xero, callback stores the login and lists organisations (escaped)', async () => {
  await withServer({}, async (base, calls) => {
    const state = await startFlow(base);
    const r = await get(`${base}/xero/callback?code=CODE1&state=${state}`);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.deepEqual(calls.exchanged, ['CODE1']);
    assert.match(html, /11111111-1111-4111-8111-111111111111/);
    assert.match(html, /Hopper &lt;Joint&gt;/);
    assert.ok(!html.includes('Hopper <Joint>'));
    assert.equal(r.headers.get('cache-control'), 'no-store');
  });
});

test('forged, replayed and expired state values are rejected without exchanging the code', async () => {
  await withServer({}, async (base, calls, clock) => {
    assert.equal((await get(`${base}/xero/callback?code=X&state=forged`)).status, 400);

    const s1 = await startFlow(base);
    assert.equal((await get(`${base}/xero/callback?code=A&state=${s1}`)).status, 200);
    assert.equal((await get(`${base}/xero/callback?code=A&state=${s1}`)).status, 400, 'state must be single use');

    const s2 = await startFlow(base);
    clock.t += 11 * 60_000;
    assert.equal((await get(`${base}/xero/callback?code=B&state=${s2}`)).status, 400, 'state must expire');

    assert.deepEqual(calls.exchanged, ['A']);
  });
});

test('Xero error and failed exchange are reported, not swallowed', async () => {
  await withServer({}, async (base) => {
    const s = await startFlow(base);
    const r = await get(`${base}/xero/callback?error=access_denied&state=${s}`);
    assert.equal(r.status, 400);
    assert.match(await r.text(), /access_denied/);
  });
  await withServer({}, async (base) => {
    const s = await startFlow(base);
    const r = await get(`${base}/xero/callback?code=C&state=${s}`);
    assert.equal(r.status, 502);
    assert.match(await r.text(), /bad code/);
  }, true);
});
