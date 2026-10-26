import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMoney, quoteTerms } from '../../shared/contracts.js';
import {
  COUNTRY_CODES, UNDISCLOSED_COUNTRY, countryFlag, countryName,
  formatLocalDateTime, isValidTimeZone, normalizeCountryCode,
} from '../../shared/countries.js';
import { pairEntrants } from '../../server/tournament/service.js';

test('country helpers support voluntary international display', () => {
  assert.ok(COUNTRY_CODES.length > 200);
  assert.ok(COUNTRY_CODES.includes('ZW'));
  assert.equal(normalizeCountryCode('zw'), 'ZW');
  assert.equal(normalizeCountryCode('XX'), null);
  assert.equal(normalizeCountryCode(UNDISCLOSED_COUNTRY), UNDISCLOSED_COUNTRY);
  assert.equal(countryName('ZW'), 'Zimbabwe');
  assert.equal(countryFlag('ZW'), '🇿🇼');
  assert.equal(countryFlag(UNDISCLOSED_COUNTRY), '🌐');
});

test('timezone helpers use real IANA zones and local formatting', () => {
  assert.equal(isValidTimeZone('Africa/Harare'), true);
  assert.equal(isValidTimeZone('Asia/Tokyo'), true);
  assert.equal(isValidTimeZone('Not/AZone'), false);
  const iso = '2026-10-26T12:00:00.000Z';
  const harare = formatLocalDateTime(iso, 'Africa/Harare');
  const tokyo = formatLocalDateTime(iso, 'Asia/Tokyo');
  assert.notEqual(harare, tokyo);
  assert.match(harare, /2026/);
  assert.match(tokyo, /2026/);
});

test('all money displays include an explicit currency code', () => {
  assert.equal(formatMoney(190), 'USD $1.90');
  assert.equal(formatMoney(-5, 'EUR'), 'EUR -$0.05');
  const terms = quoteTerms(50, 500);
  assert.equal(terms.currency, 'USD');
  assert.equal(formatMoney(terms.payoutCents, terms.currency), 'USD $0.95');
});

test('tournament pairing uses real entrants, avoids rematches where possible and awards a bye', () => {
  const seeds = [
    { userId: 'a', rating: 1500, points: 2 },
    { userId: 'b', rating: 1400, points: 1 },
    { userId: 'c', rating: 1300, points: 1 },
    { userId: 'd', rating: 1200, points: 0 },
    { userId: 'e', rating: 1100, points: 0 },
  ];
  const previous = new Map<string, Set<string>>([
    ['a', new Set(['b'])], ['b', new Set(['a'])],
  ]);
  const result = pairEntrants(seeds, previous, 2);
  assert.equal(result.pairs.length, 2);
  assert.equal(result.bye, 'e');
  assert.equal(result.pairs.some((pair) =>
    (pair.whiteId === 'a' && pair.blackId === 'b') || (pair.whiteId === 'b' && pair.blackId === 'a')), false);
  const used = result.pairs.flatMap((pair) => [pair.whiteId, pair.blackId]);
  assert.equal(new Set(used).size, 4);
});
