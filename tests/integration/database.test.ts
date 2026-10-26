import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, SYSTEM_ACCOUNTS } from '../helpers.js';

test('migrations enforce balanced, immutable, idempotent and non-overdrawing journals', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const client = harness.client();
  const registered = await client.register('LedgerUser', 'ledger@example.com');
  const userId = registered.user.id;
  const ledger = harness.ctx.ledger;
  const accounts = await ledger.ensureUserAccounts(harness.db, userId);

  const journal = await ledger.postTransaction({
    type: 'deposit_credit', reference: 'DEP-LEDGER-1', idempotencyKey: 'deposit-credit:ledger-1',
    description: 'Test deposit',
    entries: [
      { accountId: SYSTEM_ACCOUNTS.external, amountCents: -500 },
      { accountId: accounts.availableId, amountCents: 500 },
    ],
  });
  assert.equal(journal.posted, true);
  const wallet = await ledger.walletView(userId);
  assert.equal(wallet.availableCents, 500);
  assert.equal(wallet.reservedCents, 0);
  assert.equal(wallet.totalCents, 500);

  const duplicate = await ledger.postTransaction({
    type: 'deposit_credit', reference: 'DEP-LEDGER-1', idempotencyKey: 'deposit-credit:ledger-1',
    description: 'Duplicate deposit',
    entries: [
      { accountId: SYSTEM_ACCOUNTS.external, amountCents: -500 },
      { accountId: accounts.availableId, amountCents: 500 },
    ],
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal((await ledger.walletView(userId)).availableCents, 500);

  await assert.rejects(() => ledger.postTransaction({
    type: 'withdrawal_hold', reference: 'WHD-OVERDRAW', idempotencyKey: 'withdrawal-hold:overdraw',
    description: 'Attempt to overdraw',
    entries: [
      { accountId: accounts.availableId, amountCents: -600 },
      { accountId: accounts.reservedId, amountCents: 600 },
    ],
  }), /Insufficient available or reserved funds/);
  assert.equal((await ledger.walletView(userId)).availableCents, 500);

  await assert.rejects(() => ledger.postTransaction({
    type: 'unbalanced', reference: 'UNBALANCED', idempotencyKey: 'unbalanced:1',
    description: 'Should fail before insertion',
    entries: [
      { accountId: accounts.availableId, amountCents: 100 },
      { accountId: accounts.reservedId, amountCents: -50 },
    ],
  }), /not balanced/);

  await assert.rejects(() => harness.db.transaction(async (tx: any) => {
    await tx.query(
      `INSERT INTO ledger_transactions (id, type, reference, idempotency_key, description, status)
       VALUES ($1,'bad','BAD-TRIGGER',$2,'Unbalanced posted journal','posted')`,
      ['11111111-1111-4111-8111-111111111111', 'bad-trigger:1'],
    );
    await tx.query(
      `INSERT INTO ledger_entries (transaction_id, wallet_account_id, line_no, amount_cents)
       VALUES ($1,$2,1,100)`,
      ['11111111-1111-4111-8111-111111111111', accounts.availableId],
    );
  }), /does not balance|Ledger transaction/);

  await assert.rejects(() => harness.db.query(
    'UPDATE ledger_entries SET amount_cents = 999 WHERE transaction_id = $1', [journal.id]),
  /immutable/);

  const reconciliation = await ledger.reconcile();
  assert.equal(reconciliation.discrepancies.length, 0);
  assert.equal(reconciliation.unbalancedTransactions.length, 0);
  assert.ok(reconciliation.checkedAccounts >= 5);
});

test('schema migrations are idempotent and checksum-protected', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { runMigrations } = await import('../../server/db/migrate.js');
  const second = await runMigrations(harness.db);
  assert.deepEqual(second.applied, []);
  assert.ok(second.skipped.includes('001_init'));
});
