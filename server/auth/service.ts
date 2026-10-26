import type { Request, Response } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import type { Database, Row } from '../db/client.js';
import { AppError, badRequest, conflict, forbidden, notFound, unauthorized, unavailable } from '../services/errors.js';
import { audit, notify } from '../services/audit.js';
import { uuid, randomToken, sha256, hmacHex, safeEqualHex } from '../services/ids.js';
import { sessionSecret } from '../services/secrets.js';
import type { LedgerService } from '../finance/ledger.js';
import type { Mailer } from '../services/mailer.js';
import type { AppLogger } from '../services/logger.js';
import { newSignInEmail, passwordResetEmail, verificationEmail } from '../services/email-templates.js';
import { hashPassword, verifyPassword } from './password.js';
import { generateTotpSecret, verifyTotp, encryptTotpSecret, decryptTotpSecret, otpauthUrl } from './totp.js';
import { createSession, findSession, ipHashFromRequest, parseCookies, revokeSession, type AuthUser } from './session.js';
import { loginSchema, registerSchema, passwordSchema, emailSchema, internationalProfileSchema } from '../../shared/validation.js';
import type { PublicUser } from '../../shared/contracts.js';
import type { EligibilityService } from '../eligibility/service.js';

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

export class AuthService {
  constructor(
    private readonly db: Database,
    private readonly ledger: LedgerService,
    private readonly mailer: Mailer,
    private readonly log: AppLogger,
    private readonly eligibility: EligibilityService,
  ) {}

  async publicUser(userId: string): Promise<PublicUser> {
    const result = await this.db.query<Row>(`
      SELECT u.id, u.username, u.role, u.status, u.email_verified, u.age_verified,
             u.country, u.country_shared, u.timezone, u.timezone_shared,
             u.account_currency, u.created_at, p.display_name, p.rating
      FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.id = $1`, [userId]);
    const row = result.rows[0];
    if (!row) throw notFound('Account not found');
    return {
      id: String(row.id), username: String(row.username), displayName: String(row.display_name),
      role: row.role as 'player' | 'admin', status: String(row.status),
      emailVerified: Boolean(row.email_verified), ageVerified: Boolean(row.age_verified),
      country: String(row.country),
      countryShared: Boolean(row.country_shared),
      timezone: Boolean(row.timezone_shared) ? String(row.timezone) : null,
      timezoneShared: Boolean(row.timezone_shared),
      accountCurrency: String(row.account_currency ?? 'USD').trim() || 'USD',
      createdAt: new Date(String(row.created_at)).toISOString(), rating: Number(row.rating),
    };
  }

