import http from 'node:http';
import { loadAppConfig, loadDotEnv } from './config.js';
import { createLogger, errMsg } from './logger.js';
import { GraphClient } from './graph.js';
import { XeroAuth, XeroClient, listXeroConnections } from './xero.js';
import { createXeroSetupHandler } from './xero-setup.js';
import { ClaudeExtractor } from './extract.js';
import { Pipeline, SystemicError, CAT } from './pipeline.js';
import { buildRules } from './classify.js';
import { ExcelLedger, MailAlerter, nullLedger } from './ops.js';
import { sleep } from './util.js';

loadDotEnv();

async function main(): Promise<void> {
  const log = createLogger();
  const cfg = loadAppConfig();

  const graph = new GraphClient({ ...cfg.ms, mailbox: cfg.mailbox });
  const xeroAuth = new XeroAuth(
    {
      clientId: cfg.xero.clientId,
      clientSecret: cfg.xero.clientSecret,
      tokenStorePath: cfg.xero.tokenStorePath,
      bootstrapRefreshToken: cfg.xero.bootstrapRefreshToken,
    },
    log,
  );
  const xero = new XeroClient(xeroAuth, log);
  const xeroSetup = createXeroSetupHandler({
    cfg: { clientId: cfg.xero.clientId, scopes: cfg.xero.scopes, setupKey: cfg.xero.setupKey, redirectUri: cfg.xero.redirectUri },
    exchangeCode: (code, redirectUri) => xeroAuth.exchangeCode(code, redirectUri),
    listConnections: listXeroConnections,
    log,
  });
  const alerter = new MailAlerter(graph, cfg.alertEmails, log, cfg.dryRun);
  const f = cfg.clientsFile;
  const pipeline = new Pipeline({
    cfg: {
      dryRun: cfg.dryRun,
      passes: cfg.extraction.passes,
      allowedCurrencies: f.allowedCurrencies.map((c) => c.toUpperCase()),
      contactFuzzyPolicy: cfg.contactFuzzyPolicy,
      createMissingContacts: cfg.createMissingContacts,
      blockOnDmarcFail: cfg.blockOnDmarcFail,
      clients: f.clients,
    },
    graph,
    xero,
    extractor: new ClaudeExtractor(cfg.extraction.anthropicApiKey, cfg.extraction.model),
    rules: buildRules(f.rules.extraBillHeadings, f.rules.extraStatementHeadings),
    log,
    alerter,
    ledger: f.log ? new ExcelLedger(graph, f.log) : nullLedger,
  });

  log.info('Bookkeeping automation starting', {
    mailbox: cfg.mailbox,
    dryRun: cfg.dryRun,
    processFrom: cfg.processFrom?.toISOString() ?? null,
    clients: f.clients.map((c) => ({ key: c.key, senders: c.senders, bills: c.sharepoint.billsFolder, statements: c.sharepoint.statementsFolder, outlook: c.outlookFolder })),
    model: cfg.extraction.model,
    passes: cfg.extraction.passes,
  });
  if (cfg.dryRun) log.warn('DRY_RUN is on: nothing will be saved, drafted, moved or tagged.');
  if (cfg.xero.setupKey) log.warn('Xero setup page is ENABLED at /xero/connect. Delete XERO_SETUP_KEY once Xero is authorised.');

  // ----- health endpoint -----
  const state = { startedAt: new Date().toISOString(), lastPollAt: null as string | null, lastError: null as string | null, lastEmailError: null as string | null, processed: 0 };
  http
    .createServer(async (req, res) => {
      if (await xeroSetup(req, res)) return;
      if (req.url === '/health') {
        const stale = state.lastPollAt && Date.now() - Date.parse(state.lastPollAt) > Math.max(10 * 60_000, cfg.pollIntervalSeconds * 5000);
        res.writeHead(stale ? 503 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: stale ? 'stale' : 'ok', dryRun: cfg.dryRun, ...state }));
        return;
      }
      res.writeHead(404).end();
    })
    .listen(cfg.port, () => log.info('Health endpoint listening', { port: cfg.port }));

  // ----- poll loop -----
  let stopping = false;
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { stopping = true; log.info('Shutting down after current email', { sig }); });

  const attempts = new Map<string, number>();
  const dryRunSeen = new Set<string>();

  while (!stopping) {
    let pollIssue: string | null = null; // shown at /health until a poll finishes clean
    try {
      const lookback = new Date(Date.now() - cfg.lookbackDays * 86_400_000);
      const since = cfg.processFrom && cfg.processFrom > lookback ? cfg.processFrom : lookback;
      const messages = await graph.listCandidateMessages(since);

      for (const m of messages) {
        if (stopping) break;
        if (!pipeline.clientFor(m) || Pipeline.alreadyHandled(m)) continue;
        if (cfg.dryRun && dryRunSeen.has(m.id)) continue;
        try {
          const outcome = await pipeline.processMessage(m);
          attempts.delete(m.id);
          if (cfg.dryRun) dryRunSeen.add(m.id);
          state.processed++;
          log.info(`Email done (${m.subject ?? 'no subject'}): ${outcome.status}${outcome.detail.length ? ' | ' + outcome.detail.join(' | ') : ''}`, { messageId: m.id, status: outcome.status, detail: outcome.detail });
        } catch (e) {
          if (e instanceof SystemicError) {
            pollIssue = `Setup problem: ${e.message}`;
            log.error(`Setup problem blocking processing: ${e.message}`, { error: e.message });
            await alerter.alert('Bookkeeping automation: setup problem', `${e.message}\n\nEmails are being left in the inbox until this is fixed. No action is needed on the emails themselves.`, `systemic:${e.message.slice(0, 120)}`);
            continue;
          }
          const n = (attempts.get(m.id) ?? 0) + 1;
          attempts.set(m.id, n);
          pollIssue = `Email failed (${m.subject ?? 'no subject'}): ${errMsg(e)}`;
          state.lastEmailError = pollIssue; // stays visible at /health until the next restart
          log.error(`Email failed (attempt ${n}): ${errMsg(e)}`, { messageId: m.id, attempt: n, error: errMsg(e) });
          if (n >= 3) {
            attempts.delete(m.id);
            if (cfg.dryRun) dryRunSeen.add(m.id); // dry run cannot tag the email, so stop retrying it until the next restart
            if (!cfg.dryRun) {
              try {
                await graph.setCategories(m.id, [...m.categories, CAT.error]);
              } catch (te) {
                log.error('Could not tag failed email', { error: errMsg(te) });
              }
            }
            await alerter.alert(
              'Bookkeeping automation: an email failed repeatedly',
              `Email "${m.subject ?? '(no subject)'}" (received ${m.receivedDateTime}) failed 3 times and has been left in the inbox tagged "BK Error".\n\nLast error: ${errMsg(e)}\n\nRemove the "BK Error" category to have the system retry it.`,
              `error:${m.id}`,
            );
          }
        }
      }
      state.lastPollAt = new Date().toISOString();
      state.lastError = pollIssue;
    } catch (e) {
      state.lastError = errMsg(e);
      log.error(`Poll failed: ${errMsg(e)}`, { error: errMsg(e) });
    }
    for (let i = 0; i < cfg.pollIntervalSeconds && !stopping; i++) await sleep(1000);
  }
  log.info('Stopped');
  process.exit(0);
}

main().catch((e) => {
  console.error(JSON.stringify({ level: 'fatal', msg: errMsg(e) }));
  process.exit(1);
});
