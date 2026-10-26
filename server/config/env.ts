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

export const env = {
  root,
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProduction: process.env.NODE_ENV === 'production',
  port: int(process.env.PORT, 3001),
  host: process.env.HOST ?? '0.0.0.0',
  publicOrigin: process.env.PUBLIC_ORIGIN ?? 'http://localhost:5173',
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(',').map((s) => s.trim()).filter(Boolean),
  databaseUrl: process.env.DATABASE_URL ?? '',
  dbDriver: (process.env.DB_DRIVER ?? (process.env.DATABASE_URL ? 'postgres' : 'pglite')) as 'postgres' | 'pglite',
  pgliteDir: process.env.PGLITE_DIR ?? path.join(root, 'data', 'pglite'),
  allowEmbeddedInProduction: bool(process.env.ALLOW_EMBEDDED_DB),
  sessionSecret: process.env.SESSION_SECRET ?? '',
  sessionTtlHours: int(process.env.SESSION_TTL_HOURS, 24 * 14),
  trustProxy: int(process.env.TRUST_PROXY, 0),
  smtpUrl: process.env.SMTP_URL ?? '',
  emailFrom: process.env.EMAIL_FROM ?? 'Rookstone Arena <no-reply@example.invalid>',
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

export function assertProductionSafety(): void {
  if (!env.isProduction) return;
  if (!env.sessionSecret || env.sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be set to at least 32 characters in production');
  }
  if (env.dbDriver === 'pglite' && !env.allowEmbeddedInProduction) {
    throw new Error('Set DATABASE_URL with PostgreSQL or explicitly set ALLOW_EMBEDDED_DB=true for a single-node installation');
  }
}
