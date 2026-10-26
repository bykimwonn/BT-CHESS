/**
 * Send a real test email through the configured SMTP transport.
 *
 *   npm run email:test -- you@gmail.com
 *
 * Exits non-zero when SMTP is not configured, the handshake fails or the
 * server rejects the message. Nothing is reported as delivered unless the
 * SMTP server accepted it.
 */
import { env } from '../server/config/env.js';
import { Mailer, emailProblems } from '../server/services/mailer.js';
import { testEmail } from '../server/services/email-templates.js';
import { createLogger } from '../server/services/logger.js';

async function main(): Promise<void> {
  const to = (process.argv[2] ?? '').trim();
  if (!to) {
    console.error('Usage: npm run email:test -- recipient@example.com');
    process.exit(2);
  }
  const log = createLogger();
  const mailer = new Mailer(log);

  console.log('Email configuration');
  console.log(`  provider : ${env.email.provider}`);
  console.log(`  host     : ${env.email.host || '(from SMTP_URL)'}:${env.email.port} ${env.email.secure ? '(implicit TLS)' : '(STARTTLS)'}`);
  console.log(`  user     : ${env.email.user || '(none)'}`);
  console.log(`  from     : ${env.email.from}`);
  const problems = emailProblems(env.email);
  if (problems.length) {
    console.error('\nConfiguration problems:');
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error('\nSee docs/EMAIL.md. Nothing was sent.');
    process.exit(1);
  }

  console.log('\nOpening an SMTP session…');
  const verified = await mailer.verify();
  if (!verified.ok) {
    console.error(`SMTP handshake failed: ${verified.reason}`);
    process.exit(1);
  }
  console.log('SMTP handshake and authentication succeeded.');

  const delivery = await mailer.sendContent(to, testEmail(new Date().toISOString(), env.nodeEnv));
  if (!delivery.delivered) {
    console.error(`\nDelivery failed: ${delivery.reason}`);
    process.exit(1);
  }
  console.log(`\nTest message accepted by the SMTP server (message id ${delivery.messageId ?? 'unknown'}).`);
  console.log(`Check ${to} — including the spam folder — and confirm the sender is ${env.email.from}.`);
}

void main().catch((error) => {
  console.error('Email test failed:', (error as Error).message);
  process.exit(1);
});
