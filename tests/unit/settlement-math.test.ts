import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quoteTerms } from '../../shared/contracts.js';
import { SettlementService } from '../../server/finance/settlement.js';
import { SYSTEM_ACCOUNTS } from '../../server/finance/ledger.js';

const white = { availableId: 'white-available', reservedId: 'white-reserved' };
const black = { availableId: 'black-available', reservedId: 'black-reserved' };

test('winner settlement debits both reservations and credits payout plus fee', () => {
  const terms = quoteTerms(100, 500);
  const result = SettlementService.entriesFor(terms, 'white', white, black, white.availableId);
  assert.equal(result.payoutCents, 190);
  assert.equal(result.feeCents, 10);
  assert.deepEqual(result.entries, [
    { accountId: 'white-reserved', amountCents: -100 },
    { accountId: 'black-reserved', amountCents: -100 },
    { accountId: 'white-available', amountCents: 190 },
    { accountId: SYSTEM_ACCOUNTS.platformFee, amountCents: 10 },
  ]);
  assert.equal(result.entries.reduce((sum, e) => sum + e.amountCents, 0), 0);
});

test('draw and void refund both stakes with no commission', () => {
  const terms = quoteTerms(50, 500);
  for (const result of ['draw', 'void'] as const) {
    const quote = SettlementService.entriesFor(terms, result, white, black, null);
    assert.equal(quote.feeCents, 0);
    assert.equal(quote.payoutCents, 50);
    assert.deepEqual(quote.entries, [
      { accountId: 'white-reserved', amountCents: -50 },
      { accountId: 'black-reserved', amountCents: -50 },
      { accountId: 'white-available', amountCents: 50 },
      { accountId: 'black-available', amountCents: 50 },
    ]);
  }
});

test('tampered locked terms are rejected', () => {
  const terms = { ...quoteTerms(100, 500), payoutCents: 200 };
  assert.throws(() => SettlementService.entriesFor(terms, 'white', white, black, white.availableId), /integrity/i);
});
