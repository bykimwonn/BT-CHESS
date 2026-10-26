import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, createAdmin } from '../helpers.js';

/**
 * The cash-agent rail end to end, in internal test mode: a teller takes cash
 * and issues a code, the player redeems it, the float is tracked, cash payouts
 * stay blocked, and a cancelled code can never be redeemed.
 */
test('cash-agent vouchers credit the wallet once, track float and respect limits', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());

  const player = harness.client();
  const registration = await player.register('PlayerOne', 'player1@example.com');
  const verified = await player.post('/api/auth/verify-email', { token: registration.devVerificationToken });
  assert.equal(verified.status, 200, JSON.stringify(verified.body));

  const teller = harness.client();
  await teller.register('TellerOne', 'teller1@example.com');

  const admin = await createAdmin(harness.ctx, 'AdminOne', 'admin1@example.com');
  const adminClient = harness.client();
  await adminClient.login(admin.email, admin.password);

  // ---------------------------------------------------- register the agent
  const created = await adminClient.post('/api/admin/cash-agents', {
    usernameOrEmail: 'TellerOne', code: 'btm01', name: 'Bulawayo Main', location: '8th Avenue',
    voucherLimitCents: 100_000, dailyDepositLimitCents: 500_000, dailyPayoutLimitCents: 500_000,
    confirm: true, reason: 'pilot cash agent for Bulawayo',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.code, 'BTM01');
  assert.equal(created.body.cashHeldCents, 0);
  const agentId = String(created.body.id);

  // The promoted account can use the teller console with its existing session.
  const dashboard = await teller.get('/api/cash/agent');
  assert.equal(dashboard.status, 200, JSON.stringify(dashboard.body));
  assert.equal(dashboard.body.agent.code, 'BTM01');

  // Players cannot reach the teller console.
  const forbiddenConsole = await player.get('/api/cash/agent');
  assert.equal(forbiddenConsole.status, 403);

  // ------------------------------------------------------------- cash in
  const issued = await teller.post('/api/cash/agent/vouchers', { amountCents: 2_500, playerUsername: 'PlayerOne', reference: 'R-1001' });
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  assert.match(String(issued.body.code), /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal(issued.body.voucher.status, 'issued');
  assert.equal(issued.body.voucher.sandbox, true, 'test mode must label vouchers as sandbox');

  // The code is stored as a hash, never in clear text.
  const stored = await harness.ctx.db.query('SELECT code_hash, code_last4 FROM cash_vouchers WHERE id = $1', [issued.body.voucher.id]);
  assert.ok(!String(stored.rows[0].code_hash).includes(issued.body.code));
  assert.equal(String(stored.rows[0].code_last4), String(issued.body.code).slice(-4));

  const redeemed = await player.post('/api/wallet/vouchers/redeem', { code: issued.body.code.toLowerCase() });
  assert.equal(redeemed.status, 200, JSON.stringify(redeemed.body));
  assert.equal(redeemed.body.status, 'redeemed');
  assert.equal(redeemed.body.playerUsername, 'PlayerOne');

  const wallet = await player.get('/api/wallet');
  assert.equal(wallet.body.availableCents, 2_500);
  const journal = await harness.ctx.db.query(
    "SELECT type, description FROM ledger_transactions WHERE type = 'test_voucher_credit'",
  );
  assert.equal(journal.rows.length, 1);
  assert.match(String(journal.rows[0].description), /TEST CASH VOUCHER/);

  // Replay is rejected, and the code cannot be redeemed twice.
  const replay = await player.post('/api/wallet/vouchers/redeem', { code: issued.body.code });
  assert.equal(replay.status, 409);

  // ---------------------------------------------------- float and payouts
  const afterRedeem = await teller.get('/api/cash/agent');
  assert.equal(afterRedeem.body.agent.cashHeldCents, 2_500, 'cash on hand equals the redeemed amount');

  // Cash payouts are real-money only.
  const payout = await player.post('/api/wallet/cash-out', { amountCents: 2_500, agentCode: 'BTM01' });
  assert.equal(payout.status, 403, JSON.stringify(payout.body));
  assert.match(String(payout.body.error.message), /real-money/i);

  // Remittance reduces the custody balance and is audited.
  const remit = await adminClient.post(`/api/admin/cash-agents/${agentId}/remit`, {
    amountCents: 2_500, reference: 'BANK-8891', confirm: true, reason: 'daily cash remittance to bank',
  });
  assert.equal(remit.status, 200, JSON.stringify(remit.body));
  assert.equal(remit.body.cashHeldCents, 0);
  const overRemit = await adminClient.post(`/api/admin/cash-agents/${agentId}/remit`, {
    amountCents: 100, reference: 'BANK-8892', confirm: true, reason: 'attempt to remit more than held',
  });
  assert.equal(overRemit.status, 409);

  // --------------------------------------------------------- cancellation
  const second = await teller.post('/api/cash/agent/vouchers', { amountCents: 1_000 });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  const cancelled = await teller.post(`/api/cash/agent/vouchers/${second.body.voucher.id}/cancel`, { reason: 'player changed their mind' });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.status, 'cancelled');
  const redeemCancelled = await player.post('/api/wallet/vouchers/redeem', { code: second.body.code });
  assert.equal(redeemCancelled.status, 409);

  // --------------------------------------------------------------- limits
  const tooLarge = await teller.post('/api/cash/agent/vouchers', { amountCents: 200_000 });
  assert.equal(tooLarge.status, 400, JSON.stringify(tooLarge.body));
  const tooSmall = await teller.post('/api/cash/agent/vouchers', { amountCents: 50 });
  assert.equal(tooSmall.status, 400);

  // A voucher bound to one player cannot be redeemed by another.
  const bound = await teller.post('/api/cash/agent/vouchers', { amountCents: 1_500, playerUsername: 'TellerOne' });
  assert.equal(bound.status, 201);
  const wrongPlayer = await player.post('/api/wallet/vouchers/redeem', { code: bound.body.code });
  assert.equal(wrongPlayer.status, 403);

  const vouchers = await adminClient.get('/api/admin/cash-vouchers');
  assert.equal(vouchers.status, 200);
  assert.ok(vouchers.body.items.length >= 3);

  const agents = await adminClient.get('/api/admin/cash-agents');
  assert.equal(agents.body.items.length, 1);
  assert.equal(agents.body.items[0].todayDepositCents, 4_000, 'issued cash-in vouchers count against the daily limit');
});

