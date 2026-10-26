import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EmailSettings } from '../../server/config/env.js';
import type { AppLogger } from '../../server/services/logger.js';
import { Mailer, emailProblems, explainSmtpError, maskEmail, parseAddress } from '../../server/services/mailer.js';
import { passwordResetEmail, testEmail, verificationEmail } from '../../server/services/email-templates.js';

const silent = {
  info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {},
} as unknown as AppLogger;

const settings = (overrides: Partial<EmailSettings> = {}): EmailSettings => ({
  provider: 'gmail',
  smtpUrl: '',
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  requireTls: false,
  user: 'player@gmail.com',
  pass: 'abcd efgh ijkl mnop',
  from: 'Rookstone Arena <player@gmail.com>',
  fromExplicit: true,
  replyTo: '',
  ...overrides,
});

test('a valid Gmail App Password configuration has no problems', () => {
  assert.deepEqual(emailProblems(settings()), []);
});

test('Gmail with a normal account password is rejected with App Password guidance', () => {
  const problems = emailProblems(settings({ pass: 'my-normal-password' }));
  assert.ok(problems.some((problem) => /App Password/.test(problem)));
});

test('Gmail refuses a From address that differs from the authenticated user', () => {
  const problems = emailProblems(settings({ from: 'Rookstone Arena <no-reply@rookstone.co.zw>' }));
  assert.ok(problems.some((problem) => /rewrites the From address/.test(problem)));
});

test('placeholder sender domains are refused', () => {
  const problems = emailProblems(settings({
    provider: 'smtp', host: 'smtp.example.com', user: 'postmaster@yourdomain.co.zw',
    pass: 'secret', from: 'Rookstone Arena <no-reply@example.invalid>',
  }));
  assert.ok(problems.some((problem) => /placeholder domain/.test(problem)));
});

test('missing SMTP credentials are reported without leaking values', () => {
  const problems = emailProblems(settings({ user: '', pass: '' }));
  assert.ok(problems.some((problem) => /SMTP_USER is required/.test(problem)));
  assert.ok(problems.some((problem) => /SMTP_PASS/.test(problem)));
  assert.ok(!problems.join(' ').includes('abcd efgh'));
});

test('an SMTP_URL configuration is accepted without host and user parts', () => {
  const problems = emailProblems(settings({
    provider: 'smtp', smtpUrl: 'smtps://user:pass@smtp.example.com:465',
    host: '', user: '', pass: '', from: 'Rookstone Arena <no-reply@yourdomain.co.zw>',
  }));
  assert.deepEqual(problems, []);
  assert.ok(emailProblems(settings({ smtpUrl: 'http://insecure.example.com' })).some((p) => /smtp:\/\//.test(p)));
});

test('addresses are parsed and masked without exposing the mailbox', () => {
  assert.deepEqual(parseAddress('Rookstone Arena <no-reply@example.com>'), { name: 'Rookstone Arena', address: 'no-reply@example.com' });
  assert.deepEqual(parseAddress('player@gmail.com'), { name: null, address: 'player@gmail.com' });
  const masked = maskEmail('player@gmail.com');
  assert.match(masked, /^pl•+@gmail\.com$/);
  assert.ok(!masked.includes('player'));
});

test('SMTP errors are explained in operator terms', () => {
  const gmailAuth = explainSmtpError({ code: 'EAUTH', responseCode: 535, message: 'Invalid login' }, settings());
  assert.match(gmailAuth, /App Password/);
  const timeout = explainSmtpError({ code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' }, settings());
  assert.match(timeout, /outbound SMTP|465|587/);
  const dns = explainSmtpError({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND' }, settings());
  assert.match(dns, /could not be resolved/);
});

test('an unconfigured mailer never claims a message was delivered', async () => {
  const mailer = new Mailer(silent, settings({ provider: 'none', smtpUrl: '', host: '', user: '', pass: '' }));
  assert.equal(mailer.configured, false);
  assert.equal(mailer.status().configured, false);
  const delivery = await mailer.send('player@gmail.com', 'Subject', 'Body');
  assert.equal(delivery.delivered, false);
  assert.match(delivery.reason ?? '', /not configured/);
  const verified = await mailer.verify();
  assert.equal(verified.ok, false);
});

test('an invalid configuration refuses to send even when a transport exists', async () => {
  const mailer = new Mailer(silent, settings({ pass: 'normal-password' }));
  const delivery = await mailer.send('player@gmail.com', 'Subject', 'Body');
  assert.equal(delivery.delivered, false);
  assert.match(delivery.reason ?? '', /App Password/);
});

test('recipient validation happens before the SMTP call', async () => {
  const mailer = new Mailer(silent, settings());
  const delivery = await mailer.send('not-an-address', 'Subject', 'Body');
  assert.equal(delivery.delivered, false);
  assert.match(delivery.reason ?? '', /valid email/);
});

test('security email templates include text and HTML and escape user data', () => {
  const verify = verificationEmail('https://chess.example.co.zw/verify-email?token=a"b');
  assert.match(verify.subject, /Verify/);
  assert.match(verify.text, /https:\/\/chess\.example\.co\.zw/);
  assert.match(verify.html, /&quot;/);
  assert.ok(!verify.html.includes('a"b'));

  const reset = passwordResetEmail('https://chess.example.co.zw/reset-password?token=x');
  assert.match(reset.text, /60 minutes/);
  assert.match(reset.html, /Reset password/);

  const probe = testEmail('2026-01-01T00:00:00.000Z', 'production');
  assert.match(probe.text, /delivery test/);
  assert.match(probe.html, /Email delivery is working/);
});
