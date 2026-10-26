process.env.CASH_AGENTS_ENABLED = 'true';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ComplianceState } from '../../server/config/compliance.js';

// env is captured at module load, so it must be set before the dynamic import.
const { CashVoucherService, cashRailMode, generateVoucherCode, isWellFormedCode, normalizeVoucherCode } =
  await import('../../server/cash/service.js');
const { sha256 } = await import('../../server/services/ids.js');

function compliance(overrides: Partial<ComplianceState> = {}): ComplianceState {
  return {
    realMoneyEnabled: false,
    competitionsEnabled: false,
    testMode: true,
    blockers: ['Internal test mode uses isolated, clearly labelled test credits; no real money is accepted.'],
    activation: null,
    notice: 'test',
    ...overrides,
  };
}

/** A database that fails loudly if a gated path ever reaches storage. */
const unreachable = new Proxy({}, {
  get() { throw new Error('The database must not be touched'); },
}) as never;

const ledger = new Proxy({}, { get() { throw new Error('The ledger must not be touched'); } }) as never;
const logger = { info() {}, warn() {}, error() {}, debug() {} } as never;

test('voucher codes ignore case, spaces and dashes but nothing else', () => {
  assert.equal(normalizeVoucherCode(' abcd-2345 '), 'ABCD2345');
  assert.equal(normalizeVoucherCode('ab cd 23 45'), 'ABCD2345');
  assert.equal(normalizeVoucherCode('ABCD2345'), 'ABCD2345');
  assert.equal(normalizeVoucherCode('ABC_D2345'), 'ABCD2345', 'punctuation is stripped like a dash');
  // Normalisation does not edit look-alike letters: they simply never appear
  // in generated codes, and an unknown code fails the hash lookup anyway.
  assert.equal(normalizeVoucherCode('abci2345'), 'ABCI2345');
});

test('codes are well formed only at a sensible length', () => {
  assert.equal(isWellFormedCode('ABCD2345'), true);
  assert.equal(isWellFormedCode('abcd-2345'), true);
  assert.equal(isWellFormedCode('ABC12'), false);
  assert.equal(isWellFormedCode(''), false);
  assert.equal(isWellFormedCode('ABCD234567890'), false);
  assert.equal(isWellFormedCode('-------'), false);
});

test('generated codes avoid look-alike characters and always format as two groups', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 400; i++) {
    const code = generateVoucherCode();
    assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
    assert.equal(/[IO01]/.test(code), false, `look-alike character in ${code}`);
    assert.equal(isWellFormedCode(code), true);
    seen.add(normalizeVoucherCode(code));
  }
  assert.ok(seen.size > 390, 'codes should not repeat in a small sample');
});

test('the stored hash is not the code, depends on the normalised form and is stable', () => {
  const code = 'ABCD-2345';
  const hash = sha256(`rookstone-voucher:${normalizeVoucherCode(code)}`);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash.includes('ABCD'), false);
  assert.equal(hash, sha256(`rookstone-voucher:${normalizeVoucherCode('abcd 2345')}`));
  assert.notEqual(hash, sha256('rookstone-voucher:ABCD2346'));
});

test('free mode refuses the rail and names the compliance blockers', async () => {
  const cash = new CashVoucherService(unreachable, ledger, compliance({
    testMode: false,
    blockers: ['OPERATING_MODE must be free, test or real', 'Independent legal authorisation has not been verified'],
  }), logger);
  await assert.rejects(
    cash.issueDeposit('00000000-0000-4000-8000-0000000000aa', { amountCents: 1_000 }),
    (error: any) => error.status === 403 && /legal authorisation/i.test(error.message),
  );
  await assert.rejects(
    cash.requestPayout('00000000-0000-4000-8000-0000000000aa', { amountCents: 5_000, agentCode: 'BTM01' }),
    (error: any) => error.status === 403 && /cash-agent vouchers are unavailable/i.test(error.message),
  );
  await assert.rejects(
    cash.redeemDeposit('00000000-0000-4000-8000-0000000000aa', { code: 'ABCD-2345' }),
    (error: any) => error.status === 403,
  );
});

test('test mode issues credits but never authorises a cash payout', async () => {
  const cash = new CashVoucherService(unreachable, ledger, compliance(), logger);
  await assert.rejects(
    cash.requestPayout('00000000-0000-4000-8000-0000000000aa', { amountCents: 5_000, agentCode: 'BTM01' }),
    (error: any) => error.status === 403 && /real-money mode/i.test(error.message),
  );
  await assert.rejects(
    cash.settlePayout('00000000-0000-4000-8000-0000000000aa', { code: 'ABCD-2345' }),
    (error: any) => error.status === 403 && /real-money mode/i.test(error.message),
  );
});

test('a malformed code is rejected before any lookup', async () => {
  const cash = new CashVoucherService(unreachable, ledger, compliance(), logger);
  await assert.rejects(
    cash.redeemDeposit('00000000-0000-4000-8000-0000000000aa', { code: 'XO' }),
    (error: any) => error.status === 400 && /voucher code/i.test(error.message),
  );
  // A payout is refused earlier still, by the mode gate, in test mode.
  await assert.rejects(
    cash.settlePayout('00000000-0000-4000-8000-0000000000aa', { code: 'XO' }),
    (error: any) => error.status === 403,
  );
});

test('the rail is fail-closed: the switch, then compliance, decides', () => {
  const ready = { realMoneyEnabled: false, testMode: true, blockers: [] };

  // No operator switch, no rail - even in test mode.
  assert.throws(
    () => cashRailMode(ready, false, 'deposit'),
    (error: any) => error.status === 503 && /CASH_AGENTS_ENABLED=true/.test(error.message),
  );

  // Free mode (neither test nor authorised real money) quotes its blockers.
  const blocked = {
    realMoneyEnabled: false,
    testMode: false,
    blockers: ['OPERATING_MODE must be free, test or real', 'Independent legal authorisation has not been verified'],
  };
  assert.throws(
    () => cashRailMode(blocked, true, 'deposit'),
    (error: any) => error.status === 403 && /legal authorisation/.test(error.message),
  );

  // Test mode accepts cash-in but never cash-out.
  assert.equal(cashRailMode(ready, true, 'deposit'), 'test');
  assert.throws(() => cashRailMode(ready, true, 'payout'), (error: any) => error.status === 403);

  // Only a signed, fully-flagged real-money operation may pay cash out.
  assert.equal(cashRailMode({ realMoneyEnabled: true, testMode: false, blockers: [] }, true, 'payout'), 'real');
  assert.equal(cashRailMode({ realMoneyEnabled: true, testMode: true, blockers: [] }, true, 'deposit'), 'real');
});
