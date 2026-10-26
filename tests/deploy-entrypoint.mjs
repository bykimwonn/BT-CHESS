/* Deployment entrypoint and startup-order checks.
 *
 * Providers fail a deploy when nothing binds a port quickly ("No open ports
 * detected"), and they keep a stale dashboard start command such as
 * `node server.js`. These checks run the real production entrypoints and prove:
 *   1. the port is bound in milliseconds, before migrations and engine checks;
 *   2. the legacy `node server.js` command reaches the compiled server;
 *   3. health is 200 only when the service is genuinely ready to serve;
 *   4. incomplete configuration keeps the port bound and reports every problem
 *      over /api/health instead of crash-looping;
 *   5. a missing build fails immediately with actionable guidance (no runtime
 *      build that would blow the port-scan window);
 *   6. the runtime and start command stay pinned.
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.dirname(import.meta.dirname);
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'rookstone-deploy-'));
const results = [];

let nextPort = 4700 + Math.floor(Math.random() * 200);
const takePort = () => nextPort++;

function baseEnv(port, extra = {}) {
  return {
    ...process.env,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(port),
    SESSION_SECRET: 'deploy-entrypoint-test-secret-0123456789abcdef',
    PUBLIC_ORIGIN: `https://chess.test`,
    CORS_ORIGINS: `https://chess.test`,
    TRUST_PROXY: '0',
    OPERATING_MODE: 'free',
    ALLOW_EMBEDDED_DB: 'true',
    PGLITE_DIR: path.join(dataDir, `pglite-${port}`),
    LOG_LEVEL: 'info',
    ENGINE_ENABLED: 'false',
    ...extra,
  };
}

function start(command, args, env, cwd = root) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.log = '';
  child.stdout.on('data', (chunk) => { child.log += chunk; });
  child.stderr.on('data', (chunk) => { child.log += chunk; });
  return child;
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`process did not exit within ${timeoutMs} ms\n${child.log}`));
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

/** Time from spawn until the process accepts a TCP connection on `port`. */
async function waitForPort(port, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const open = await new Promise((resolve) => {
      const socket = net.connect({ port, host: '127.0.0.1' });
      socket.setTimeout(400);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('timeout', () => { socket.destroy(); resolve(false); });
      socket.once('error', () => { socket.destroy(); resolve(false); });
    });
    if (open) return Date.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`port ${port} never opened within ${timeoutMs} ms`);
}

async function getJson(url) {
  const response = await fetch(url);
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function waitForReady(port, timeoutMs = 45_000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const health = await getJson(`http://127.0.0.1:${port}/api/health`);
      if (health.status === 200) return { ...health, readyMs: Date.now() - started };
      last = health;
    } catch (error) {
      last = { status: 0, body: { error: error.message } };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`service never became ready (last: ${JSON.stringify(last)})`);
}

async function stop(child) {
  child.kill('SIGTERM');
  return waitForExit(child, 20_000);
}

// ---------------------------------------------------------------------------
// 1. The legacy provider command must work and must bind the port immediately.
// ---------------------------------------------------------------------------
assert.ok(existsSync(path.join(root, 'dist-server', 'server', 'index.js')), 'run `npm run build:server` first');

