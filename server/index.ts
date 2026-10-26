import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { Server as SocketServer } from 'socket.io';
import { env, assertProductionSafety, ConfigurationError } from './config/env.js';
import { openDatabase, type Database } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { createContext } from './services/context.js';
import { createLogger } from './services/logger.js';
import { RealtimeService } from './games/realtime.js';
import { createApiRouter, apiErrorHandler } from './http/routes.js';
import { corsOptions, socketOriginCallback } from './http/origins.js';

type BootPhase = 'starting' | 'ready' | 'error';

interface BootState {
  phase: BootPhase;
  problems: string[];
}

const CONFIG_HELP = [
  'Set the missing values in the hosting dashboard, then redeploy. See docs/DEPLOYMENT.md.',
  'Build command: npm ci --include=dev && npm run build',
  'Start command: npm start (the compatibility `node server.js` works too)',
  'Node version:  22.x (verified on 22.22.3)',
];

function printConfigurationFailure(problems: string[]): void {
  console.error('');
  console.error('Rookstone Arena cannot start because its production configuration is incomplete.');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('');
  for (const line of CONFIG_HELP) console.error(line);
  console.error('');
  console.error('The port stays bound and /api/health reports 503 with this list so the platform');
  console.error('shows a health-check failure instead of a misleading "no open ports" error.');
  console.error('');
}

