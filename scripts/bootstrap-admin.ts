import 'dotenv/config';
import { z } from 'zod';
import { openDatabase } from '../server/db/client.js';
import { runMigrations } from '../server/db/migrate.js';
import { hashPassword } from '../server/auth/password.js';
import { LedgerService } from '../server/finance/ledger.js';
import { audit } from '../server/services/audit.js';
import { uuid } from '../server/services/ids.js';

const schema = z.object({
  email: z.string().email(),
  username: z.string().min(3).max(24).regex(/^[a-zA-Z][a-zA-Z0-9_]+$/),
  password: z.string().min(12).max(128)
    .regex(/[a-z]/).regex(/[A-Z]/).regex(/[0-9]/),
  displayName: z.string().min(1).max(48).optional(),
});

const input = schema.safeParse({
  email: process.env.ADMIN_EMAIL,
  username: process.env.ADMIN_USERNAME,
  password: process.env.ADMIN_PASSWORD,
  displayName: process.env.ADMIN_DISPLAY_NAME,
});
if (!input.success) {
  console.error('ADMIN_EMAIL, ADMIN_USERNAME and a strong ADMIN_PASSWORD (12+ chars, mixed case and number) are required.');
  console.error(input.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n'));
  process.exit(1);
}

const db = await openDatabase();
try {
  await runMigrations(db);
  const existing = await db.query('SELECT id, role FROM users WHERE lower(email) = lower($1)', [input.data.email]);
  if (existing.rows.length) {
    if (process.env.FORCE_ADMIN_UPDATE !== 'true') {
      throw new Error('An account with this email already exists. Set FORCE_ADMIN_UPDATE=true only if you intend to promote it.');
    }
    await db.transaction(async (tx) => {
      await tx.query('UPDATE users SET role = $2, email_verified = TRUE, updated_at = now() WHERE id = $1',
        [existing.rows[0].id, 'admin']);
      await audit(tx, 'admin.bootstrap_promoted', 'user', String(existing.rows[0].id), {}, { type: 'system', id: 'bootstrap' });
    });
    console.log(`Promoted existing account ${input.data.email} to administrator.`);
  } else {
    const id = uuid();
    await db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO users (id, email, username, password_hash, role, email_verified, age_verified)
         VALUES ($1,$2,$3,$4,'admin',TRUE,TRUE)`,
        [id, input.data.email, input.data.username, await hashPassword(input.data.password)],
      );
      await tx.query('INSERT INTO profiles (user_id, display_name) VALUES ($1,$2)', [id, input.data.displayName ?? input.data.username]);
      await new LedgerService(db).ensureUserAccounts(tx, id);
      await audit(tx, 'admin.bootstrap_created', 'user', id, {}, { type: 'system', id: 'bootstrap' });
    });
    console.log(`Created administrator ${input.data.username} <${input.data.email}> (${id}).`);
  }
  console.log('Set up MFA from Account → Security before using privileged controls in production.');
} finally {
  await db.close();
}