const portA = takePort();
const server = start(process.execPath, ['server.js'], baseEnv(portA));
try {
  const portOpenMs = await waitForPort(portA);
  const health = await waitForReady(portA);
  results.push(`port bound in ${portOpenMs} ms (Render allows 60 s), ready in ${health.readyMs} ms`);
  assert.ok(portOpenMs < 20_000, `port must bind well inside the platform scan window, took ${portOpenMs} ms`);
  assert.equal(health.body.status, 'ok');
  assert.equal(health.body.database, 'pglite');
  assert.match(server.log, /Starting compiled server/, 'entrypoint should report which compiled server it launched');
  assert.match(server.log, /port bound; initializing/, 'port should be bound before initialization work');

  const missing = await fetch(`http://127.0.0.1:${portA}/api/does-not-exist`);
  assert.equal(missing.status, 404, 'unknown API routes should 404, not crash the process');

  const shutdown = await stop(server);
  assert.ok(shutdown.code === 0 || shutdown.signal === 'SIGTERM', `expected clean shutdown, got code ${shutdown.code}`);
  results.push('legacy `node server.js` served /api/health 200, unknown API route 404, clean SIGTERM shutdown');

  // -------------------------------------------------------------------------
  // 2. Incomplete configuration: port stays bound, every problem is reported.
  // -------------------------------------------------------------------------
  const portB = takePort();
  const brokenEnv = baseEnv(portB);
  delete brokenEnv.SESSION_SECRET;
  delete brokenEnv.PUBLIC_ORIGIN;
  delete brokenEnv.CORS_ORIGINS;
  brokenEnv.ALLOW_EMBEDDED_DB = 'false';
  brokenEnv.PGLITE_DIR = path.join(dataDir, 'unused');
  const misconfigured = start(process.execPath, ['server.js'], brokenEnv);
  try {
    const portOpenMs = await waitForPort(portB);
    const deadline = Date.now() + 30_000;
    let health = null;
    while (Date.now() < deadline) {
      health = await getJson(`http://127.0.0.1:${portB}/api/health`);
      if (health.status === 503 && Array.isArray(health.body?.problems) && health.body.problems.length) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    assert.equal(health.status, 503, 'incomplete configuration must fail health checks');
    const problems = health.body.problems.join('\n');
    assert.match(problems, /SESSION_SECRET must be set to at least 32/);
    assert.match(problems, /DATABASE_URL must point at PostgreSQL/);
    assert.match(problems, /PUBLIC_ORIGIN must be the exact HTTPS origin/);
    assert.match(misconfigured.log, /production configuration is incomplete/i);

    // It must not crash-loop: still answering after several seconds.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const again = await getJson(`http://127.0.0.1:${portB}/api/health`);
    assert.equal(again.status, 503);
    assert.equal(misconfigured.exitCode, null, 'process must stay up to report the problem');

    const shutdownB = await stop(misconfigured);
    assert.ok(shutdownB.code === 0 || shutdownB.signal === 'SIGTERM', `expected clean shutdown, got code ${shutdownB.code}`);
    results.push(`misconfiguration kept port bound (${portOpenMs} ms) and reported 3 problems over /api/health 503`);
  } finally {
    if (misconfigured.exitCode === null) misconfigured.kill('SIGKILL');
  }

  // -------------------------------------------------------------------------
  // 2b. Render injects RENDER_EXTERNAL_URL, so PUBLIC_ORIGIN/CORS_ORIGINS are
  //     optional there; only the secret and database remain operator-supplied.
  // -------------------------------------------------------------------------
  const portC = takePort();
  const renderEnv = baseEnv(portC, {
    RENDER_EXTERNAL_URL: 'https://rookstone-arena.onrender.com',
    RENDER_EXTERNAL_HOSTNAME: 'rookstone-arena.onrender.com',
  });
  delete renderEnv.PUBLIC_ORIGIN;
  delete renderEnv.CORS_ORIGINS;
  const onRender = start(process.execPath, ['server.js'], renderEnv);
  try {
    const portOpenMs = await waitForPort(portC);
    const ready = await waitForReady(portC);
    assert.equal(ready.body.status, 'ok');
    assert.match(onRender.log, /"publicOriginSource":"platform"/, 'origin should be derived from the platform URL');
    assert.match(onRender.log, /"publicOrigin":"https:\/\/rookstone-arena\.onrender\.com"/);
    results.push(`platform origin derived from RENDER_EXTERNAL_URL (port ${portOpenMs} ms, ready ${ready.readyMs} ms)`);
    await stop(onRender);
  } finally {
    if (onRender.exitCode === null) onRender.kill('SIGKILL');
  }

  // -------------------------------------------------------------------------
  // 3. Missing build fails immediately, without a runtime build.
  // -------------------------------------------------------------------------
  const emptyDir = mkdtempSync(path.join(os.tmpdir(), 'rookstone-empty-'));
  writeFileSync(path.join(emptyDir, 'server.js'), readFileSync(path.join(root, 'server.js')));
  const noBuild = start(process.execPath, ['server.js'], baseEnv(takePort()), emptyDir);
  const noBuildExit = await waitForExit(noBuild, 20_000);
  assert.equal(noBuildExit.code, 1, 'missing build should exit non-zero');
  assert.match(noBuild.log, /compiled server is missing/i);
  assert.match(noBuild.log, /npm ci --include=dev && npm run build/);
  assert.match(noBuild.log, /intentionally does not build at runtime/i);
  assert.doesNotMatch(noBuild.log, /> rookstone-arena@1\.0\.0 build/, 'must not start a build during the start phase');
  results.push('missing build exits 1 with build/start/Node guidance and performs no runtime build');

  // -------------------------------------------------------------------------
  // 3b. Infrastructure failures (here: an unreachable PostgreSQL) must exit so
  //     the platform restarts the service, unlike deterministic config errors.
  // -------------------------------------------------------------------------
  const portD = takePort();
  const unreachable = start(process.execPath, ['server.js'], baseEnv(portD, {
    ALLOW_EMBEDDED_DB: 'false',
    DATABASE_URL: 'postgresql://rookstone:secret@127.0.0.1:1/rookstone?sslmode=disable',
    DB_POOL_SIZE: '1',
  }));
  const unreachableExit = await waitForExit(unreachable, 60_000);
  assert.equal(unreachableExit.code, 1, 'infrastructure failure must exit non-zero for a platform restart');
  assert.match(unreachable.log, /failed during startup/i);
  results.push('unreachable database exits 1 (platform restart) instead of holding a dead port');

  // -------------------------------------------------------------------------
  // 4. Runtime and start command stay pinned to what was verified.
  // -------------------------------------------------------------------------
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.start, /dist-server\/server\/index\.js/);
  assert.equal(pkg.engines.node, '>=22.12.0 <23', 'Node range must exclude unverified major versions');
  assert.equal(readFileSync(path.join(root, '.node-version'), 'utf8').trim(), '22.22.3');

  const renderYaml = readFileSync(path.join(root, 'render.yaml'), 'utf8');
  assert.match(renderYaml, /NODE_VERSION[\s\S]{0,40}22\.22\.3/, 'render.yaml should pin Node');
  assert.match(renderYaml, /startCommand: npm start/);
  assert.match(renderYaml, /healthCheckPath: \/api\/health/);
  assert.match(renderYaml, /buildCommand: npm ci --include=dev && npm run build/);
  results.push('Node 22.22.3, build command, start command and health path pinned');

  console.log('deploy entrypoint checks passed');
  for (const line of results) console.log(`  - ${line}`);
  process.exit(0);
} catch (error) {
  console.error(error);
  console.error(`--- server log ---\n${server?.log ?? ''}`);
  server?.kill('SIGKILL');
  process.exit(1);
}