  async register(input: z.infer<typeof registerSchema>, req: Request, res: Response) {
    const data = registerSchema.parse(input);
    const existing = await this.db.query(
      'SELECT id FROM users WHERE lower(email) = lower($1) OR lower(username) = lower($2)',
      [data.email, data.username],
    );
    if (existing.rows.length) throw conflict('That email or username is already registered');

    const userId = uuid();
    const passwordHash = await hashPassword(data.password);
    const token = randomToken(32);
    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO users
          (id, email, username, password_hash, country, country_shared,
           timezone, timezone_shared, account_currency)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [userId, data.email, data.username, passwordHash, data.country.toUpperCase(),
          data.countryShared && data.country !== 'ZZ', data.timezone,
          data.timezoneShared, data.accountCurrency],
      );
      await tx.query(
        `INSERT INTO profiles (user_id, display_name) VALUES ($1,$2)`,
        [userId, data.displayName ?? data.username],
      );
      await this.ledger.ensureUserAccounts(tx, userId, data.accountCurrency);
      await tx.query(
        `INSERT INTO one_time_tokens (id, user_id, kind, token_hash, expires_at)
         VALUES ($1,$2,'email_verify',$3,$4)`,
        [uuid(), userId, sha256(sessionSecret() + token), new Date(Date.now() + 48 * 3_600_000).toISOString()],
      );
      await audit(tx, 'auth.register', 'user', userId, { username: data.username }, { type: 'user', id: userId });
      await notify(tx, userId, {
        type: 'welcome', title: 'Welcome to Rookstone Arena',
        body: 'Your account is ready. Verify your email to enable password recovery.', link: '/settings',
      });
    });
    const delivery = await this.mailer.sendContent(
      data.email,
      verificationEmail(`${env.publicOrigin}/verify-email?token=${encodeURIComponent(token)}`),
    );
    const session = await createSession(this.db, userId, req, res);
    await this.db.query(
      `INSERT INTO security_events (user_id, kind, ip_hash, user_agent, detail)
       VALUES ($1,'registration',$2,$3,$4::jsonb)`,
      [userId, ipHashFromRequest(req), String(req.headers['user-agent'] ?? '').slice(0, 300), JSON.stringify({ emailDelivered: delivery.delivered })],
    );
    return {
      user: await this.publicUser(userId), csrfToken: session.csrfToken,
      emailDelivery: delivery,
      // Local development only: lets the recovery workflow be tested without SMTP.
      devVerificationToken: env.isProduction ? undefined : token,
    };
  }

  async login(input: unknown, req: Request, res: Response) {
    const data = loginSchema.parse(input);
    const result = await this.db.query<Row>(
      `SELECT id, password_hash, status, failed_logins, locked_until, mfa_enabled, mfa_secret FROM users WHERE lower(email) = lower($1)`,
      [data.email],
    );
    const row = result.rows[0];
    if (!row) {
      await this.securityEvent(null, 'login_failed', req, { reason: 'unknown_email' });
      throw unauthorized('Invalid email or password');
    }
    if (row.status !== 'active') throw forbidden('This account is suspended or self-excluded');
    if (row.locked_until && new Date(String(row.locked_until)).getTime() > Date.now()) {
      throw unauthorized('Too many attempts. Try again later.');
    }
    const valid = await verifyPassword(String(row.password_hash), data.password);
    if (!valid) {
      const failed = Number(row.failed_logins) + 1;
      const lockUntil = failed >= MAX_FAILED_LOGINS
        ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() : null;
      await this.db.query(
        `UPDATE users SET failed_logins = $1, locked_until = $2 WHERE id = $3`,
        [failed, lockUntil, row.id],
      );
      await this.securityEvent(String(row.id), 'login_failed', req, { attempts: failed });
      throw unauthorized('Invalid email or password');
    }
    if (Boolean(row.mfa_enabled)) {
      if (!data.mfaCode) throw new AppError(401, 'mfa_required', 'Enter the six-digit code from your authenticator app');
      try {
        if (!verifyTotp(decryptTotpSecret(String(row.mfa_secret)), data.mfaCode)) {
          throw new AppError(401, 'mfa_invalid', 'Invalid MFA code');
        }
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(401, 'mfa_invalid', 'Invalid MFA code');
      }
    }
    await this.db.query(
      `UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`,
      [row.id],
    );
    const session = await createSession(this.db, String(row.id), req, res);
    const ipHash = ipHashFromRequest(req);
    await this.securityEvent(String(row.id), 'login_success', req, { sessionId: session.sessionId });
    const prior = await this.db.query(
      `SELECT id FROM security_events
       WHERE user_id = $1 AND kind = 'login_success' AND ip_hash = $2
         AND created_at < now() - interval '30 seconds' LIMIT 1`,
      [row.id, ipHash],
    );
    if (!prior.rows.length && this.mailer.configured) {
      await this.mailer.sendContent(data.email, newSignInEmail(new Date().toISOString()));
    }
    return { user: await this.publicUser(String(row.id)), csrfToken: session.csrfToken };
  }

  private async securityEvent(userId: string | null, kind: string, req: Request, detail: Record<string, unknown>): Promise<void> {
    await this.db.query(
      `INSERT INTO security_events (user_id, kind, ip_hash, user_agent, detail)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [userId, kind, ipHashFromRequest(req), String(req.headers['user-agent'] ?? '').slice(0, 300), JSON.stringify(detail)],
    );
  }

  async logout(req: Request, res: Response): Promise<void> {
    const user = await findSession(this.db, req.headers);
    await revokeSession(this.db, req.headers, res);
    if (user) await this.securityEvent(user.id, 'logout', req, {});
  }

  async revokeAllSessions(userId: string, exceptSessionId?: string): Promise<number> {
    const result = await this.db.query(
      `UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND id <> $2`,
      [userId, exceptSessionId ?? '00000000-0000-0000-0000-000000000000'],
    );
    return result.rowCount;
  }

  async session(req: Request): Promise<{ user: PublicUser; csrfToken: string }> {
    const user = await findSession(this.db, req.headers);
    if (!user) throw unauthorized();
    const csrfToken = parseCookies(req.headers.cookie)['rs_csrf'] ?? '';
    return { user: await this.publicUser(user.id), csrfToken };
  }

  async createOneTimeToken(userId: string, kind: 'email_verify' | 'password_reset'): Promise<{ token: string; email: string }> {
    const result = await this.db.query<Row>('SELECT email FROM users WHERE id = $1', [userId]);
    if (!result.rows.length) throw notFound('Account not found');
    const token = randomToken(32);
    await this.db.query(
      `INSERT INTO one_time_tokens (id, user_id, kind, token_hash, expires_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [uuid(), userId, kind, sha256(sessionSecret() + token), new Date(Date.now() + 60 * 60_000).toISOString()],
    );
    return { token, email: String(result.rows[0].email) };
  }

  async forgotPassword(email: string): Promise<{ delivered: boolean; devResetToken?: string; reason?: string }> {
    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) throw badRequest('Enter a valid email address');
    const result = await this.db.query<Row>('SELECT id, email FROM users WHERE lower(email) = lower($1)', [parsed.data]);
    // Do not disclose whether the address exists.
    if (!result.rows.length) return { delivered: true };
    const { token, email: address } = await this.createOneTimeToken(String(result.rows[0].id), 'password_reset');
    const delivery = await this.mailer.sendContent(
      address,
      passwordResetEmail(`${env.publicOrigin}/reset-password?token=${encodeURIComponent(token)}`),
    );
    return {
      delivered: delivery.delivered, reason: delivery.reason,
      devResetToken: env.isProduction ? undefined : token,
    };
  }

  async consumeOneTimeToken(token: string, kind: 'email_verify' | 'password_reset', password?: string): Promise<string> {
    const hash = sha256(sessionSecret() + token);
    return this.db.transaction(async (tx) => {
      const result = await tx.query<Row>(
        `SELECT id, user_id, expires_at, used_at FROM one_time_tokens WHERE token_hash = $1 AND kind = $2 FOR UPDATE`,
        [hash, kind],
      );
      const row = result.rows[0];
      if (!row || row.used_at || new Date(String(row.expires_at)).getTime() <= Date.now()) {
        throw badRequest('This link is invalid or has expired');
      }
      await tx.query('UPDATE one_time_tokens SET used_at = now() WHERE id = $1', [row.id]);
      if (kind === 'email_verify') {
        await tx.query('UPDATE users SET email_verified = TRUE, updated_at = now() WHERE id = $1', [row.user_id]);
      } else {
        const newPassword = passwordSchema.parse(password);
        await tx.query(
          'UPDATE users SET password_hash = $1, failed_logins = 0, locked_until = NULL, updated_at = now() WHERE id = $2',
          [await hashPassword(newPassword), row.user_id],
        );
        await tx.query(
          `UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
          [row.user_id],
        );
      }
      await audit(tx, `auth.${kind}`, 'user', String(row.user_id), {}, { type: 'user', id: String(row.user_id) });
      return String(row.user_id);
    });
  }

  async changePassword(userId: string, current: string, next: string): Promise<void> {
    const password = passwordSchema.parse(next);
    const result = await this.db.query<Row>('SELECT password_hash FROM users WHERE id = $1', [userId]);
    if (!result.rows.length) throw notFound('Account not found');
    if (!await verifyPassword(String(result.rows[0].password_hash), current)) throw unauthorized('Current password is incorrect');
    await this.db.query(
      `UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2`,
      [await hashPassword(password), userId],
    );
    await this.revokeAllSessions(userId);
    await this.db.query(
      `INSERT INTO security_events (user_id, kind, detail) VALUES ($1,'password_changed','{}'::jsonb)`,
      [userId],
    );
  }

  /**
   * Age-verification provider integration point. No age is inferred from a
   * self-declared birth date: only a signed provider callback can set the flag.
   */
  async ageVerificationCallback(input: {
    userId: string; providerReference: string; verified: boolean; signature: string; rawPayload: string;
    jurisdiction?: string; identityVerified?: boolean; locationVerified?: boolean;
  }): Promise<void> {
    if (!env.ageVerificationProvider || !env.ageVerificationWebhookSecret) {
      throw unavailable('Age-verification provider integration is not configured');
    }
    const expected = hmacHex(env.ageVerificationWebhookSecret, input.rawPayload);
    if (!safeEqualHex(expected, input.signature)) throw unauthorized('Invalid age-verification signature');
    if (!input.verified) throw badRequest('Provider did not verify the account');
    const jurisdiction = input.jurisdiction ? String(input.jurisdiction).toUpperCase() : null;
    if (jurisdiction && !/^[A-Z]{2}$/.test(jurisdiction)) throw badRequest('Invalid verified jurisdiction');
    const identityVerified = input.identityVerified !== false;
    const locationVerified = input.locationVerified !== false;
    const verifiedJurisdiction = jurisdiction && locationVerified ? jurisdiction : null;
    await this.db.transaction(async (tx) => {
      const updated = await tx.query(
        `UPDATE users SET
           age_verified = TRUE, age_verified_at = now(),
           identity_verified = CASE WHEN $2::boolean THEN TRUE ELSE identity_verified END,
           eligibility_jurisdiction = COALESCE($3::char(2), eligibility_jurisdiction),
           eligibility_verified_at = CASE WHEN $3::char(2) IS NOT NULL THEN now() ELSE eligibility_verified_at END,
           eligibility_provider_ref = CASE WHEN $3::char(2) IS NOT NULL THEN $4 ELSE eligibility_provider_ref END,
           location_verified_at = CASE WHEN $3::char(2) IS NOT NULL THEN now() ELSE location_verified_at END,
           updated_at = now()
         WHERE id = $1 RETURNING id`,
        [input.userId, identityVerified, verifiedJurisdiction, input.providerReference],
      );
      if (!updated.rows.length) throw notFound('Account not found');
      await audit(tx, 'auth.eligibility_verified', 'user', input.userId, {
        provider: env.ageVerificationProvider, reference: input.providerReference,
        jurisdiction, identityVerified, locationVerified,
      }, { type: 'provider', id: env.ageVerificationProvider });
    });
  }

  async updateInternational(userId: string, input: unknown) {
    const data = internationalProfileSchema.parse(input);
    const current = await this.db.query<Row>(`
      SELECT country, country_shared, timezone, timezone_shared, account_currency
      FROM users WHERE id = $1`, [userId]);
    if (!current.rows.length) throw notFound('Account not found');
    const row = current.rows[0];
    const country = String(data.country ?? row.country ?? 'ZZ').toUpperCase();
    const countryShared = Boolean(data.countryShared ?? row.country_shared);
    if (country === 'ZZ' && countryShared) throw badRequest('Choose a country before sharing it');
    const timezone = String(data.timezone ?? row.timezone ?? 'UTC');
    const timezoneShared = Boolean(data.timezoneShared ?? row.timezone_shared);
    const accountCurrency = String(data.accountCurrency ?? row.account_currency ?? 'USD').toUpperCase();
    await this.db.transaction(async (tx) => {
      await tx.query(
        `UPDATE users SET country = $2, country_shared = $3, timezone = $4,
           timezone_shared = $5, account_currency = $6, updated_at = now() WHERE id = $1`,
        [userId, country, countryShared, timezone, timezoneShared, accountCurrency],
      );
      await audit(tx, 'account.international_updated', 'user', userId, {
        country, countryShared, timezone, timezoneShared, accountCurrency,
      }, { type: 'user', id: userId });
    });
    return this.eligibility.stateFor(userId);
  }


  async setupMfa(userId: string): Promise<{ secret: string; otpauthUrl: string; enabled: boolean }> {
    const secret = generateTotpSecret();
    await this.db.query('UPDATE users SET mfa_secret = $2, mfa_enabled = FALSE, updated_at = now() WHERE id = $1',
      [userId, encryptTotpSecret(secret)]);
    const user = await this.publicUser(userId);
    return { secret, otpauthUrl: otpauthUrl(secret, user.username), enabled: false };
  }

  async enableMfa(userId: string, code: string): Promise<boolean> {
    const result = await this.db.query<Row>('SELECT mfa_secret FROM users WHERE id = $1', [userId]);
    const encrypted = result.rows[0]?.mfa_secret;
    if (!encrypted || !verifyTotp(decryptTotpSecret(String(encrypted)), code)) {
      throw unauthorized('Invalid MFA code');
    }
    await this.db.transaction(async (tx) => {
      await tx.query('UPDATE users SET mfa_enabled = TRUE, updated_at = now() WHERE id = $1', [userId]);
      await audit(tx, 'auth.mfa_enabled', 'user', userId, {}, { type: 'user', id: userId });
    });
    return true;
  }

  async disableMfa(userId: string, code: string, currentPassword: string): Promise<boolean> {
    const result = await this.db.query<Row>(
      'SELECT mfa_secret, password_hash FROM users WHERE id = $1', [userId]);
    const row = result.rows[0];
    if (!row?.mfa_secret || !verifyTotp(decryptTotpSecret(String(row.mfa_secret)), code)) {
      throw unauthorized('Invalid MFA code');
    }
    if (!await verifyPassword(String(row.password_hash), currentPassword)) throw unauthorized('Password is incorrect');
    await this.db.transaction(async (tx) => {
      await tx.query('UPDATE users SET mfa_enabled = FALSE, mfa_secret = NULL, updated_at = now() WHERE id = $1', [userId]);
      await audit(tx, 'auth.mfa_disabled', 'user', userId, {}, { type: 'user', id: userId });
    });
    return true;
  }

  async verifyMfaCode(userId: string, code: string): Promise<boolean> {
    const result = await this.db.query<Row>(
      'SELECT mfa_secret FROM users WHERE id = $1 AND mfa_enabled = TRUE', [userId]);
    const encrypted = result.rows[0]?.mfa_secret;
    if (!encrypted) return false;
    try { return verifyTotp(decryptTotpSecret(String(encrypted)), code); } catch { return false; }
  }

  async assertRealMoneyEligible(userId: string): Promise<void> {
    await this.eligibility.assertRealMoneyEligible(userId);
  }

  async assertNotRestricted(userId: string, stakeCents: number): Promise<void> {
    const restrictions = await this.db.query<Row>(`
      SELECT type, value_cents FROM responsible_play_restrictions
      WHERE user_id = $1 AND active = TRUE AND (expires_at IS NULL OR expires_at > now())`, [userId]);
    const active = restrictions.rows.map((r) => ({ type: String(r.type), value: Number(r.value_cents) }));
    if (active.some((r) => r.type === 'self_exclusion')) throw forbidden('Self-exclusion is active on this account');
    const limit = active.find((r) => r.type === 'daily_stake_limit');
    if (limit) {
      const spent = await this.db.query<Row>(`
        SELECT COALESCE(SUM(ABS(le.amount_cents)), 0) AS total
        FROM ledger_entries le
        JOIN ledger_transactions lt ON lt.id = le.transaction_id
        JOIN wallet_accounts wa ON wa.id = le.wallet_account_id
        WHERE wa.owner_type = 'user' AND wa.owner_id = $1 AND lt.type = 'stake_reservation'
          AND lt.created_at >= date_trunc('day', now()) AND le.amount_cents < 0`, [userId]);
      if (Number(spent.rows[0]?.total ?? 0) + stakeCents > limit.value) {
        throw forbidden('Your daily competition-spending limit would be exceeded');
      }
    }
  }

  async requireAuthUser(req: Request): Promise<AuthUser> {
    const user = await findSession(this.db, req.headers);
    if (!user) throw unauthorized();
    return user;
  }
}
