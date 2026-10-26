/* Shared integration-test harness. Sets an isolated test environment before
 * importing server modules whose configuration is captured at module load. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.NODE_ENV = 'development';
process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? 'rookstone-integration-test-secret-0123456789';
process.env.PUBLIC_ORIGIN = 'http://localhost:5173';
process.env.CORS_ORIGINS = 'http://localhost:5173';
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'silent';
process.env.ENGINE_ENABLED = 'false';
process.env.OPERATING_MODE = process.env.TEST_OPERATING_MODE ?? 'test';
process.env.TEST_FUNDS_ENABLED = 'true';
process.env.COMPLIANCE_ACTIVATION_PATH = path.join(os.tmpdir(), 'rookstone-no-activation.json');
process.env.AGE_VERIFICATION_PROVIDER = 'Test18Plus';
process.env.AGE_VERIFICATION_WEBHOOK_SECRET = 'integration-test-age-verification-secret-0123456789';

const { openDatabase } = await import('../server/db/client.js');
const { runMigrations } = await import('../server/db/migrate.js');
const { createContext } = await import('../server/services/context.js');
const { createLogger } = await import('../server/services/logger.js');
const { createApiRouter, apiErrorHandler } = await import('../server/http/routes.js');
const { RealtimeService } = await import('../server/games/realtime.js');
const { hashPassword } = await import('../server/auth/password.js');
const { uuid } = await import('../server/services/ids.js');
const { quoteTerms } = await import('../shared/contracts.js');
export { quoteTerms };
const { SYSTEM_ACCOUNTS } = await import('../server/finance/ledger.js');
export { SYSTEM_ACCOUNTS };
const express = (await import('express')).default;
const { Server: SocketServer } = await import('socket.io');
const { io: socketClient } = await import('socket.io-client');

export const ORIGIN = 'http://localhost:5173';

export class TestClient {
  private cookies = new Map<string, string>();
  csrf = '';
  constructor(public readonly base: string) {}

  get cookie(): string {
    return [...this.cookies.entries()].map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('; ');
  }

  private absorbCookies(response: Response): void {
    const raw = (response.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    for (const line of raw) {
      const [pair] = line.split(';');
      const index = pair.indexOf('=');
      if (index < 0) continue;
      const key = pair.slice(0, index).trim();
      const value = decodeURIComponent(pair.slice(index + 1).trim());
      if (value === '') this.cookies.delete(key); else this.cookies.set(key, value);
    }
    this.csrf = this.cookies.get('rs_csrf') ?? this.csrf;
  }

  async request<T = any>(method: string, urlPath: string, body?: unknown, options: { mfaCode?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: T; headers: Headers }> {
    const headers: Record<string, string> = {
      Origin: ORIGIN,
      ...(options.headers ?? {}),
    };
    if (this.cookie) headers.Cookie = this.cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && this.csrf) headers['X-CSRF-Token'] = this.csrf;
    if (options.mfaCode) headers['X-MFA-Code'] = options.mfaCode;
    const response = await fetch(`${this.base}${urlPath}`, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    this.absorbCookies(response);
    const text = await response.text();
    let parsed: unknown = text;
    try { parsed = text ? JSON.parse(text) : {}; } catch { /* raw text */ }
    return { status: response.status, body: parsed as T, headers: response.headers };
  }

  get<T = any>(urlPath: string, options?: { mfaCode?: string; headers?: Record<string, string> }) { return this.request<T>('GET', urlPath, undefined, options); }
  post<T = any>(urlPath: string, body?: unknown, options?: { mfaCode?: string; headers?: Record<string, string> }) { return this.request<T>('POST', urlPath, body, options); }
  patch<T = any>(urlPath: string, body?: unknown, options?: { mfaCode?: string; headers?: Record<string, string> }) { return this.request<T>('PATCH', urlPath, body, options); }
  delete<T = any>(urlPath: string, body?: unknown, options?: { mfaCode?: string; headers?: Record<string, string> }) { return this.request<T>('DELETE', urlPath, body, options); }

  fork(base: string): TestClient {
    const next = new TestClient(base);
    for (const [key, value] of this.cookies) (next as any).cookies.set(key, value);
    next.csrf = this.csrf;
    return next;
  }

  async register(username: string, email: string, password = 'Password123!', extra: Record<string, unknown> = {}) {
    const result = await this.post('/api/auth/register', { username, email, password, displayName: username, ...extra });
    if (result.status !== 201) throw new Error(`Register failed: ${result.status} ${JSON.stringify(result.body)}`);
    return result.body;
  }
  async login(email: string, password = 'Password123!', mfaCode?: string) {
    const result = await this.post('/api/auth/login', { email, password, mfaCode });
    if (result.status !== 200) throw new Error(`Login failed: ${result.status} ${JSON.stringify(result.body)}`);
    return result.body;
  }
}

