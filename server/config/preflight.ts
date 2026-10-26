/**
 * Real-money readiness checks.
 *
 * The functions here are pure: they take a snapshot of the deployment's
 * configuration and return findings. `scripts/preflight.ts` gathers the
 * snapshot, performs the optional live checks (SMTP handshake, database
 * connection) and renders the result. Keeping the rules pure makes the
 * go-live gate testable without touching the environment or the network.
 */

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface PreflightCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export interface PreflightProvider {
  id: string;
  name: string;
  enabled: boolean;
  configured: boolean;
  sandbox: boolean;
  merchantApproved: boolean;
  enabledForRealMoney: boolean;
  capabilities: string[];
  reason: string;
}

export interface PreflightInput {
  nodeEnv: string;
  sessionSecret: string;
  publicOrigin: string;
  dbDriver: string;
  databaseUrl: string;
  allowEmbeddedDb: boolean;
  emailProblems: string[];
  emailProvider: string;
  emailVerified?: { ok: boolean; reason?: string };
  providers: PreflightProvider[];
  operatingMode: string;
  legalAuthorisationVerified: boolean;
  providerApprovalVerified: boolean;
  ageVerificationProvider: string;
  ageVerificationWebhookSecret: string;
  complianceSigningKey: string;
  activationPath: string;
  activation: { present: boolean; valid: boolean; error: string | null; expiresAt: string | null };
  adminMfaEnforced?: boolean | null;
  now?: number;
}

export interface PreflightResult {
  checks: PreflightCheck[];
  blockers: PreflightCheck[];
  warnings: PreflightCheck[];
  readyForRealMoney: boolean;
}

const check = (
  id: string,
  label: string,
  status: CheckStatus,
  detail: string,
  fix?: string,
): PreflightCheck => ({ id, label, status, detail, fix });

const isLocalOrigin = (origin: string): boolean =>
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin.replace(/\/+$/, ''));

function providerChecks(providers: PreflightProvider[]): PreflightCheck[] {
  return providers.map((provider) => {
    const upper = provider.id.toUpperCase();
    if (!provider.enabled) {
      return check(
        `provider.${provider.id}.enabled`,
        `${provider.name} enabled`,
        'skip',
        `${provider.name} is disabled (${upper}_ENABLED=false). Deposits and payouts through this provider are refused.`,
        `Set ${upper}_ENABLED=true only after merchant approval.`,
      );
    }
    if (provider.sandbox) {
      return check(
        `provider.${provider.id}.live`,
        `${provider.name} live credentials`,
        'fail',
        `${provider.name} still points at the sandbox/test environment (${provider.reason}).`,
        `Set ${upper}_LIVE=true (or the provider's SANDBOX=false) with production credentials issued by the provider.`,
      );
    }
    if (!provider.merchantApproved || !provider.enabledForRealMoney) {
      // A provider can be enabled but unusable: missing keys, missing payout
      // credentials, or no recorded merchant approval.
      if (!provider.configured) {
        return check(
          `provider.${provider.id}.configured`,
          `${provider.name} credentials`,
          'fail',
          `${provider.name} is enabled but its credentials are incomplete: ${provider.reason}`,
          'Complete the provider credentials or set the ENABLED flag back to false. An enabled provider that cannot be called will refuse every operation.',
        );
      }
      return check(
        `provider.${provider.id}.approved`,
        `${provider.name} merchant approval`,
        'fail',
        `${provider.name} is enabled with live credentials but is not ready for real money: ${provider.reason}`,
        `Set ${upper}_MERCHANT_APPROVED=true only when the provider has approved this merchant account and use case in writing, and complete any missing channel credentials shown above.`,
      );
    }
    const channels: string[] = [];
    if (provider.capabilities.some((c) => c.startsWith('deposit'))) channels.push('deposits');
    if (provider.capabilities.includes('merchant-payout')) channels.push('payouts');
    if (!provider.configured) {
      // EcoCash EPG-only: payouts work, deposits through this provider do not.
      return check(
        `provider.${provider.id}.approved`,
        `${provider.name} payout-only`,
        'warn',
        `${provider.name} is approved for real money but only its payout channel is configured (${provider.reason}). Deposits through this provider are refused.`,
        `Either complete the ${provider.name} deposit credentials or route deposits through another approved provider.`,
      );
    }
    return check(
      `provider.${provider.id}.approved`,
      `${provider.name} ready`,
      'pass',
      `${provider.name} has live credentials and recorded merchant approval. Channels: ${channels.join(', ') || 'none'}.`,
    );
  });
}

