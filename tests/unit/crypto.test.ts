import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PesePayCrypto } from '../../server/payments/pesepay.js';
import { sha256, randomToken, safeEqualHex, safeEqualText, hmacHex } from '../../server/services/ids.js';

test('PesePay AES-256-CBC envelope round-trips using documented key/IV rule', () => {
  const codec = new PesePayCrypto('12345678901234567890123456789012');
  const body = { amountDetails: { amount: 1.9, currencyCode: 'USD' }, referenceNumber: 'RS-1' };
  const payload = codec.encrypt(body);
  assert.equal(typeof payload, 'string');
  assert.equal(payload.includes('amountDetails'), false);
  assert.deepEqual(codec.decrypt(payload), body);
});

test('PesePay encryption rejects a key that is not 32 bytes', () => {
  assert.throws(() => new PesePayCrypto('short-key'));
});

test('security helpers are deterministic and timing-safe', () => {
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(randomToken().length > 10, true);
  assert.notEqual(randomToken(), randomToken());
  const digest = hmacHex('key', 'payload');
  assert.equal(safeEqualHex(digest, digest), true);
  assert.equal(safeEqualHex(digest, '0'.repeat(64)), false);
  assert.equal(safeEqualText('same', 'same'), true);
  assert.equal(safeEqualText('same', 'different'), false);
});
