import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  quoteTerms, formatCents, formatClock, canonicalTerms, decimalToCents,
  centsToDecimal, capturedPieces, isStakeAllowed, TERMS_VERSION,
} from '../../shared/contracts.js';

test('quoteTerms uses integer-cent arithmetic and the configured fee', () => {
  const one = quoteTerms(100, 500);
  assert.deepEqual(one, {
    stakeCents: 100, feeBps: 500, potCents: 200, feeCents: 10, payoutCents: 190,
    currency: 'USD', drawPolicy: 'refund-both-no-fee', version: TERMS_VERSION,
  });
  const half = quoteTerms(50, 500);
  assert.equal(half.potCents, 100);
  assert.equal(half.feeCents, 5);
  assert.equal(half.payoutCents, 95);
  const noFee = quoteTerms(250, 0);
  assert.equal(noFee.feeCents, 0);
  assert.equal(noFee.payoutCents, 500);
});

test('quoteTerms rounds fees half-up at the cent boundary', () => {
  // 100-cent pot with 50 bps = 0.5 cents, rounded up to 1 cent.
  const terms = quoteTerms(50, 50);
  assert.equal(terms.potCents, 100);
  assert.equal(terms.feeCents, 1);
  assert.equal(terms.payoutCents, 99);
});

test('quoteTerms rejects invalid stakes and fees', () => {
  assert.throws(() => quoteTerms(0, 500));
  assert.throws(() => quoteTerms(100.5, 500));
  assert.throws(() => quoteTerms(100, 2501));
  assert.throws(() => quoteTerms(100, -1));
});

test('money formatting and decimal parsing are symmetrical', () => {
  assert.equal(formatCents(190), '$1.90');
  assert.equal(formatCents(-5), '-$0.05');
  assert.equal(formatCents(0), '$0.00');
  assert.equal(decimalToCents('1.90'), 190);
  assert.equal(decimalToCents(0.5), 50);
  assert.equal(centsToDecimal(190), '1.90');
  assert.throws(() => decimalToCents('1.999'));
});

test('clock formatting includes tenths below twenty seconds', () => {
  assert.equal(formatClock(180_000), '3:00');
  assert.equal(formatClock(59_900), '0:59');
  assert.equal(formatClock(19_900), '0:19.9');
  assert.equal(formatClock(0), '0:00.0');
  assert.equal(formatClock(3_660_000), '1:01:00');
});

test('canonical terms are deterministic and sensitive to fee changes', () => {
  const a = canonicalTerms(quoteTerms(100, 500));
  const b = canonicalTerms(quoteTerms(100, 500));
  const c = canonicalTerms(quoteTerms(100, 400));
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('captured pieces are derived from material', () => {
  const start = capturedPieces('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  assert.equal(start.white.length, 0);
  assert.equal(start.black.length, 0);
  const missing = capturedPieces('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPP1/RNBQKBNR w KQkq - 0 1');
  assert.deepEqual(missing.white, ['wP']);
});

test('supported stakes are explicit', () => {
  assert.equal(isStakeAllowed(50), true);
  assert.equal(isStakeAllowed(100), true);
  assert.equal(isStakeAllowed(75), false);
});