test('cash-agent registration validates the account and refuses duplicates', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const admin = await createAdmin(harness.ctx, 'AdminTwo', 'admin2@example.com');
  const adminClient = harness.client();
  await adminClient.login(admin.email, admin.password);

  const missing = await adminClient.post('/api/admin/cash-agents', {
    usernameOrEmail: 'NobodyHere', code: 'XYZ01', name: 'Nowhere', confirm: true, reason: 'check missing account',
  });
  assert.equal(missing.status, 404);

  const teller = harness.client();
  await teller.register('TellerTwo', 'teller2@example.com');
  const first = await adminClient.post('/api/admin/cash-agents', {
    usernameOrEmail: 'teller2@example.com', code: 'HR01', name: 'Harare CBD', confirm: true, reason: 'second pilot agent',
  });
  assert.equal(first.status, 201, JSON.stringify(first.body));

  const duplicate = await adminClient.post('/api/admin/cash-agents', {
    usernameOrEmail: 'TellerTwo', code: 'HR02', name: 'Harare CBD 2', confirm: true, reason: 'duplicate registration attempt',
  });
  assert.equal(duplicate.status, 409);

  const badCode = await adminClient.post('/api/admin/cash-agents', {
    usernameOrEmail: 'Player?', code: 'bad code!', name: 'Nope', confirm: true, reason: 'invalid code attempt',
  });
  assert.ok([400, 404].includes(badCode.status));
});
