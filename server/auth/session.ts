import type { Request, Response, NextFunction } from 'express';
import type { IncomingHttpHeaders } from 'node:http';
import { randomToken, sha256, uuid } from '../services/ids.js';
import { sessionSecret } from '../services/secrets.js';
import { env } from '../config/env.js';
import { unauthorized, forbidden } from '../services/errors.js';
import type { Database, Queryable, Row } from '../db/client.js';
import { isAllowedOrigin } from '../http/origins.js';
import type { Role } from '../../shared/contracts.js';

export const SESSION_COOKIE = 'rs_session';
export const CSRF_COOKIE = 'rs_csrf';
const CSRF_HEADER = 'x-csrf-token';

export interface AuthUser {
  id: string;
  sessionId: string;
  username: string;
  email: string;
  displayName: string;
  role: Role;
  status: string;
  emailVerified: boolean;
  ageVerified: boolean;
  mfaEnabled: boolean;
  csrfHash: string;
}

export type AuthedRequest = Request & { auth?: AuthUser };

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try { out[key] = decodeURIComponent(value); } catch { out[key] = value; }
  }
  return out;
}

export function ipHashFromRequest(req: { headers: IncomingHttpHeaders; socket?: { remoteAddress?: string } }): string {
  const forwarded = req.headers['x-forwarded-for'];
  const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim()
    ?? req.socket?.remoteAddress ?? 'unknown';
  return sha256(`${sessionSecret()}|${ip}`).slice(0, 40);
}

export async function createSession(
  db: Database,
  userId: string,
  req: Pick<Request, 'headers' | 'socket'>,
  res: Response,
): Promise<{ token: string; csrfToken: string; sessionId: string; expiresAt: Date }> {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const expiresAt = new Date(Date.now() + env.sessionTtlHours * 3_600_000);
  const sessionId = uuid();
  await db.query(
    `INSERT INTO auth_sessions (id, user_id, token_hash, csrf_hash, ip_hash, user_agent, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [sessionId, userId, sha256(sessionSecret() + token), sha256(sessionSecret() + csrfToken),
      ipHashFromRequest(req), String(req.headers['user-agent'] ?? '').slice(0, 300), expiresAt.toISOString()],
  );
  const cookieOptions = {
    httpOnly: true, sameSite: 'lax' as const, secure: env.isProduction,
    path: '/', expires: expiresAt,
  };
  res.cookie(SESSION_COOKIE, token, cookieOptions);
  res.cookie(CSRF_COOKIE, csrfToken, { ...cookieOptions, httpOnly: false });
  return { token, csrfToken, sessionId, expiresAt };
}

export async function findSession(
  db: Queryable,
  headers: IncomingHttpHeaders,
): Promise<AuthUser | null> {
  const cookies = parseCookies(headers.cookie);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const result = await db.query<Row>(`
    SELECT u.id, u.username, u.email, u.role, u.status, u.email_verified, u.age_verified, u.mfa_enabled,
           p.display_name, s.id AS session_id, s.csrf_hash, s.expires_at, s.revoked_at
    FROM auth_sessions s
    JOIN users u ON u.id = s.user_id
    JOIN profiles p ON p.user_id = u.id
    WHERE s.token_hash = $1`, [sha256(sessionSecret() + token)]);
  const row = result.rows[0];
  if (!row || row.revoked_at || new Date(String(row.expires_at)).getTime() <= Date.now()) return null;
  if (row.status !== 'active') return null;
  return {
    id: String(row.id), sessionId: String(row.session_id), username: String(row.username),
    email: String(row.email), displayName: String(row.display_name), role: row.role as Role,
    status: String(row.status), emailVerified: Boolean(row.email_verified),
    ageVerified: Boolean(row.age_verified), mfaEnabled: Boolean(row.mfa_enabled), csrfHash: String(row.csrf_hash),
  };
}

export async function requireAuth(db: Database, req: AuthedRequest, _res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await findSession(db, req.headers);
    if (!user) throw unauthorized();
    req.auth = user;
    next();
  } catch (error) { next(error); }
}

export async function requireAdmin(db: Database, req: AuthedRequest, _res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await findSession(db, req.headers);
    if (!user) throw unauthorized();
    if (user.role !== 'admin') throw forbidden('Administrator access required');
    req.auth = user;
    next();
  } catch (error) { next(error); }
}

/** Agent or administrator: the cash-voucher console is available to both. */
export async function requireAgent(db: Database, req: AuthedRequest, _res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await findSession(db, req.headers);
    if (!user) throw unauthorized();
    if (user.role !== 'agent' && user.role !== 'admin') throw forbidden('Cash-agent access required');
    req.auth = user;
    next();
  } catch (error) { next(error); }
}

export async function requireCsrf(db: Database, req: AuthedRequest, _res: Response, next: NextFunction): Promise<void> {
  try {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    const user = req.auth ?? await findSession(db, req.headers);
    if (!user) throw unauthorized();
    // Same-origin check: browser state-changing requests must come from an allowed origin.
    const origin = req.headers.origin;
    if (origin && !isAllowedOrigin(String(origin))) {
      throw forbidden('Request origin is not allowed');
    }
    const header = String(req.headers[CSRF_HEADER] ?? '');
    const cookies = parseCookies(req.headers.cookie);
    if (header !== cookies[CSRF_COOKIE]) throw forbidden('CSRF token missing or mismatched');
    if (sha256(sessionSecret() + header) !== user.csrfHash) throw forbidden('CSRF token is invalid');
    req.auth = user;
    next();
  } catch (error) { next(error); }
}

export async function revokeSession(db: Database, headers: IncomingHttpHeaders, res?: Response): Promise<void> {
  const token = parseCookies(headers.cookie)[SESSION_COOKIE];
  if (token) {
    await db.query('UPDATE auth_sessions SET revoked_at = now() WHERE token_hash = $1', [sha256(sessionSecret() + token)]);
  }
  if (res) {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.clearCookie(CSRF_COOKIE, { path: '/' });
  }
}

export function assertSocketOrigin(headers: IncomingHttpHeaders): void {
  const origin = headers.origin;
  if (!origin) throw forbidden('WebSocket origin is required');
  if (!isAllowedOrigin(origin)) {
    throw forbidden('WebSocket origin is not allowed');
  }
}

export function cookieHeaderForTests(token: string, csrf: string): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${CSRF_COOKIE}=${encodeURIComponent(csrf)}`;
}
