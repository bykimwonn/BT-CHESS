import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { Server as SocketServer } from 'socket.io';
import { env, assertProductionSafety } from './config/env.js';
import { openDatabase } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { createContext } from './services/context.js';
import { createLogger } from './services/logger.js';
import { RealtimeService } from './games/realtime.js';
import { createApiRouter, apiErrorHandler } from './http/routes.js';
import { corsOptions, socketOriginCallback } from './http/origins.js';

async function main(): Promise<void> {
  assertProductionSafety();
  const log = createLogger();
  const db = await openDatabase();
  const migrations = await runMigrations(db);
  const ctx = createContext(db, log);

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

  const server = http.createServer(app);
  const io = new SocketServer(server, {
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
  log.info({
    migrations, pausedGames: paused, settlementRecovery, engineHealth,
    mode: ctx.compliance.testMode ? 'test' : ctx.compliance.realMoneyEnabled ? 'real' : 'free',
    database: db.driver,
  }, 'Rookstone Arena started');

  let tickRunning = false;
  const tick = async () => {
    if (tickRunning) return;
    tickRunning = true;
    try {
      const events = await ctx.games.checkTimeouts();
      await realtime.publishEvents(events);
      const abandoned = await ctx.games.checkAbandonment();
      await realtime.publishEvents(abandoned);
    } catch (error) {
      log.warn({ err: (error as Error).message }, 'game maintenance tick failed');
    } finally { tickRunning = false; }
  };
  const clockTimer = setInterval(() => { void tick(); }, 1_000);
  const cleanupTimer = setInterval(() => {
    void Promise.all([ctx.competition.expireChallenges(), ctx.competition.cleanupTickets()])
      .catch((error) => log.warn({ err: (error as Error).message }, 'lobby cleanup failed'));
  }, 30_000);
  const settlementTimer = setInterval(() => {
    void ctx.settlement.settlePending().then((result) => {
      if (result.posted || result.failed.length) log.info(result, 'settlement recovery');
    }).catch((error) => log.warn({ err: (error as Error).message }, 'settlement recovery failed'));
  }, 60_000);
  const paymentTimer = setInterval(() => {
    void ctx.payments.reconcilePending().then((result) => {
      if (result.changed || result.errors.length) log.info(result, 'payment reconciliation');
    }).catch((error) => log.warn({ err: (error as Error).message }, 'payment reconciliation failed'));
  }, 5 * 60_000);
  for (const timer of [clockTimer, cleanupTimer, settlementTimer, paymentTimer]) timer.unref();

  await new Promise<void>((resolve) => server.listen(env.port, env.host, () => resolve()));
  log.info({ port: env.port, host: env.host, publicOrigin: env.publicOrigin }, 'HTTP and WebSocket server listening');

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'graceful shutdown started');
    clearInterval(clockTimer); clearInterval(cleanupTimer);
    clearInterval(settlementTimer); clearInterval(paymentTimer);
    const force = setTimeout(() => process.exit(1), 12_000);
    force.unref();
    try {
      await ctx.games.pauseAllClocks();
      await new Promise<void>((resolve) => io.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
      log.info('graceful shutdown complete');
      process.exit(0);
    } catch (error) {
      log.error({ err: (error as Error).message }, 'graceful shutdown failed');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
}

main().catch((error) => {
  console.error('Failed to start Rookstone Arena:', error);
  process.exit(1);
});
