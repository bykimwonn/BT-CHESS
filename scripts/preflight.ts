/**
 * Go-live preflight.
 *
 *   npm run preflight              configuration checks only (no network)
 *   npm run preflight -- --smtp    also opens a real SMTP session
 *   npm run preflight -- --db      also connects to the database and checks
 *                                  administrator MFA and jurisdiction policy
 *   npm run preflight -- --network also reaches the public origin and every
 *                                  enabled provider's API host
 *   npm run preflight -- --json    machine-readable output
 *
 * Exit code 0 means no blockers. Warnings still exit 0; blockers exit 1.
 */
import fs from 'node:fs';
import { env } from '../server/config/env.js';
import { loadActivation } from '../server/config/compliance.js';
import { runPreflight, type PreflightCheck, type PreflightProvider } from '../server/config/preflight.js';
import { createAdapters } from '../server/payments/registry.js';
import { Mailer, emailProblems } from '../server/services/mailer.js';
import { createLogger } from '../server/services/logger.js';
import { openDatabase, type Database } from '../server/db/client.js';

const args = new Set(process.argv.slice(2));
const wantsSmtp = args.has('--smtp');
const wantsDb = args.has('--db');
const wantsNetwork = args.has('--network');
const wantsJson = args.has('--json');

const colour = process.stdout.isTTY && !wantsJson
  ? {
      pass: (s: string) => `\u001b[32m${s}\u001b[0m`,
      warn: (s: string) => `\u001b[33m${s}\u001b[0m`,
      fail: (s: string) => `\u001b[31m${s}\u001b[0m`,
      skip: (s: string) => `\u001b[90m${s}\u001b[0m`,
      bold: (s: string) => `\u001b[1m${s}\u001b[0m`,
      dim: (s: string) => `\u001b[90m${s}\u001b[0m`,
    }
  : {
      pass: (s: string) => s, warn: (s: string) => s, fail: (s: string) => s,
      skip: (s: string) => s, bold: (s: string) => s, dim: (s: string) => s,
    };

function render(check: PreflightCheck): void {
  const tag = check.status.toUpperCase().padEnd(4);
  const paint = check.status === 'pass' ? colour.pass
    : check.status === 'warn' ? colour.warn
      : check.status === 'fail' ? colour.fail : colour.skip;
  console.log(`${paint(`[${tag}]`)} ${check.label}`);
  console.log(`       ${check.detail}`);
  if (check.fix) console.log(`       ${colour.dim(`fix: ${check.fix}`)}`);
}

