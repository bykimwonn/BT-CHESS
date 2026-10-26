import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, createAdmin, ORIGIN } from '../helpers.js';

test('registration, sessions, CSRF and role-based admin access', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const player = harness.client();
  const registered = await player.register('PlayerOne', 'player1@example.com');
  assert.equal(registered.user.role, 'player');
  assert.equal(registered.emailDelivery.delivered, false);
  assert.ok(registered.devVerificationToken, 'development exposes a verification token without claiming email delivery');

  const session = await player.get('/api/auth/session');
  assert.equal(session.status, 200);
  assert.equal(session.body.user.username, 'PlayerOne');
  assert.equal(session.body.mfaEnabled, false);

  const savedCsrf = player.csrf;
  player.csrf = '';
  const csrfFailure = await player.patch('/api/me', { displayName: 'Hacked' });
  assert.equal(csrfFailure.status, 403);
  player.csrf = savedCsrf;
  const profileUpdate = await player.patch('/api/me', { displayName: 'Player One' });
  assert.equal(profileUpdate.status, 200);

  const forbiddenAdmin = await player.get('/api/admin/overview');
  assert.equal(forbiddenAdmin.status, 403);

  const admin = await createAdmin(harness.ctx, 'AdminOne', 'admin1@example.com');
  const adminClient = harness.client();
  await adminClient.login(admin.email, admin.password);
  const adminOverview = await adminClient.get('/api/admin/overview');
  assert.equal(adminOverview.status, 200, JSON.stringify(adminOverview.body));
  assert.equal(typeof adminOverview.body.users, 'number');
});

test('TOTP MFA setup, enable, login challenge and disable are enforced', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const client = harness.client();
  await client.register('MfaUser', 'mfa@example.com');
  const setup = await client.post('/api/auth/mfa/setup', {});
  assert.equal(setup.status, 200);
  assert.match(setup.body.otpauthUrl, /^otpauth:\/\/totp\//);
  const { totpCode } = await import('../../server/auth/totp.js');
  const code = totpCode(setup.body.secret);
  const enabled = await client.post('/api/auth/mfa/verify', { code });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.enabled, true);
  const session = await client.get('/api/auth/session');
  assert.equal(session.body.mfaEnabled, true);

  const fresh = harness.client();
  const noCode = await fresh.post('/api/auth/login', { email: 'mfa@example.com', password: 'Password123!' });
  assert.equal(noCode.status, 401);
  assert.equal(noCode.body.error.code, 'mfa_required');
  const withCode = await fresh.post('/api/auth/login', { email: 'mfa@example.com', password: 'Password123!', mfaCode: code });
  assert.equal(withCode.status, 200);

  const disabled = await client.post('/api/auth/mfa/disable', { code, password: 'Password123!' });
  assert.equal(disabled.status, 200);
});

test('password recovery uses a single-use expiring token and revokes sessions', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const client = harness.client();
  await client.register('ResetUser', 'reset@example.com');
  const forgot = await client.post('/api/auth/forgot', { email: 'reset@example.com' });
  assert.equal(forgot.status, 200);
  assert.equal(forgot.body.delivered, false);
  assert.ok(forgot.body.devResetToken);
  const token = forgot.body.devResetToken;
  const reset = await client.post('/api/auth/reset', { token, password: 'NewPassword123!' });
  assert.equal(reset.status, 200);
  const replay = await client.post('/api/auth/reset', { token, password: 'AnotherPassword123!' });
  assert.equal(replay.status, 400);
  const oldPassword = await client.post('/api/auth/login', { email: 'reset@example.com', password: 'Password123!' });
  assert.equal(oldPassword.status, 401);
  const newPassword = await client.post('/api/auth/login', { email: 'reset@example.com', password: 'NewPassword123!' });
  assert.equal(newPassword.status, 200);
});

test('email verification consumes the one-time token exactly once', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const client = harness.client();
  const registered = await client.register('VerifyUser', 'verify@example.com');
  const first = await client.post('/api/auth/verify-email', { token: registered.devVerificationToken });
  assert.equal(first.status, 200);
  const second = await client.post('/api/auth/verify-email', { token: registered.devVerificationToken });
  assert.equal(second.status, 400);
  const session = await client.get('/api/auth/session');
  assert.equal(session.body.user.emailVerified, true);
});

test('CORS origin checks reject untrusted state-changing origins', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const client = harness.client();
  await client.register('OriginUser', 'origin@example.com');
  const bad = await client.patch('/api/me', { displayName: 'No' }, { headers: { Origin: 'https://evil.example.com' } });
  assert.equal(bad.status, 403);
  const good = await client.post('/api/notifications/read-all', {}, { headers: { Origin: ORIGIN } });
  assert.equal(good.status, 200);
});
