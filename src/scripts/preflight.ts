/**
 * Go-live checklist. Verifies every connection and destination without writing anything.
 *
 *   npm run preflight
 */
import { existsSync } from 'node:fs';
import { loadAppConfig, loadDotEnv } from '../config.js';
import { silentLogger } from '../logger.js';
import { GraphClient } from '../graph.js';
import { XeroAuth, XeroClient } from '../xero.js';
import { ClaudeExtractor } from '../extract.js';
import { dirname } from 'node:path';
import { accessSync, constants } from 'node:fs';

loadDotEnv();

let failures = 0;
const ok = (m: string) => console.log(`  PASS  ${m}`);
const bad = (m: string) => {
  failures++;
  console.log(`  FAIL  ${m}`);
};
async function check(label: string, fn: () => Promise<void>) {
  try {
    await fn();
    ok(label);
  } catch (e) {
    bad(`${label}: ${(e as Error).message}`);
  }
}

async function main() {
  const cfg = loadAppConfig();
  console.log(`\nMode: ${cfg.dryRun ? 'DRY RUN (safe)' : 'LIVE'}   Mailbox: ${cfg.mailbox}\n`);

  const graph = new GraphClient({ ...cfg.ms, mailbox: cfg.mailbox });
  await check('Microsoft 365 sign-in and mailbox access', async () => {
    await graph.listCandidateMessages(new Date(Date.now() - 3600_000));
  });
  const xero = new XeroClient(new XeroAuth({ clientId: cfg.xero.clientId, clientSecret: cfg.xero.clientSecret, tokenStorePath: cfg.xero.tokenStorePath, bootstrapRefreshToken: cfg.xero.bootstrapRefreshToken }, silentLogger), silentLogger);

  const dir = dirname(cfg.xero.tokenStorePath);
  try {
    accessSync(existsSync(dir) ? dir : '.', constants.W_OK);
    ok(`Xero token store location is writable (${cfg.xero.tokenStorePath}). On Railway this must be a mounted volume.`);
  } catch {
    bad(`Xero token store directory ${dir} is not writable`);
  }

  await check(`Claude API key and model "${cfg.extraction.model}"`, async () => {
    await new ClaudeExtractor(cfg.extraction.anthropicApiKey, cfg.extraction.model).ping();
  });

  for (const c of cfg.clientsFile.clients) {
    console.log(`\nClient: ${c.name} (${c.key})`);
    const sp = c.sharepoint;
    await check(`SharePoint library "${sp.library}" on ${sp.hostname}${sp.sitePath}`, async () => {
      await graph.resolveDrive(sp.hostname, sp.sitePath, sp.library);
    });
    for (const [label, folder] of [['bills', sp.billsFolder], ['statements', sp.statementsFolder]] as const) {
      await check(`SharePoint ${label} folder "${folder}" exists`, async () => {
        const drive = await graph.resolveDrive(sp.hostname, sp.sitePath, sp.library);
        if (!(await graph.folderExists(drive, folder))) throw new Error('folder not found');
      });
    }
    await check(`Outlook folder "${c.outlookFolder}" exists`, async () => {
      await graph.resolveMailFolder(c.outlookFolder);
    });
    await check(`Xero organisation ${c.xero.tenantId} authorised, tax types "${c.xero.taxTypeWithGst}" / "${c.xero.taxTypeNoGst}" valid`, async () => {
      await xero.ensureOrgReady(c);
    });
  }

  const lg = cfg.clientsFile.log;
  if (lg) {
    console.log('\nLog workbook');
    await check(`"${lg.filePath}" exists in SharePoint`, async () => {
      const drive = await graph.resolveDrive(lg.hostname, lg.sitePath, lg.library);
      if (!(await graph.getItem(drive, lg.filePath))) throw new Error('file not found. Run `npm run make-log-template` and upload it.');
    });
  }

  console.log(failures ? `\n${failures} check(s) failed. Fix these before going live.\n` : '\nAll checks passed.\n');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
