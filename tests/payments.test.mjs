import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PaymentService } from '../lib/payments/index.js';
import { HttpWalletProvider } from '../lib/payments/providers/wallet-http.js';
import { TransactionStore } from '../lib/payments/store.js';

/** Build a service with fake hooks so balances are easy to assert on. */
function makeService(env = {}) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const balances = new Map([['u1', 100]]);
  const log = [];
  const service = new PaymentService({
    log: () => {},
    hooks: {
      getUser: (id) => ({ id, username: 'Tester', balance: balances.get(id) ?? 0 }),
      credit: (id, amount, meta) => {
        balances.set(id, (balances.get(id) ?? 0) + amount);
        log.push({ type: 'credit', id, amount, meta });
      },
      debit: (id, amount, meta) => {
        balances.set(id, (balances.get(id) ?? 0) - amount);
        log.push({ type: 'debit', id, amount, meta });
      },
      emit: () => {},
      log: () => {},
    },
  });
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  return { service, balances, log, restore };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('deposit settles exactly once and credits the wallet', async (t) => {
  const { service, balances, log, restore } = makeService({ MOCK_SETTLEMENT_DELAY_MS: '60' });
  t.after(restore);

  const tx = await service.requestDeposit({ userId: 'u1', providerId: 'ecocash', amount: 5, phone: '0771234567' });
  assert.equal(tx.status, 'pending');
  assert.match(tx.reference, /^DEP-/);
  assert.equal(balances.get('u1'), 100, 'funds are not credited until settled');

  await wait(400);
  assert.equal(service.store.get(tx.reference).status, 'completed');
  assert.equal(balances.get('u1'), 105);

  // Settlement must be idempotent - replaying it cannot mint money.
  await service.settle(tx.reference, 'completed', { source: 'replay' });
  assert.equal(balances.get('u1'), 105, 'double credit!');
  assert.equal(log.filter((l) => l.type === 'credit').length, 1);
});

test('deposit below the provider minimum is rejected', async (t) => {
  const { service, restore } = makeService();
  t.after(restore);
  await assert.rejects(() => service.requestDeposit({ userId: 'u1', providerId: 'ecocash', amount: 0.01, phone: '077' }), /Minimum deposit/);
});

test('withdrawal holds the funds immediately and settles', async (t) => {
  const { service, balances, restore } = makeService({ MOCK_SETTLEMENT_DELAY_MS: '60' });
  t.after(restore);

  const tx = await service.requestWithdraw({ userId: 'u1', providerId: 'ecocash', amount: 20, phone: '0771234567' });
  assert.equal(balances.get('u1'), 80, 'funds held on request');
  await wait(400);
  assert.equal(service.store.get(tx.reference).status, 'completed');
  assert.equal(balances.get('u1'), 80, 'held funds are not credited back on success');
});

test('withdrawal with insufficient balance is rejected and does not debit', async (t) => {
  const { service, balances, restore } = makeService();
  t.after(restore);
  await assert.rejects(() => service.requestWithdraw({ userId: 'u1', providerId: 'ecocash', amount: 500, phone: '077' }), /Insufficient/);
  assert.equal(balances.get('u1'), 100);
});

test('a failed withdrawal refunds the held amount', async (t) => {
  const { service, balances, restore } = makeService({ MOCK_SETTLEMENT_DELAY_MS: '10000' });
  t.after(restore);

  const tx = await service.requestWithdraw({ userId: 'u1', providerId: 'bank', amount: 30, account: 'CBZ-123' });
  assert.equal(balances.get('u1'), 70);
  await service.settle(tx.reference, 'failed', { source: 'test', reason: 'bank rejected' });
  assert.equal(balances.get('u1'), 100, 'failed withdrawal must be refunded');
  assert.equal(service.store.get(tx.reference).status, 'failed');
});

