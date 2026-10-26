import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paynowHash, parsePaynowFields, verifyPaynowHash, centsToPaynowAmount } from '../../server/payments/paynow.js';

const KEY = '3e9fed89-60e1-4ce5-ab6e-6b1eb2d4f977';

test('Paynow outbound hash matches the official documentation example', () => {
  const values: [string, string][] = [
    ['id', '1201'], ['reference', 'TEST REF'], ['amount', '99.99'],
    ['additionalinfo', 'A test ticket transaction'],
    ['returnurl', 'http://www.google.com/search?q=returnurl'],
    ['resulturl', 'http://www.google.com/search?q=resulturl'], ['status', 'Message'],
  ];
  assert.equal(paynowHash(values, KEY),
    '2A033FC38798D913D42ECB786B9B19645ADEDBDE788862032F1BD82CF3B92DEF84F316385D5B40DBB35F1A4FD7D5BFE73835174136463CDD48C9366B0749C689');
});

test('Paynow inbound hash validates the official status response example', () => {
  const raw = 'status=Ok&browserurl=https%3a%2f%2fstaging.paynow.co.zw%2fPayment%2fConfirmPayment%2f9510&pollurl=https%3a%2f%2fstaging.paynow.co.zw%2fInterface%2fCheckPayment%2f%3fguid%3dc7ed41da-0159-46da-b428-69549f770413&paynowreference=9510&hash=750DD0B0DF374678707BB5AF915AF81C228B9058AD57BB7120569EC68BBB9C2EFC1B26C6375D2BC562AC909B3CD6B2AF1D42E1A5E479FFAC8F4FB3FDCE71DF4D';
  const verified = verifyPaynowHash(raw, KEY);
  assert.equal(verified.valid, true);
  assert.equal(verified.fields.get('paynowreference'), '9510');
  assert.equal(verified.fields.get('status'), 'Ok');
  const tampered = raw.replace('paynowreference=9510', 'paynowreference=9511');
  assert.equal(verifyPaynowHash(tampered, KEY).valid, false);
});

test('Paynow fields preserve order and decode values', () => {
  const parsed = parsePaynowFields('a=one+two&b=https%3A%2F%2Fexample.com%2Fx%3Fy%3D1');
  assert.deepEqual(parsed.entries, [['a', 'one two'], ['b', 'https://example.com/x?y=1']]);
  assert.equal(parsed.lower().b, 'https://example.com/x?y=1');
});

test('cent amounts become two-decimal Paynow strings', () => {
  assert.equal(centsToPaynowAmount(190), '1.90');
  assert.equal(centsToPaynowAmount(5), '0.05');
  assert.throws(() => centsToPaynowAmount(0));
});
