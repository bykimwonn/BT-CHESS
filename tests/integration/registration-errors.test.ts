import assert from 'node:assert/strict';
import test from 'node:test';
import { createHarness } from '../helpers.js';

/**
 * A signup must never fail with an unactionable "Invalid request".
 *
 * Reproduced before the fix: a password without an uppercase letter, a short
 * password, a username containing a space and an unusable browser time zone all
 * collapsed into `{ code: 'validation_error', message: 'Invalid request' }`, so
 * the person filling in the form had no idea what to change. On a phone the
 * time-zone case rejected otherwise valid registrations outright.
 */
test('registration reports the exact field that needs attention', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const client = harness.client();
  const base = {
    username: 'FieldProbe',
    email: 'field-probe@example.com',
    password: 'GoodPassw0rd',
    displayName: 'Field Probe',
    timezone: 'Africa/Harare',
  };

  const weakPassword = await client.post('/api/auth/register', { ...base, password: 'goodpassw0rd' });
  assert.equal(weakPassword.status, 400);
  assert.equal(weakPassword.body.error.code, 'validation_error');
  assert.equal(weakPassword.body.error.fields.password, 'Include an uppercase letter');
  assert.match(weakPassword.body.error.message, /^Password: Include an uppercase letter$/);
  assert.doesNotMatch(weakPassword.body.error.message, /^Invalid request$/);

  const shortPassword = await client.post('/api/auth/register', { ...base, password: 'Good1pass' });
  assert.equal(shortPassword.status, 400);
  assert.equal(shortPassword.body.error.fields.password, 'Use at least 10 characters');
  assert.equal(shortPassword.body.error.message, 'Password: Use at least 10 characters');

  const spacedUsername = await client.post('/api/auth/register', { ...base, username: 'Field Probe' });
  assert.equal(spacedUsername.status, 400);
  assert.equal(spacedUsername.body.error.fields.username,
    'Use letters, numbers or underscores only, starting with a letter (no spaces)');
  assert.equal(spacedUsername.body.error.message,
    'Username: Use letters, numbers or underscores only, starting with a letter (no spaces)');

  // Every problem is reported, not just the first, so one pass fixes the form.
  const severalProblems = await client.post('/api/auth/register', {
    ...base, username: 'x', email: 'not-an-email', password: 'short',
  });
  assert.equal(severalProblems.status, 400);
  assert.deepEqual(Object.keys(severalProblems.body.error.fields).sort(), ['email', 'password', 'username']);
  assert.ok(Array.isArray(severalProblems.body.error.detail), 'machine-readable issues stay available');

  // Nothing above should have created a user.
  const duplicate = await client.register('FieldProbe', 'field-probe@example.com');
  assert.equal(duplicate.user.username, 'FieldProbe');
});

test('an unusable browser time zone falls back to UTC instead of blocking signup', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const client = harness.client();

  // Some mobile browsers and older Android WebViews return identifiers that
  // `Intl.DateTimeFormat` itself rejects.
  for (const [index, timezone] of ['GMT+02:00', '', 'UTC+2', 'Africa/Harare'].entries()) {
    const result = await client.post('/api/auth/register', {
      username: `TzProbe${index}`,
      email: `tz-probe-${index}@example.com`,
      password: 'GoodPassw0rd',
      timezone,
      timezoneShared: true,
    });
    assert.equal(result.status, 201, `timezone ${JSON.stringify(timezone)} must not block signup`);
    const stored = await harness.db.query<{ timezone: string }>('SELECT timezone FROM users WHERE id = $1', [result.body.user.id]);
    const expected = timezone === 'Africa/Harare' ? 'Africa/Harare' : 'UTC';
    assert.equal(stored.rows[0]?.timezone, expected, `timezone ${JSON.stringify(timezone)} should store ${expected}`);
  }

  // A non-string value is equally survivable.
  const numeric = await client.post('/api/auth/register', {
    username: 'TzProbeNumeric', email: 'tz-probe-numeric@example.com', password: 'GoodPassw0rd', timezone: 2,
  });
  assert.equal(numeric.status, 201);

  // Explicit profile edits still reject a nonsense zone, because there the
  // person is choosing it deliberately and deserves to be told.
  const raw = await client.register('TzProfile', 'tz-profile@example.com');
  const csrf = client.csrf;
  const rejected = await client.patch('/api/me/international', { timezone: 'GMT+02:00' });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error.message, /valid IANA time zone/i);
  assert.ok(raw.user.id && csrf);
});

test('valid signups still succeed and no rule was weakened', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const client = harness.client();

  // Rules remain exactly as strict as before for real inputs.
  const noNumber = await client.post('/api/auth/register', {
    username: 'StrictOne', email: 'strict-one@example.com', password: 'GoodPassword',
  });
  assert.equal(noNumber.status, 400);
  assert.equal(noNumber.body.error.fields.password, 'Include a number');

  const ok = await client.post('/api/auth/register', {
    username: 'StrictTwo', email: 'strict-two@example.com', password: 'GoodPassw0rd',
    country: 'ZW', countryShared: true, timezone: 'Africa/Harare', timezoneShared: true,
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.user.username, 'StrictTwo');
});