async function main(): Promise<void> {
  const log = createLogger();
  const adapters = createAdapters();
  const providers: PreflightProvider[] = Object.values(adapters).map((adapter) => {
    const health = adapter.health();
    const approvalFlags: Record<string, boolean> = {
      paynow: env.providers.paynow.merchantApproved,
      ecocash: env.providers.ecocash.merchantApproved,
      pesepay: env.providers.pesepay.merchantApproved,
      onemoney: false,
    };
    const enabledFlags: Record<string, boolean> = {
      paynow: env.providers.paynow.enabled,
      ecocash: env.providers.ecocash.enabled,
      pesepay: env.providers.pesepay.enabled,
      onemoney: env.providers.onemoney.enabled,
    };
    return {
      id: adapter.id,
      name: adapter.name,
      enabled: enabledFlags[adapter.id] ?? false,
      configured: health.configured,
      sandbox: health.sandbox,
      merchantApproved: approvalFlags[adapter.id] ?? false,
      enabledForRealMoney: health.enabledForRealMoney,
      capabilities: health.capabilities,
      reason: health.reason,
    };
  });

  const activation = loadActivation();
  const mailer = new Mailer(log);
  const smtp = wantsSmtp ? await mailer.verify() : undefined;

  let db: Database | null = null;
  let adminMfaEnforced: boolean | null = null;
  const dbFindings: PreflightCheck[] = [];
  if (wantsDb) {
    try {
      db = await openDatabase();
      await db.query('SELECT 1');
      dbFindings.push({ id: 'database.connection', label: 'Database connection', status: 'pass', detail: `Connected using the ${db.driver} driver.` });
      try {
        const admins = await db.query<{ total: string; with_mfa: string }>(
          `SELECT COUNT(*)::text AS total, COUNT(*) FILTER (WHERE mfa_enabled)::text AS with_mfa
           FROM users WHERE role = 'admin' AND status = 'active'`,
        );
        const total = Number(admins.rows[0]?.total ?? 0);
        const withMfa = Number(admins.rows[0]?.with_mfa ?? 0);
        adminMfaEnforced = total > 0 && withMfa === total;
        dbFindings.push({
          id: 'security.admin_mfa_db', label: 'Administrator MFA (database)',
          status: adminMfaEnforced ? 'pass' : 'fail',
          detail: `${withMfa} of ${total} active administrator account(s) have MFA enabled.`,
          fix: adminMfaEnforced ? undefined : 'Enrol every active administrator in TOTP MFA. Production blocks privileged routes without it.',
        });
      } catch {
        dbFindings.push({ id: 'security.admin_mfa_db', label: 'Administrator MFA (database)', status: 'warn', detail: 'The users table could not be read; run migrations before go-live.' });
      }
      try {
        const policies = await db.query<{ code: string; real_money_allowed: boolean; allowed_providers: unknown }>(
          `SELECT code, real_money_allowed, allowed_providers FROM jurisdiction_policies WHERE code = 'ZW'`,
        );
        const zw = policies.rows[0];
        if (!zw) {
          dbFindings.push({ id: 'policy.zw', label: 'Zimbabwe jurisdiction policy', status: 'fail', detail: 'No ZW jurisdiction policy exists.', fix: 'Run migrations, then set the ZW policy from Admin → Compliance.' });
        } else if (!zw.real_money_allowed) {
          dbFindings.push({ id: 'policy.zw', label: 'Zimbabwe jurisdiction policy', status: 'fail', detail: 'The ZW policy still forbids real-money competitions.', fix: 'Only after legal and licence approval, set the ZW policy to allow real-money competitions through Admin → Compliance (requires MFA, a reason and confirmation).' });
        } else {
          dbFindings.push({ id: 'policy.zw', label: 'Zimbabwe jurisdiction policy', status: 'pass', detail: `ZW allows real-money competitions with providers: ${JSON.stringify(zw.allowed_providers)}.` });
        }
      } catch {
        dbFindings.push({ id: 'policy.zw', label: 'Zimbabwe jurisdiction policy', status: 'warn', detail: 'jurisdiction_policies could not be read; run migrations before go-live.' });
      }
    } catch (error) {
      dbFindings.push({ id: 'database.connection', label: 'Database connection', status: 'fail', detail: `Could not connect: ${(error as Error).message}` });
    } finally {
      if (db) await db.close().catch(() => undefined);
    }
  }

  const networkFindings: PreflightCheck[] = [];
  if (wantsNetwork) {
    networkFindings.push(...await probeNetwork());
  }

  const result = runPreflight({
    nodeEnv: env.nodeEnv,
    sessionSecret: env.sessionSecret,
    publicOrigin: env.publicOrigin,
    dbDriver: env.dbDriver,
    databaseUrl: env.databaseUrl,
    allowEmbeddedDb: env.allowEmbeddedInProduction,
    emailProblems: emailProblems(env.email),
    emailProvider: env.email.provider,
    emailVerified: smtp,
    providers,
    operatingMode: env.operatingMode,
    legalAuthorisationVerified: env.legalAuthorisationVerified,
    providerApprovalVerified: env.providerApprovalVerified,
    ageVerificationProvider: env.ageVerificationProvider,
    ageVerificationWebhookSecret: env.ageVerificationWebhookSecret,
    complianceSigningKey: env.complianceSigningKey,
    activationPath: env.complianceActivationPath,
    activation: {
      present: fs.existsSync(env.complianceActivationPath),
      valid: !!activation.manifest && !activation.error,
      error: activation.error,
      expiresAt: activation.manifest?.expiresAt ?? null,
    },
    adminMfaEnforced,
  });

  const liveFindings = [...dbFindings, ...networkFindings];
  if (wantsJson) {
    console.log(JSON.stringify({ ...result, database: dbFindings, network: networkFindings }, null, 2));
    process.exitCode = result.readyForRealMoney && liveFindings.every((c) => c.status !== 'fail') ? 0 : 1;
    return;
  }

  console.log(colour.bold('\nRookstone Arena — go-live preflight'));
  console.log(colour.dim(`  origin ${env.publicOrigin} · mode ${env.operatingMode} · mail ${env.email.provider} · db ${env.dbDriver}\n`));
  for (const item of result.checks) render(item);
  if (liveFindings.length) {
    console.log(colour.bold('\nLive checks'));
    for (const item of liveFindings) render(item);
  }

  const allBlockers = [...result.blockers, ...liveFindings.filter((c) => c.status === 'fail')];
  const allWarnings = [...result.warnings, ...liveFindings.filter((c) => c.status === 'warn')];
  console.log('');
  if (allBlockers.length === 0) {
    console.log(colour.pass(colour.bold('No blockers found. Real-money mode can be activated.')));
    if (allWarnings.length) console.log(colour.warn(`${allWarnings.length} warning(s) still need an operator decision.`));
  } else {
    console.log(colour.fail(colour.bold(`${allBlockers.length} blocker(s) must be resolved before real money can be accepted:`)));
    for (const item of allBlockers) console.log(colour.fail(`  • ${item.label}: ${item.detail}`));
    if (allWarnings.length) console.log(colour.warn(`\n${allWarnings.length} warning(s): ${allWarnings.map((w) => w.label).join(', ')}`));
  }
  const skipped = result.checks.filter((c) => c.status === 'skip');
  if (skipped.length && !wantsSmtp) {
    console.log(colour.dim('\nNot tested: SMTP handshake. Run `npm run preflight -- --smtp` to verify Gmail delivery.'));
  }
  if (!wantsNetwork) {
    console.log(colour.dim('Not tested: public origin and provider reachability. Run `npm run preflight -- --network`.'));
  }
  console.log(colour.dim('\nDetails and documents: docs/GO-LIVE.md · payments: docs/PAYMENTS.md\n'));
  process.exitCode = allBlockers.length ? 1 : 0;
}

