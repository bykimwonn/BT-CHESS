import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Compiled output lives under dist-server/; the deployable cwd is the repo root.
const root = fs.existsSync(path.join(sourceRoot, 'package.json')) ? sourceRoot : process.cwd();
const bool = (value: string | undefined, fallback = false) =>
  value === undefined ? fallback : /^(1|true|yes|on)$/i.test(value);
const int = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
};
const trimOrigin = (value: string) => value.trim().replace(/\/+$/, '');
/** Render injects its own public URL, so a missing PUBLIC_ORIGIN is recoverable there. */
const platformOrigin = (() => {
  const renderUrl = trimOrigin(process.env.RENDER_EXTERNAL_URL ?? '');
  if (renderUrl) return renderUrl;
  const renderHost = (process.env.RENDER_EXTERNAL_HOSTNAME ?? '').trim();
  return renderHost ? `https://${renderHost}` : '';
})();
const publicOriginOverride = trimOrigin(process.env.PUBLIC_ORIGIN ?? '');
const corsOriginsOverride = (process.env.CORS_ORIGINS ?? '').trim();
export const DEFAULT_PUBLIC_ORIGIN = 'http://localhost:5173';
const effectivePublicOrigin = publicOriginOverride || platformOrigin || DEFAULT_PUBLIC_ORIGIN;

export type PublicOriginSource = 'explicit' | 'platform' | 'default';
const publicOriginSource: PublicOriginSource =
  publicOriginOverride ? 'explicit' : platformOrigin ? 'platform' : 'default';

// ---------------------------------------------------------------- email
// Three supported shapes, in priority order:
//   1. SMTP_URL              full connection string (kept for compatibility)
//   2. EMAIL_PROVIDER=gmail  smtp.gmail.com with an App Password
//   3. SMTP_HOST/PORT/...    any other SMTP server
const emailProviderRaw = (process.env.EMAIL_PROVIDER ?? '').trim().toLowerCase();
const emailProvider: EmailProvider =
  emailProviderRaw === 'gmail' || emailProviderRaw === 'smtp' || emailProviderRaw === 'none'
    ? emailProviderRaw
    : process.env.SMTP_URL ? 'smtp'
      : process.env.SMTP_HOST ? 'smtp'
        : process.env.GMAIL_USER || process.env.SMTP_USER ? 'gmail'
          : 'none';
const smtpHost = (process.env.SMTP_HOST ?? (emailProvider === 'gmail' ? 'smtp.gmail.com' : '')).trim();
const smtpPort = int(process.env.SMTP_PORT, emailProvider === 'gmail' ? 465 : 587);
const smtpSecure = process.env.SMTP_SECURE === undefined
  ? smtpPort === 465
  : bool(process.env.SMTP_SECURE);
const smtpUser = (process.env.SMTP_USER ?? process.env.GMAIL_USER ?? '').trim();
// Gmail requires a 16-character App Password; the normal account password is
// rejected by Google even when it is correct.
const smtpPass = process.env.SMTP_PASS ?? process.env.GMAIL_APP_PASSWORD ?? '';
const emailFromExplicit = (process.env.EMAIL_FROM ?? '').trim();
const emailFrom = emailFromExplicit
  || (smtpUser ? `Rookstone Arena <${smtpUser}>` : 'Rookstone Arena <no-reply@example.invalid>');
const emailReplyTo = (process.env.EMAIL_REPLY_TO ?? '').trim();

export type EmailProvider = 'gmail' | 'smtp' | 'none';

export interface EmailSettings {
  provider: EmailProvider;
  smtpUrl: string;
  host: string;
  port: number;
  secure: boolean;
  requireTls: boolean;
  user: string;
  pass: string;
  from: string;
  fromExplicit: boolean;
  replyTo: string;
}

