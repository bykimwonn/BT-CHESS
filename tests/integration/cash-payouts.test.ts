/* Real-mode cash payouts: hold, settle, cancel and expire.
 *
 * This file configures an authorised real-money platform before the test
 * harness loads, because compliance state is captured at module load. The
 * manifest is signed with a throwaway key: nothing here is a production
 * credential or a real licence. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const SIGNING_KEY = 'integration-test-compliance-signing-key-0123456789';
const activationDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rookstone-activation-'));
const activationPath = path.join(activationDir, 'activation.json');
// helpers.ts sets OPERATING_MODE from TEST_OPERATING_MODE, but this file imports
// the compliance module first, so set both here.
process.env.OPERATING_MODE = 'real';
process.env.TEST_OPERATING_MODE = 'real';
process.env.LEGAL_AUTHORISATION_VERIFIED = 'true';
process.env.PROVIDER_MERCHANT_APPROVAL_VERIFIED = 'true';
process.env.COMPLIANCE_SIGNING_KEY = SIGNING_KEY;
process.env.AGE_VERIFICATION_PROVIDER = 'Test18Plus';
process.env.AGE_VERIFICATION_WEBHOOK_SECRET = 'integration-test-age-verification-secret-0123456789';
process.env.COMPLIANCE_ACTIVATION_PATH = activationPath;
process.env.CASH_AGENTS_ENABLED = 'true';

const { signActivation } = await import('../../server/config/compliance.js');
const manifest = {
  schema: 1 as const,
  jurisdiction: 'ZW',
  legalOpinionRef: 'INTEGRATION-LO-1',
  licenceRef: 'INTEGRATION-LIC-1',
  providerApprovalRef: 'INTEGRATION-PAY-1',
  ageVerificationProvider: 'Test18Plus',
  amlOfficerRef: 'INTEGRATION-AML-1',
  approvedBy: 'Integration Test',
  approvedAt: new Date(Date.now() - 86_400_000).toISOString(),
  expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
};
fs.writeFileSync(activationPath, JSON.stringify({ ...manifest, signature: signActivation(manifest, SIGNING_KEY) }));

const { createHarness, createAdmin } = await import('../helpers.js');

test('real-mode cash payouts hold, settle, cancel and expire with balanced journals', async (t) => {
  const harness = await createHarness();
  t.after(() => {
    fs.rmSync(activationDir, { recursive: true, force: true });
    return harness.close();
  });
  const ctx = harness.ctx;
  assert.equal(ctx.compliance.realMoneyEnabled, true, `real mode must be active: ${ctx.compliance.blockers.join('; ')}`);

  const admin = await createAdmin(ctx, 'PayoutAdmin', 'payout-admin@example.com');
  const adminClient = harness.client();
  await adminClient.login(admin.email, admin.password);

  // A player with the KYC a payout requires, funded at the counter.
  const player = harness.client();
  const registration = await player.register('CashPlayer', 'cash-player@example.com');
  await player.post('/api/auth/verify-email', { token: registration.devVerificationToken });
  const playerId = String(registration.user.id);
  await ctx.db.query('UPDATE users SET age_verified = TRUE, identity_verified = TRUE WHERE id = $1', [playerId]);

  // A second player who has not completed identity checks.
  const unverified = harness.client();
  const unverifiedRegistration = await unverified.register('NoIdPlayer', 'no-id@example.com');
  await unverified.post('/api/auth/verify-email', { token: unverifiedRegistration.devVerificationToken });

  const teller1 = harness.client();
  await teller1.register('TellerCash', 'teller-cash@example.com');
  const teller2 = harness.client();
  await teller2.register('TellerEmpty', 'teller-empty@example.com');

  for (const [username, code, name] of [['TellerCash', 'CASH1', 'Cash Counter'], ['TellerEmpty', 'CASH2', 'Empty Counter']] as const) {
    const created = await adminClient.post('/api/admin/cash-agents', {
      usernameOrEmail: username, code, name, confirm: true, reason: `register ${code} for the payout test`,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
  }
  const agentOne = (await adminClient.get('/api/admin/cash-agents')).body.items.find((row: any) => row.code === 'CASH1');
  assert.ok(agentOne, 'CASH1 must exist');

  const dashboard = await teller1.get('/api/cash/agent');
  assert.equal(dashboard.body.mode, 'real');
  assert.equal(dashboard.body.payoutsEnabled, true);

  // ------------------------------------------------------- fund the counter
  const depositCode = await teller1.post('/api/cash/agent/vouchers', { amountCents: 10_000, playerUsername: 'CashPlayer' });
  assert.equal(depositCode.status, 201, JSON.stringify(depositCode.body));
  assert.equal(depositCode.body.voucher.sandbox, false);
  const redeemed = await player.post('/api/wallet/vouchers/redeem', { code: depositCode.body.code });
  assert.equal(redeemed.status, 200, JSON.stringify(redeemed.body));
  let wallet = await player.get('/api/wallet');
  assert.equal(wallet.body.availableCents, 10_000);

  // ---------------------------------------------------------- hold + settle
  const payout = await player.post('/api/wallet/cash-out', { amountCents: 3_000, agentCode: 'CASH1' });
  assert.equal(payout.status, 201, JSON.stringify(payout.body));
  assert.equal(payout.body.voucher.kind, 'payout');
  assert.equal(payout.body.voucher.status, 'issued');
  wallet = await player.get('/api/wallet');
  assert.equal(wallet.body.availableCents, 7_000);
  assert.equal(wallet.body.reservedCents, 3_000);
  const settled = await teller1.post('/api/cash/agent/payouts/settle', { code: payout.body.code.toLowerCase(), reference: 'ID 63-123456-A-00' });
  assert.equal(settled.status, 200, JSON.stringify(settled.body));
  assert.equal(settled.body.status, 'paid');
  wallet = await player.get('/api/wallet');
  assert.equal(wallet.body.availableCents, 7_000);
  assert.equal(wallet.body.reservedCents, 0);
  const afterSettle = await teller1.get('/api/cash/agent');
  assert.equal(afterSettle.body.agent.cashHeldCents, 7_000, 'cash in the drawer drops by the payout');
  const withdrawal = await ctx.db.query<{ status: string; destination: string }>(
    `SELECT status, destination FROM withdrawals
     WHERE user_id = $1 AND provider = 'cash_agent' ORDER BY requested_at DESC LIMIT 1`,
    [playerId],
  );
  assert.equal(String(withdrawal.rows[0].status), 'completed');
  assert.equal(String(withdrawal.rows[0].destination), 'agent:CASH1');

  // Replaying the same code cannot pay twice.
  const replay = await teller1.post('/api/cash/agent/payouts/settle', { code: payout.body.code });
  assert.equal(replay.status, 409);
  const paidJournals = await ctx.db.query("SELECT COUNT(*)::int AS n FROM ledger_transactions WHERE type = 'withdrawal_cash_paid'");
  assert.equal(Number(paidJournals.rows[0].n), 1);

  // ------------------------------------------------- agent with no cash
  const tooHigh = await player.post('/api/wallet/cash-out', { amountCents: 2_000, agentCode: 'CASH2' });
  assert.equal(tooHigh.status, 201, JSON.stringify(tooHigh.body));
  const noFloat = await teller2.post('/api/cash/agent/payouts/settle', { code: tooHigh.body.code });
  assert.equal(noFloat.status, 409, JSON.stringify(noFloat.body));
  assert.match(String(noFloat.body.error.message), /float is too low/i);

  // Cancelling releases the hold back to the player.
  const cancelled = await teller2.post(`/api/cash/agent/vouchers/${tooHigh.body.voucher.id}/cancel`, {
    reason: 'player could not wait for cash',
  });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  wallet = await player.get('/api/wallet');
  assert.equal(wallet.body.availableCents, 7_000);
  assert.equal(wallet.body.reservedCents, 0);

  // ------------------------------------------------------------- expiry
  const expiring = await player.post('/api/wallet/cash-out', { amountCents: 1_000, agentCode: 'CASH1' });
  assert.equal(expiring.status, 201, JSON.stringify(expiring.body));
  wallet = await player.get('/api/wallet');
  assert.equal(wallet.body.availableCents, 6_000);
  await ctx.db.query("UPDATE cash_vouchers SET expires_at = now() - interval '1 minute' WHERE id = $1", [expiring.body.voucher.id]);
  const sweep = await ctx.cash.expireStale();
  assert.ok(sweep.expired >= 1);
  wallet = await player.get('/api/wallet');
  assert.equal(wallet.body.availableCents, 7_000, 'expiry returns the reservation');
  assert.equal(wallet.body.reservedCents, 0);
  const expired = await ctx.db.query('SELECT status FROM cash_vouchers WHERE id = $1', [expiring.body.voucher.id]);
  assert.equal(String(expired.rows[0].status), 'expired');
  const expiredWithdrawal = await ctx.db.query<{ status: string }>(
    `SELECT status FROM withdrawals
     WHERE user_id = $1 AND amount_cents = 1000 ORDER BY requested_at DESC LIMIT 1`,
    [playerId],
  );
  assert.equal(String(expiredWithdrawal.rows[0].status), 'cancelled', 'expiry cancels the withdrawal row');

  // ------------------------------------------------------- KYC refusals
  const noKyc = await unverified.post('/api/wallet/cash-out', { amountCents: 500, agentCode: 'CASH1' });
  assert.equal(noKyc.status, 403, JSON.stringify(noKyc.body));
  assert.match(String(noKyc.body.error.message), /verification/i);

  // ------------------------------------------------------- reconciliation
  const float = await ctx.db.query<{ id: string }>('SELECT float_account_id FROM cash_agents WHERE code = $1', ['CASH1']);
  const balance = await ctx.db.query<{ available_cents: number; entries: number }>(
    `SELECT w.available_cents, COALESCE(SUM(le.amount_cents), 0)::bigint AS entries
     FROM wallet_accounts w LEFT JOIN ledger_entries le ON le.wallet_account_id = w.id
     WHERE w.id = $1 GROUP BY w.available_cents`,
    [String(float.rows[0].float_account_id)],
  );
  assert.equal(Number(balance.rows[0].available_cents), Number(balance.rows[0].entries), 'float balance equals its journal');
  assert.equal(Number(balance.rows[0].available_cents), -7_000);

  // Every posted journal in the rail balances to zero.
  const unbalanced = await ctx.db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM (
       SELECT lt.id FROM ledger_transactions lt JOIN ledger_entries le ON le.transaction_id = lt.id
       WHERE lt.type IN ('voucher_credit','withdrawal_hold','withdrawal_cash_paid','withdrawal_release')
       GROUP BY lt.id HAVING SUM(le.amount_cents) <> 0) AS bad`,
  );
  assert.equal(Number(unbalanced.rows[0].n), 0);

  const lookup = await adminClient.get('/api/admin/cash-vouchers?limit=50');
  assert.equal(lookup.status, 200);
  assert.ok(lookup.body.items.some((row: any) => row.status === 'paid'));
});