export interface HarnessOptions { pgliteDir?: string; preserveDir?: boolean }
export interface Harness {
  db: any; ctx: any; base: string; pgliteDir: string; io: any; realtime: any;
  client: () => TestClient;
  close: (removeDir?: boolean) => Promise<void>;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const pgliteDir = options.pgliteDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'rookstone-test-'));
  fs.mkdirSync(pgliteDir, { recursive: true });
  const db = await openDatabase({ driver: 'pglite', pgliteDir });
  await runMigrations(db);
  const ctx = createContext(db, createLogger());
  const app = express();
  app.disable('x-powered-by');
  app.use('/api/payments/webhook', express.text({ type: '*/*', limit: '256kb' }));
  app.use(express.json({ limit: '256kb' }));
  app.use('/api', createApiRouter(ctx));
  app.use('/api', (_req: unknown, res: any) => res.status(404).json({ error: { code: 'not_found', message: 'Not found' } }));
  app.use(apiErrorHandler);
  const server = http.createServer(app);
  const io = new SocketServer(server, { cors: { origin: true, credentials: true }, transports: ['websocket', 'polling'] });
  const realtime = new RealtimeService(io, ctx);
  ctx.realtime = realtime;
  realtime.attach();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  const base = `http://127.0.0.1:${address.port}`;
  let closed = false;
  return {
    db, ctx, base, pgliteDir, io, realtime,
    client: () => new TestClient(base),
    close: async (removeDir = !options.preserveDir) => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => io.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
      if (removeDir) fs.rmSync(pgliteDir, { recursive: true, force: true });
    },
  };
}

export async function createAdmin(ctx: any, username = 'AdminUser', email = 'admin@example.com', password = 'AdminPassword123!') {
  const id = uuid();
  await ctx.db.transaction(async (tx: any) => {
    await tx.query(
      `INSERT INTO users (id, email, username, password_hash, role, email_verified, age_verified)
       VALUES ($1,$2,$3,$4,'admin',TRUE,TRUE)`,
      [id, email, username, await hashPassword(password)],
    );
    await tx.query('INSERT INTO profiles (user_id, display_name) VALUES ($1,$2)', [id, username]);
    await ctx.ledger.ensureUserAccounts(tx, id);
  });
  return { id, username, email, password };
}

export async function socketFor(harness: Harness, client: TestClient): Promise<any> {
  const socket = socketClient(harness.base, {
    path: '/socket.io',
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    extraHeaders: { Cookie: client.cookie, Origin: ORIGIN },
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket connection timed out')), 5000);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('connect_error', (error: Error) => { clearTimeout(timer); reject(error); });
  });
  return socket;
}

export function emitAck(socket: any, event: string, payload: unknown): Promise<any> {
  return socket.timeout(6000).emitWithAck(event, payload);
}

export function waitForEvent<T = any>(socket: any, event: string, predicate: (payload: T) => boolean = () => true, timeoutMs = 6000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(event, handler); reject(new Error(`Timed out waiting for ${event}`)); }, timeoutMs);
    const handler = (payload: T) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

export async function waitFor<T>(fn: () => T | Promise<T>, predicate: (value: T) => boolean, timeoutMs = 5000): Promise<T> {
  const started = Date.now();
  let last = await fn();
  while (!predicate(last)) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for condition; last=${JSON.stringify(last)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    last = await fn();
  }
  return last;
}

export async function fundUser(ctx: any, userId: string, amountCents: number) {
  return ctx.payments.grantTestCredits(userId, amountCents, userId);
}

export async function createStakedGame(ctx: any, whiteId: string, blackId: string, stakeCents: number, feeBps = 500) {
  const terms = quoteTerms(stakeCents, feeBps);
  await fundUser(ctx, whiteId, stakeCents * 2);
  await fundUser(ctx, blackId, stakeCents * 2);
  const created = await ctx.games.createGame({
    whiteId, blackId, mode: 'test',
    timeControl: { category: 'blitz', baseMs: 180_000, incrementMs: 2_000 },
    terms, termsHash: '0'.repeat(64),
  });
  const white = await ctx.ledger.ensureUserAccounts(ctx.db, whiteId);
  const black = await ctx.ledger.ensureUserAccounts(ctx.db, blackId);
  await ctx.ledger.postTransaction({
    type: 'stake_reservation', reference: `RSV-TEST-${created.gameId}`,
    idempotencyKey: `reservation:test:${created.gameId}`,
    description: 'Test stake reservation',
    entries: [
      { accountId: white.availableId, amountCents: -stakeCents },
      { accountId: white.reservedId, amountCents: stakeCents },
      { accountId: black.availableId, amountCents: -stakeCents },
      { accountId: black.reservedId, amountCents: stakeCents },
    ],
    metadata: { terms },
  });
  return { ...created, terms };
}

export async function makeUsers(harness: Harness, prefix: string): Promise<{ whiteId: string; blackId: string; white: TestClient; black: TestClient }> {
  const white = harness.client();
  const black = harness.client();
  const whiteResult = await white.register(`${prefix}White`, `${prefix.toLowerCase()}-white@example.com`);
  const blackResult = await black.register(`${prefix}Black`, `${prefix.toLowerCase()}-black@example.com`);
  return { whiteId: whiteResult.user.id, blackId: blackResult.user.id, white, black };
}