async function main(): Promise<void> {
  const log = createLogger();
  const boot: BootState = { phase: 'starting', problems: [] };
  let live: Express | null = null;

  /**
   * Requests are answered by a tiny bootstrap responder until the application
   * is fully initialised. Binding the port first keeps platform port scanners
   * (Render fails a deploy if nothing listens within 60 s) happy while
   * migrations, the engine health check and settlement recovery run.
   */
  const server = http.createServer((req, res) => {
    if (live) {
      live(req, res);
      return;
    }
    const url = req.url ?? '/';
    const isHealth = url === '/api/health' || url.startsWith('/api/health?');
    const failed = boot.phase === 'error';
    const body = failed
      ? isHealth
        ? { status: 'error', ready: false, problems: boot.problems }
        : { error: { code: 'configuration_error', message: 'Service is not configured correctly' }, problems: boot.problems }
      : isHealth
        ? { status: 'starting', ready: false }
        : { error: { code: 'starting', message: 'Service is still initialising' } };
    const payload = JSON.stringify(body);
    res.writeHead(503, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      'cache-control': 'no-store',
      'retry-after': '2',
    });
    res.end(payload);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(env.port, env.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const bootStartedAt = Date.now();
  log.info({ port: env.port, host: env.host, ready: false }, 'port bound; initializing');

  let io: SocketServer | null = null;
  let db: Database | null = null;
  let ctx: ReturnType<typeof createContext> | null = null;
  const timers: NodeJS.Timeout[] = [];
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'graceful shutdown started');
    for (const timer of timers) clearInterval(timer);
    const force = setTimeout(() => process.exit(1), 12_000);
    force.unref();
    try {
      if (ctx) await ctx.games.pauseAllClocks();
      if (io) await new Promise<void>((resolve) => io!.close(() => resolve()));
      const closing = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections?.();
      await closing;
      if (db) await db.close();
      log.info('graceful shutdown complete');
      process.exit(0);
    } catch (error) {
      log.error({ err: (error as Error).message }, 'graceful shutdown failed');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });

  try {
    assertProductionSafety();

    db = await openDatabase();
    const migrations = await runMigrations(db);
    ctx = createContext(db, log);

    const emailStatus = ctx.mailer.status();
    if (!emailStatus.configured) {
      log.warn(
        { provider: emailStatus.provider, problems: emailStatus.problems },
        'email delivery is not configured; email verification and password reset will not be delivered',
      );
    }

    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', env.trustProxy);
    app.use(helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          baseUri: ["'self'"],
          objectSrc: ["'none'"],
          scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
          workerSrc: ["'self'", 'blob:'],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          fontSrc: ["'self'", 'data:'],
          connectSrc: ["'self'", 'ws:', 'wss:'],
          formAction: ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: false,
      crossOriginResourcePolicy: false,
      frameguard: false,
      hsts: env.isProduction ? { maxAge: 15_768_000, includeSubDomains: true, preload: false } : false,
    }));
    app.use(cors(corsOptions));
    app.use((req, res, next) => {
      const started = Date.now();
      res.on('finish', () => {
        if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) {
          log.info({ method: req.method, path: req.path, status: res.statusCode, durationMs: Date.now() - started }, 'http request');
        }
      });
      next();
    });

    // Provider callbacks need the exact raw bytes for signature verification.
    app.use('/api/payments/webhook', express.text({ type: '*/*', limit: '256kb' }));
    app.use(express.json({ limit: '256kb' }));
    app.use('/api', createApiRouter(ctx));
    app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'not_found', message: 'API endpoint not found' } }));

    const webRoot = path.join(env.root, 'dist', 'web');
    if (fs.existsSync(path.join(webRoot, 'index.html'))) {
      app.use(express.static(webRoot, { index: false, maxAge: env.isProduction ? '1h' : 0, setHeaders: (res, filePath) => {
        if (filePath.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm');
      } }));
      app.get('*', (_req, res) => res.sendFile(path.join(webRoot, 'index.html')));
    } else {
      app.get('/', (_req, res) => res.type('text/plain').send(
        'Rookstone Arena API is running. Build the React client with `npm run build:web` or run `npm run dev`.'));
    }
    app.use(apiErrorHandler);

    // Socket.IO attaches to the already-listening server and preserves the
    // bootstrap dispatcher for every non-/socket.io request.
    io = new SocketServer(server, {
      path: '/socket.io',
      cors: { origin: socketOriginCallback, credentials: true },
      transports: ['websocket', 'polling'],
      maxHttpBufferSize: 1_000_000,
    });
    const realtime = new RealtimeService(io, ctx);
    ctx.realtime = realtime;
    realtime.attach();

    const paused = await ctx.games.recoverClocks();
    const settlementRecovery = await ctx.settlement.settlePending();
    const engineHealth = await ctx.engine.health();

    let tickRunning = false;
    const tick = async () => {
      if (tickRunning) return;
      tickRunning = true;
      try {
        const events = await ctx!.games.checkTimeouts();
        await realtime.publishEvents(events);
        const abandoned = await ctx!.games.checkAbandonment();
        await realtime.publishEvents(abandoned);
      } catch (error) {
        log.warn({ err: (error as Error).message }, 'game maintenance tick failed');
      } finally { tickRunning = false; }
    };
    timers.push(
      setInterval(() => { void tick(); }, 1_000),
      setInterval(() => {
        void Promise.all([
          ctx!.competition.expireChallenges(),
          ctx!.competition.cleanupTickets(),
          ctx!.cash.expireStale(),
        ]).catch((error) => log.warn({ err: (error as Error).message }, 'lobby cleanup failed'));
      }, 30_000),
      setInterval(() => {
        void ctx!.settlement.settlePending().then((result) => {
          if (result.posted || result.failed.length) log.info(result, 'settlement recovery');
        }).catch((error) => log.warn({ err: (error as Error).message }, 'settlement recovery failed'));
      }, 60_000),
      setInterval(() => {
        void ctx!.payments.reconcilePending().then((result) => {
          if (result.changed || result.errors.length) log.info(result, 'payment reconciliation');
        }).catch((error) => log.warn({ err: (error as Error).message }, 'payment reconciliation failed'));
      }, 5 * 60_000),
    );
    for (const timer of timers) timer.unref();

    live = app;
    boot.phase = 'ready';

    log.info({
      migrations,
      pausedGames: paused,
      settlementRecovery,
      engineHealth,
      mode: ctx.compliance.testMode ? 'test' : ctx.compliance.realMoneyEnabled ? 'real' : 'free',
      email: { configured: emailStatus.configured, provider: emailStatus.provider, host: emailStatus.host, from: emailStatus.from },
      database: db.driver,
      publicOrigin: env.publicOrigin,
      publicOriginSource: env.publicOriginSource,
      cwd: env.root,
      readyMs: Date.now() - bootStartedAt,
    }, 'HTTP and WebSocket server ready');
  } catch (error) {
    if (error instanceof ConfigurationError) {
      boot.phase = 'error';
      boot.problems = error.problems;
      printConfigurationFailure(error.problems);
      log.error({ problems: error.problems }, 'production configuration is incomplete; refusing all requests');
      // Stay alive so the platform reports a health-check failure with this
      // message. Exiting here would restart-loop and hide the real cause.
      return;
    }
    // Infrastructure failures (database unreachable, migration error, engine
    // bootstrap) are often transient, so exit and let the platform restart the
    // service. Only configuration errors stay alive, because restarting cannot
    // fix a missing secret and would hide the explanation in a crash loop.
    console.error('');
    console.error('Rookstone Arena failed during startup:', error);
    console.error('');
    log.error({ err: (error as Error).message }, 'startup failed');
    await new Promise<void>((resolve) => {
      const closing = server.close(() => resolve());
      server.closeIdleConnections?.();
      setTimeout(resolve, 2_000).unref();
      void closing;
    });
    process.exit(1);
  }
}

main().catch((error) => {
  if (error instanceof ConfigurationError) {
    printConfigurationFailure(error.problems);
  } else {
    console.error('Failed to start Rookstone Arena:', error);
  }
  process.exit(1);
});
