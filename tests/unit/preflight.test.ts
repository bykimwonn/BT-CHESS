import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPreflight, type PreflightInput, type PreflightProvider } from '../../server/config/preflight.js';

const readyProvider = (overrides: Partial<PreflightProvider> = {}): PreflightProvider => ({
  id: 'paynow', name: 'Paynow', enabled: true, configured: true, sandbox: false,
  merchantApproved: true, enabledForRealMoney: true,
  capabilities: ['deposit-redirect', 'signed-status-hash', 'poll-status'],
  reason: 'Configured', ...overrides,
});

const payoutProvider = (): PreflightProvider => ({
  id: 'ecocash', name: 'EcoCash', enabled: true, configured: true, sandbox: false,
  merchantApproved: true, enabledForRealMoney: true,
  capabilities: ['deposit-charge', 'server-status-lookup', 'refund', 'merchant-payout'],
  reason: 'Configured',
});

const base = (overrides: Partial<PreflightInput> = {}): PreflightInput => ({
  nodeEnv: 'production',
  sessionSecret: 'a'.repeat(64),
  publicOrigin: 'https://chess.example.co.zw',
  dbDriver: 'postgres',
  databaseUrl: 'postgresql://user:pass@db:5432/rookstone?sslmode=require',
  allowEmbeddedDb: false,
  emailProblems: [],
  emailProvider: 'gmail',
  emailVerified: { ok: true },
  providers: [readyProvider(), payoutProvider()],
  operatingMode: 'real',
  legalAuthorisationVerified: true,
  providerApprovalVerified: true,
  ageVerificationProvider: 'ApprovedProvider',
  ageVerificationWebhookSecret: 'w'.repeat(48),
  complianceSigningKey: 'k'.repeat(48),
  activationPath: '/run/secrets/activation.json',
  activation: { present: true, valid: true, error: null, expiresAt: new Date(Date.now() + 200 * 86_400_000).toISOString() },
  adminMfaEnforced: true,
  now: Date.now(),
  ...overrides,
});

test('a fully evidenced deployment has no blockers', () => {
  const result = runPreflight(base());
  assert.equal(result.readyForRealMoney, true, JSON.stringify(result.blockers, null, 2));
  assert.equal(result.blockers.length, 0);
  assert.equal(result.warnings.length, 0);
  assert.ok(result.checks.some((c) => c.id === 'payments.deposits' && c.status === 'pass'));
  assert.ok(result.checks.some((c) => c.id === 'payments.withdrawals' && c.status === 'pass'));
});

test('missing activation manifest blocks real money with the signing guidance', () => {
  const result = runPreflight(base({
    activation: { present: false, valid: false, error: 'Signed compliance activation manifest is not present', expiresAt: null },
  }));
  const blocker = result.blockers.find((c) => c.id === 'compliance.activation');
  assert.ok(blocker);
  assert.match(blocker!.fix ?? '', /compliance:draft/);
  assert.equal(result.readyForRealMoney, false);
});

test('an expired or invalid signature is a blocker, not a warning', () => {
  const result = runPreflight(base({
    activation: { present: true, valid: false, error: 'Activation manifest signature is invalid', expiresAt: null },
  }));
  assert.ok(result.blockers.some((c) => c.id === 'compliance.activation'));
});

test('an activation manifest expiring within 30 days only warns', () => {
  const result = runPreflight(base({
    activation: { present: true, valid: true, error: null, expiresAt: new Date(Date.now() + 10 * 86_400_000).toISOString() },
  }));
  assert.equal(result.readyForRealMoney, true);
  assert.ok(result.warnings.some((c) => c.id === 'compliance.activation_expiry'));
});

test('sandbox credentials in real mode are rejected', () => {
  const result = runPreflight(base({ providers: [readyProvider({ sandbox: true }), payoutProvider()] }));
  const blocker = result.blockers.find((c) => c.id === 'provider.paynow.live');
  assert.ok(blocker);
  assert.match(blocker!.detail, /sandbox/i);
});

test('an enabled but unconfigured provider fails instead of failing at checkout', () => {
  const result = runPreflight(base({
    providers: [readyProvider({ configured: false, enabledForRealMoney: false }), payoutProvider()],
  }));
  assert.ok(result.blockers.some((c) => c.id === 'provider.paynow.configured'));
});