export const env = {
  root,
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProduction: process.env.NODE_ENV === 'production',
  port: int(process.env.PORT, 3001),
  host: process.env.HOST ?? '0.0.0.0',
  publicOrigin: effectivePublicOrigin,
  publicOriginSource,
  corsOrigins: (corsOriginsOverride || effectivePublicOrigin)
    .split(',').map((s) => trimOrigin(s)).filter(Boolean),
  databaseUrl: process.env.DATABASE_URL ?? '',
  dbDriver: (process.env.DB_DRIVER ?? (process.env.DATABASE_URL ? 'postgres' : 'pglite')) as 'postgres' | 'pglite',
  pgliteDir: process.env.PGLITE_DIR ?? path.join(root, 'data', 'pglite'),
  allowEmbeddedInProduction: bool(process.env.ALLOW_EMBEDDED_DB),
  sessionSecret: process.env.SESSION_SECRET ?? '',
  sessionTtlHours: int(process.env.SESSION_TTL_HOURS, 24 * 14),
  trustProxy: int(process.env.TRUST_PROXY, 0),
  smtpUrl: process.env.SMTP_URL ?? '',
  emailFrom,
  email: {
    provider: emailProvider,
    smtpUrl: (process.env.SMTP_URL ?? '').trim(),
    host: smtpHost,
    port: smtpPort,
    secure: smtpSecure,
    requireTls: bool(process.env.SMTP_REQUIRE_TLS),
    user: smtpUser,
    pass: smtpPass,
    from: emailFrom,
    fromExplicit: !!emailFromExplicit,
    replyTo: emailReplyTo,
  } satisfies EmailSettings,
  logLevel: process.env.LOG_LEVEL ?? 'info',
  operatingMode: (process.env.OPERATING_MODE ?? 'free') as 'free' | 'test' | 'real',
  legalAuthorisationVerified: bool(process.env.LEGAL_AUTHORISATION_VERIFIED),
  providerApprovalVerified: bool(process.env.PROVIDER_MERCHANT_APPROVAL_VERIFIED),
  complianceActivationPath: process.env.COMPLIANCE_ACTIVATION_PATH ?? path.join(root, 'config', 'compliance-activation.json'),
  complianceSigningKey: process.env.COMPLIANCE_SIGNING_KEY ?? '',
  ageVerificationProvider: process.env.AGE_VERIFICATION_PROVIDER ?? '',
  ageVerificationWebhookSecret: process.env.AGE_VERIFICATION_WEBHOOK_SECRET ?? '',
  testFundsEnabled: bool(process.env.TEST_FUNDS_ENABLED, process.env.OPERATING_MODE === 'test'),
  engineEnabled: bool(process.env.ENGINE_ENABLED, true),
  engineMaxConcurrent: int(process.env.ENGINE_MAX_CONCURRENT, 2),
  engineMaxDepth: int(process.env.ENGINE_MAX_DEPTH, 18),
  engineMaxTimeMs: int(process.env.ENGINE_MAX_TIME_MS, 1500),
  providers: {
    paynow: {
      enabled: bool(process.env.PAYNOW_ENABLED),
      sandbox: !bool(process.env.PAYNOW_LIVE),
      merchantApproved: bool(process.env.PAYNOW_MERCHANT_APPROVED),
      id: process.env.PAYNOW_INTEGRATION_ID ?? '',
      key: process.env.PAYNOW_INTEGRATION_KEY ?? '',
      baseUrl: process.env.PAYNOW_BASE_URL ?? 'https://www.paynow.co.zw',
    },
    ecocash: {
      enabled: bool(process.env.ECOCASH_ENABLED),
      merchantApproved: bool(process.env.ECOCASH_MERCHANT_APPROVED),
      sandbox: bool(process.env.ECOCASH_SANDBOX, true),
      // EPG serviceRequest endpoint used for merchant-to-subscriber payouts.
      baseUrl: process.env.ECOCASH_BASE_URL ?? 'https://developers.ecocash.co.zw/api/serviceRequest',
      clientId: process.env.ECOCASH_CLIENT_ID ?? '',
      clientSecret: process.env.ECOCASH_CLIENT_SECRET ?? '',
      username: process.env.ECOCASH_API_USERNAME ?? '',
      // The EPG channel password is encrypted on the EcoCash credentials page;
      // the encryption method is not published, so we accept the encrypted value.
      encryptedPassword: process.env.ECOCASH_EPG_ENCRYPTED_PASSWORD ?? '',
      // Instant Payments (customer PIN prompt) credentials. No customer PIN is
      // ever collected or stored by Rookstone.
      eipBaseUrl: process.env.ECOCASH_EIP_BASE_URL ?? 'https://developers.ecocash.co.zw/sandbox/payment/v1',
      eipUsername: process.env.ECOCASH_EIP_USERNAME ?? '',
      eipPassword: process.env.ECOCASH_EIP_PASSWORD ?? '',
      merchantCode: process.env.ECOCASH_MERCHANT_CODE ?? '',
      merchantApiPin: process.env.ECOCASH_MERCHANT_API_PIN ?? '',
      merchantNumber: process.env.ECOCASH_MERCHANT_NUMBER ?? '',
      terminalId: process.env.ECOCASH_TERMINAL_ID ?? '',
      merchantName: process.env.ECOCASH_MERCHANT_NAME ?? '',
      superMerchantName: process.env.ECOCASH_SUPER_MERCHANT_NAME ?? '',
      webhookSecret: process.env.ECOCASH_WEBHOOK_SECRET ?? '',
    },
    onemoney: {
      enabled: bool(process.env.ONEMONEY_ENABLED),
      sandbox: bool(process.env.ONEMONEY_SANDBOX, true),
      baseUrl: process.env.ONEMONEY_BASE_URL ?? '',
      merchantId: process.env.ONEMONEY_MERCHANT_ID ?? '',
      apiKey: process.env.ONEMONEY_API_KEY ?? '',
      webhookSecret: process.env.ONEMONEY_WEBHOOK_SECRET ?? '',
    },
    pesepay: {
      enabled: bool(process.env.PESEPAY_ENABLED),
      merchantApproved: bool(process.env.PESEPAY_MERCHANT_APPROVED),
      sandbox: bool(process.env.PESEPAY_SANDBOX, true),
      baseUrl: process.env.PESEPAY_BASE_URL ?? 'https://api.pesepay.com',
      integrationKey: process.env.PESEPAY_INTEGRATION_KEY ?? '',
      encryptionKey: process.env.PESEPAY_ENCRYPTION_KEY ?? '',
    },
  },
};