test('bank deposits need admin approval and can be rejected', async (t) => {
  const { service, balances, restore } = makeService({ MOCK_SETTLEMENT_DELAY_MS: '10000' });
  t.after(restore);

  const tx = await service.requestDeposit({ userId: 'u1', providerId: 'bank', amount: 50, account: 'CBZ-9' });
  assert.equal(tx.requiresApproval, true);
  assert.equal(balances.get('u1'), 100);

  await service.approve(tx.reference, { by: 'admin' });
  assert.equal(service.store.get(tx.reference).status, 'completed');
  assert.equal(balances.get('u1'), 150);

  const tx2 = await service.requestDeposit({ userId: 'u1', providerId: 'bank', amount: 10, account: 'CBZ-9' });
  await service.approve(tx2.reference, { by: 'admin', reject: true });
  assert.equal(service.store.get(tx2.reference).status, 'rejected');
  assert.equal(balances.get('u1'), 150, 'rejected deposit must not credit');
});

test('sandbox is the default mode and every wallet is listed', async (t) => {
  const { service, restore } = makeService();
  t.after(restore);
  const ids = service.listProviders().map((p) => p.id);
  for (const id of ['ecocash', 'innbucks', 'onemoney', 'bank', 'agent']) {
    assert.ok(ids.includes(id), `${id} missing from providers`);
  }
  assert.equal(service.mode, 'mock');
  assert.equal(service.getProvider('ecocash').live, false, 'EcoCash must not claim to be live without credentials');
});

test('live EcoCash credentials switch the provider out of sandbox', async (t) => {
  const { service, restore } = makeService({
    PAYMENT_MODE: 'live',
    ECOCASH_ENABLED: 'true',
    ECOCASH_BASE_URL: 'https://example.test',
    ECOCASH_API_KEY: 'key-123',
    ECOCASH_AUTH_MODE: 'bearer',
    ECOCASH_WEBHOOK_SECRET: 'shhh',
  });
  t.after(restore);
  const eco = service.getProvider('ecocash');
  assert.equal(eco.live, true);
  assert.equal(service.mode, 'live');

  const body = JSON.stringify({ reference: 'DEP-X', status: 'COMPLETED', transactionId: 'TX1' });
  const sig = crypto.createHmac('sha256', 'shhh').update(body).digest('hex');
  assert.equal(eco.verifyWebhook({ headers: { 'x-signature': sig }, rawBody: body }), true);
  assert.equal(eco.verifyWebhook({ headers: { 'x-signature': 'deadbeef' }, rawBody: body }), false);
  assert.equal(eco.verifyWebhook({ headers: {}, rawBody: body }), false, 'missing signature must fail closed');

  const parsed = eco.parseWebhook({ body: JSON.parse(body) });
  assert.equal(parsed.status, 'completed');
  assert.equal(parsed.reference, 'DEP-X');
});

test('webhook with an unknown reference is not an error that credits anything', async (t) => {
  const { service, balances, restore } = makeService();
  t.after(restore);
  const res = await service.handleWebhook('ecocash', { headers: {}, rawBody: '{}', body: { reference: 'DEP-NOPE', status: 'COMPLETED' } });
  assert.equal(res.ok, false);
  assert.equal(balances.get('u1'), 100);
});

test('transaction store keeps a bounded history and round-trips through JSON', () => {
  const store = new TransactionStore();
  for (let i = 0; i < 3; i++) {
    store.create({ type: 'deposit', userId: 'u1', provider: 'ecocash', amount: i + 1 });
  }
  assert.equal(store.toJSON().length, 3);
  const restored = new TransactionStore();
  restored.hydrate(store.toJSON());
  assert.equal(restored.recent(10).length, 3);
  assert.equal(restored.byUser('u1').length, 3);
});

test('phone numbers are normalised to the 263 international format', () => {
  const provider = new HttpWalletProvider({ id: 'test', label: 'Test' });
  assert.equal(provider.constructor.name, 'HttpWalletProvider');
  // exercise normalisation through the payload builder
  const payload = provider._payload({ reference: 'R1', amount: 2, phone: '0771234567', type: 'deposit' });
  assert.equal(payload.customerMsisdn, '263771234567');
});