export function runPreflight(input: PreflightInput): PreflightResult {
  const now = input.now ?? Date.now();
  const checks: PreflightCheck[] = [];
  const production = input.nodeEnv === 'production';

  // ------------------------------------------------------------- runtime
  checks.push(production
    ? check('runtime.node_env', 'NODE_ENV', 'pass', 'NODE_ENV=production.')
    : check('runtime.node_env', 'NODE_ENV', 'fail', `NODE_ENV is "${input.nodeEnv}".`, 'Deploy with NODE_ENV=production before accepting real money.'));

  checks.push(/^https:\/\//i.test(input.publicOrigin)
    ? check('runtime.public_origin', 'Public origin', 'pass', `PUBLIC_ORIGIN is ${input.publicOrigin}.`)
    : check('runtime.public_origin', 'Public origin', 'fail',
      isLocalOrigin(input.publicOrigin)
        ? `PUBLIC_ORIGIN is ${input.publicOrigin}, so provider result callbacks cannot reach this server.`
        : `PUBLIC_ORIGIN (${input.publicOrigin || 'unset'}) is not an HTTPS origin.`,
      'Set PUBLIC_ORIGIN to the exact public HTTPS origin, for example https://chess.yourdomain.co.zw. Paynow, EcoCash and PesePay must be able to POST results to /api/payments/webhook/<provider>.'));

  checks.push(input.sessionSecret.length >= 32
    ? check('runtime.session_secret', 'Session secret', 'pass', 'SESSION_SECRET has at least 32 characters.')
    : check('runtime.session_secret', 'Session secret', 'fail',
      'SESSION_SECRET is missing or shorter than 32 characters.',
      'Generate one with `openssl rand -hex 32` and store it in the hosting secret store.'));

  // ------------------------------------------------------------ database
  if (input.dbDriver === 'postgres' && input.databaseUrl) {
    checks.push(check('database.driver', 'Database', 'pass', 'PostgreSQL via DATABASE_URL.'));
  } else if (input.dbDriver === 'pglite' && input.allowEmbeddedDb) {
    checks.push(check('database.driver', 'Database', 'warn',
      'The embedded database is enabled. A single node backed by local files cannot survive a redeploy or scale beyond one instance.',
      'Move to managed PostgreSQL before real money. Embedded mode has no point-in-time recovery.'));
  } else {
    checks.push(check('database.driver', 'Database', 'fail',
      'No production database is configured (DATABASE_URL is empty and the embedded database is not explicitly allowed).',
      'Provision managed PostgreSQL and set DATABASE_URL with sslmode=require.'));
  }

  // --------------------------------------------------------------- email
  if (input.emailProblems.length === 0) {
    checks.push(check('email.configured', 'Email delivery', 'pass', `SMTP is configured (${input.emailProvider}).`));
  } else {
    checks.push(check('email.configured', 'Email delivery', 'fail',
      input.emailProblems.join('; '),
      'Set EMAIL_PROVIDER=gmail, SMTP_USER and SMTP_PASS (a 16-character Google App Password), or SMTP_URL for another provider. Password reset and email verification are unavailable without working email.'));
  }
  if (input.emailVerified) {
    checks.push(input.emailVerified.ok
      ? check('email.connection', 'SMTP connection', 'pass', 'The SMTP server accepted the credentials.')
      : check('email.connection', 'SMTP connection', 'fail',
        input.emailVerified.reason ?? 'The SMTP server rejected the credentials.',
        'Fix the SMTP settings, then run `npm run preflight -- --smtp`.'));
  } else {
    checks.push(check('email.connection', 'SMTP connection', 'skip', 'Not tested. Re-run with `npm run preflight -- --smtp` to open a real SMTP session.'));
  }

  // ----------------------------------------------------------- providers
  checks.push(...providerChecks(input.providers));

  const liveDeposit = input.providers.filter((p) => p.enabled && !p.sandbox && p.enabledForRealMoney
    && p.capabilities.some((c) => c.startsWith('deposit')));
  checks.push(liveDeposit.length
    ? check('payments.deposits', 'Deposit provider', 'pass', `Real-money deposits: ${liveDeposit.map((p) => p.name).join(', ')}.`)
    : check('payments.deposits', 'Deposit provider', 'fail',
      'No provider is ready to accept real-money deposits.',
      'Approve at least one provider (Paynow, EcoCash Instant Payments or PesePay) and enable it with live credentials.'));

  const livePayout = input.providers.filter((p) => p.enabled && !p.sandbox && p.enabledForRealMoney
    && p.capabilities.includes('merchant-payout'));
  checks.push(livePayout.length
    ? check('payments.withdrawals', 'Withdrawal provider', 'pass', `Real-money withdrawals: ${livePayout.map((p) => p.name).join(', ')}.`)
    : check('payments.withdrawals', 'Withdrawal provider', 'fail',
      'No provider can pay customers out. Accepting deposits without a working payout path leaves player balances locked in the platform.',
      'Complete the EcoCash EPG Merchant-to-Subscriber credentials (ECOCASH_CLIENT_ID, ECOCASH_CLIENT_SECRET, ECOCASH_API_USERNAME, ECOCASH_EPG_ENCRYPTED_PASSWORD) or integrate an approved payout provider. Paynow and PesePay do not publish a merchant payout API for this integration.'));

  // ---------------------------------------------------------- compliance
  checks.push(input.operatingMode === 'real'
    ? check('compliance.mode', 'Operating mode', 'pass', 'OPERATING_MODE=real.')
    : check('compliance.mode', 'Operating mode', 'fail',
      `OPERATING_MODE is "${input.operatingMode}", so real-money competitions and withdrawals stay disabled.`,
      'Set OPERATING_MODE=real only after every item in docs/COMPLIANCE.md is satisfied.'));

  checks.push(input.legalAuthorisationVerified
    ? check('compliance.legal', 'Legal authorisation', 'pass', 'LEGAL_AUTHORISATION_VERIFIED=true.')
    : check('compliance.legal', 'Legal authorisation', 'fail',
      'Legal authorisation for real-money competition is not verified.',
      'Obtain a written legal opinion for the exact competition format and jurisdiction, then set LEGAL_AUTHORISATION_VERIFIED=true. This flag is a human assertion; the software cannot verify it.'));

  checks.push(input.providerApprovalVerified
    ? check('compliance.provider_approval', 'Provider approval', 'pass', 'PROVIDER_MERCHANT_APPROVAL_VERIFIED=true.')
    : check('compliance.provider_approval', 'Provider approval', 'fail',
      'Payment-provider approval for the wagering use case is not verified.',
      'Get written provider approval that explicitly covers paid chess competitions, then set PROVIDER_MERCHANT_APPROVAL_VERIFIED=true.'));

  checks.push(input.ageVerificationProvider
    ? check('compliance.age_provider', 'Age verification', 'pass', `Provider: ${input.ageVerificationProvider}.`)
    : check('compliance.age_provider', 'Age verification', 'fail',
      'No 18+ identity/age verification provider is configured.',
      'Contract an identity provider that supports Zimbabwe, set AGE_VERIFICATION_PROVIDER and implement its signed callback to /api/auth/age-verification.'));

  checks.push(input.ageVerificationWebhookSecret.length >= 32
    ? check('compliance.age_webhook', 'Age webhook secret', 'pass', 'The age-verification webhook secret is set.')
    : check('compliance.age_webhook', 'Age webhook secret', 'fail',
      'AGE_VERIFICATION_WEBHOOK_SECRET is missing or shorter than 32 characters.',
      'Agree a shared HMAC secret with the identity provider and store it as AGE_VERIFICATION_WEBHOOK_SECRET.'));

  checks.push(input.complianceSigningKey.length >= 32
    ? check('compliance.signing_key', 'Activation signing key', 'pass', 'COMPLIANCE_SIGNING_KEY is set.')
    : check('compliance.signing_key', 'Activation signing key', 'fail',
      'COMPLIANCE_SIGNING_KEY is missing or shorter than 32 characters.',
      'Create a separate key, keep it out of the application secret store, then sign the activation manifest.'));

  checks.push(input.activation.present && input.activation.valid
    ? check('compliance.activation', 'Activation manifest', 'pass', 'The signed activation manifest is present and its signature verifies.')
    : check('compliance.activation', 'Activation manifest', 'fail',
      input.activation.error ?? 'The signed activation manifest is not valid.',
      `Create a draft with \`npm run compliance:draft\`, have a compliance officer approve it, then sign it (see docs/COMPLIANCE.md) and set COMPLIANCE_ACTIVATION_PATH (currently ${input.activationPath}).`));

  if (input.activation.valid && input.activation.expiresAt) {
    const expires = Date.parse(input.activation.expiresAt);
    if (Number.isFinite(expires)) {
      const days = Math.floor((expires - now) / 86_400_000);
      checks.push(days >= 0 && days < 30
        ? check('compliance.activation_expiry', 'Activation expiry', 'warn', `The activation manifest expires in ${days} day(s).`, 'Re-review and re-sign the manifest before it expires; an expired manifest disables real money at the next restart.')
        : check('compliance.activation_expiry', 'Activation expiry', 'pass', `The activation manifest expires ${new Date(expires).toISOString()}.`));
    }
  }

  // ------------------------------------------------------------ security
  if (input.adminMfaEnforced == null) {
    checks.push(check('security.admin_mfa', 'Administrator MFA', 'skip', 'Cannot be checked from configuration: production requires every administrator to enrol MFA, and the server blocks privileged routes without it.'));
  } else {
    checks.push(input.adminMfaEnforced
      ? check('security.admin_mfa', 'Administrator MFA', 'pass', 'At least one administrator has MFA enabled and production enforcement is on.')
      : check('security.admin_mfa', 'Administrator MFA', 'fail', 'No administrator has MFA enabled.', 'Enrol every administrator in TOTP MFA before go-live.'));
  }

  const blockers = checks.filter((c) => c.status === 'fail');
  const warnings = checks.filter((c) => c.status === 'warn');
  return { checks, blockers, warnings, readyForRealMoney: blockers.length === 0 };
}