export class ConfigurationError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid production configuration:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.name = 'ConfigurationError';
    this.problems = problems;
  }
}

/**
 * Fail-closed startup validation. Every problem is collected so an operator can
 * fix the whole environment in one pass instead of restarting for each missing
 * setting. Production must never start with a weak session secret or with an
 * unintended embedded database.
 */
export function assertProductionSafety(): void {
  if (!env.isProduction) return;
  const problems: string[] = [];
  if (!env.sessionSecret || env.sessionSecret.length < 32) {
    problems.push('SESSION_SECRET must be set to at least 32 random characters (generate with `openssl rand -hex 32`).');
  }
  if (env.dbDriver === 'pglite' && !env.allowEmbeddedInProduction) {
    problems.push('DATABASE_URL must point at PostgreSQL, or ALLOW_EMBEDDED_DB=true must be set explicitly for an intentional single-node installation.');
  }
  if (publicOriginSource === 'default') {
    problems.push('PUBLIC_ORIGIN must be the exact HTTPS origin users open (for example https://chess.example.com).');
  } else if (!/^https:\/\//i.test(env.publicOrigin) && !/localhost|127\.0\.0\.1/i.test(env.publicOrigin)) {
    problems.push('PUBLIC_ORIGIN must use https:// in production so session cookies and WebSocket origins are trustworthy.');
  }
  if (problems.length) throw new ConfigurationError(problems);
}