async function reachable(label: string, url: string): Promise<PreflightCheck> {
  const id = `network.${label.replace(/\s+/g, '-')}`;
  try {
    const response = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(8_000) });
    return {
      id, label: `Reachability: ${label}`, status: 'pass',
      detail: `Received HTTP ${response.status} from ${url}. Any HTTP answer proves DNS and egress work.`,
    };
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause?.code;
    return {
      id, label: `Reachability: ${label}`, status: 'fail',
      detail: `Could not reach ${url}: ${(error as Error).message}${cause ? ` (${cause})` : ''}`,
      fix: 'Check DNS, the hosting egress rules and the provider base URL. Provider callbacks also need to reach PUBLIC_ORIGIN over HTTPS.',
    };
  }
}

async function probeNetwork(): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [];
  if (env.publicOrigin) {
    checks.push(await reachable('public origin', `${env.publicOrigin.replace(/\/+$/, '')}/api/health`));
  }
  const bases: Array<[string, string]> = [];
  if (env.providers.paynow.enabled) bases.push(['paynow', env.providers.paynow.baseUrl]);
  if (env.providers.ecocash.enabled) bases.push(['ecocash', env.providers.ecocash.eipBaseUrl || env.providers.ecocash.baseUrl]);
  if (env.providers.pesepay.enabled) bases.push(['pesepay', env.providers.pesepay.baseUrl]);
  for (const [name, url] of bases) {
    if (!url) continue;
    checks.push(await reachable(name, url));
  }
  return checks;
}

void main().catch((error) => {
  console.error('Preflight failed to run:', error);
  process.exit(1);
});
