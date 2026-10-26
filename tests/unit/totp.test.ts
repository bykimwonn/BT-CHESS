import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateTotpSecret, base32Encode, base32Decode, totpCode, verifyTotp,
  encryptTotpSecret, decryptTotpSecret, otpauthUrl,
} from '../../server/auth/totp.js';

test('base32 codec round-trips random bytes', () => {
  const bytes = Buffer.from('rookstone-mfa-secret');
  assert.deepEqual(base32Decode(base32Encode(bytes)), bytes);
});

test('TOTP verifies current and adjacent windows, rejects wrong codes', () => {
  const secret = generateTotpSecret();
  const now = 1_700_000_000_000;
  const current = totpCode(secret, now);
  assert.match(current, /^\d{6}$/);
  assert.equal(verifyTotp(secret, current, now), true);
  assert.equal(verifyTotp(secret, totpCode(secret, now - 30_000), now), true);
  assert.equal(verifyTotp(secret, totpCode(secret, now + 30_000), now), true);
  assert.equal(verifyTotp(secret, '000000' === current ? '111111' : '000000', now), false);
  assert.equal(verifyTotp(secret, '12345', now), false);
});

test('TOTP secrets are encrypted at rest with AES-GCM', () => {
  const secret = generateTotpSecret();
  const encrypted = encryptTotpSecret(secret);
  assert.notEqual(encrypted, secret);
  assert.equal(encrypted.split('.').length, 3);
  assert.equal(decryptTotpSecret(encrypted), secret);
  assert.throws(() => decryptTotpSecret(encrypted.replace(/\.[^.]+$/, '.tampered')));
});

test('otpauth URL contains the Rookstone issuer and TOTP parameters', () => {
  const url = otpauthUrl('JBSWY3DPEHPK3PXP', 'Alice');
  assert.match(url, /^otpauth:\/\/totp\//);
  assert.match(url, /secret=JBSWY3DPEHPK3PXP/);
  assert.match(url, /issuer=Rookstone\+Arena/);
  assert.match(url, /digits=6/);
});