test('a disabled provider is skipped, not treated as a blocker', () => {
  const provider = readyProvider({ id: 'pesepay', name: 'PesePay', enabled: false, configured: false, enabledForRealMoney: false });
  const result = runPreflight(base({ providers: [readyProvider(), payoutProvider(), provider] }));
  const check = result.checks.find((c) => c.id === 'provider.pesepay.enabled');
  assert.equal(check?.status, 'skip');
  assert.equal(result.readyForRealMoney, true);
});

test('a provider configured only for payouts is a warning, not a blocker', () => {
  const epgOnly: PreflightProvider = {
    ...payoutProvider(), configured: false, capabilities: ['merchant-payout'],
    reason: 'Instant Payments merchant/API credentials are incomplete',
  };
  const result = runPreflight(base({ providers: [readyProvider(), epgOnly] }));
  assert.equal(result.readyForRealMoney, true, JSON.stringify(result.blockers, null, 2));
  assert.equal(result.checks.find((c) => c.id === 'provider.ecocash.approved')?.status, 'warn');
  assert.equal(result.checks.find((c) => c.id === 'payments.withdrawals')?.status, 'pass');
  assert.ok(result.warnings.some((c) => c.id === 'provider.ecocash.approved'));
});

test('deposits without a payout path are a blocker', () => {
  const result = runPreflight(base({ providers: [readyProvider()] }));
  const blocker = result.blockers.find((c) => c.id === 'payments.withdrawals');
  assert.ok(blocker);
  assert.match(blocker!.fix ?? '', /EcoCash EPG/);
});

test('a sandbox payout provider cannot satisfy the withdrawal requirement', () => {
  const result = runPreflight(base({ providers: [readyProvider(), { ...payoutProvider(), sandbox: true }] }));
  assert.ok(result.blockers.some((c) => c.id === 'payments.withdrawals'));
});

test('real mode without the legal assertions is blocked', () => {
  const result = runPreflight(base({
    operatingMode: 'free', legalAuthorisationVerified: false, providerApprovalVerified: false,
    ageVerificationProvider: '', ageVerificationWebhookSecret: '', complianceSigningKey: '',
  }));
  for (const id of ['compliance.mode', 'compliance.legal', 'compliance.provider_approval', 'compliance.age_provider', 'compliance.age_webhook']) {
    assert.ok(result.blockers.some((c) => c.id === id), `${id} should block`);
  }
});

test('a localhost origin cannot receive provider callbacks', () => {
  const result = runPreflight(base({ publicOrigin: 'http://localhost:5173' }));
  const blocker = result.blockers.find((c) => c.id === 'runtime.public_origin');
  assert.ok(blocker);
  assert.match(blocker!.detail, /callbacks cannot reach/);
});

test('missing SMTP configuration is a blocker with Gmail guidance', () => {
  const result = runPreflight(base({ emailProblems: ['SMTP_USER is required', 'SMTP_PASS is required'] }));
  const blocker = result.blockers.find((c) => c.id === 'email.configured');
  assert.ok(blocker);
  assert.match(blocker!.fix ?? '', /App Password/);
});

test('an untested SMTP connection is reported as skipped', () => {
  const result = runPreflight(base({ emailVerified: undefined }));
  assert.equal(result.checks.find((c) => c.id === 'email.connection')?.status, 'skip');
});

test('embedded database and unknown admin MFA are warnings or skips, not blockers', () => {
  const result = runPreflight(base({
    dbDriver: 'pglite', databaseUrl: '', allowEmbeddedDb: true, adminMfaEnforced: null,
  }));
  assert.equal(result.readyForRealMoney, true);
  assert.ok(result.warnings.some((c) => c.id === 'database.driver'));
  assert.equal(result.checks.find((c) => c.id === 'security.admin_mfa')?.status, 'skip');
});

test('an administrator without MFA blocks go-live when checked against the database', () => {
  const result = runPreflight(base({ adminMfaEnforced: false }));
  assert.ok(result.blockers.some((c) => c.id === 'security.admin_mfa'));
});
