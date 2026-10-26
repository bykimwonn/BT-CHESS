/* Deployment entrypoint check.
 *
 * Hosting providers may keep an older dashboard start command of `node server.js`
 * even when the repository start command changes. This test runs that exact stale
 * command in production mode, with an embedded database in a temp directory, and
 * proves the compatibility entrypoint boots the compiled server and answers the
 * platform health check. It also proves the entrypoint fails loudly, not silently,
 * when the build is missing and automatic building is disabled.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.dirname(import.meta.dirname);
const port = 4600 + Math.floor(Math.random() * 300);
const origin = `http://127.0.0.1:${port}`;
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'rookstone-deploy-'));

function env(extra = {}) {
  return {
    ...process.env,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(port),
    SESSION_SECRET: 'deploy-entrypoint-test-secret-0123456789abcdef',
    PUBLIC_ORIGIN: origin,
    CORS_ORIGINS: origin,
    TRUST_PROXY: '0',
    OPERATING_MODE: 'free',
    ALLOW_EMBEDDED_DB: 'true',
    PGLITE_DIR: path.join(dataDir, 'pglite'),
    LOG_LEVEL: 'warn',
    ENGINE_ENABLED: 'false',
    ROOKSTONE_SKIP_AUTO_BUILD: 'true',
    ...extra,
  };
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`process did not exit within ${timeoutMs} ms`));
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return response.json();
      lastError = new Error(`health returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`health check never became ready: ${lastError?.message}`);
}

// 1. The stale provider command must boot the compiled server.
assert.ok(existsSync(path.join(root, 'dist-server', 'server', 'index.js')), 'run `npm run build:server` first');

const server = spawn(process.execPath, ['server.js'], { cwd: root, env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (chunk) => { serverLog += chunk; });
server.stderr.on('data', (chunk) => { serverLog += chunk; });

let health;
try {
  health = await waitForHealth(45_000);
} catch (error) {
  server.kill('SIGKILL');
  throw new Error(`${error.message}\nserver output:\n${serverLog}`);
}
assert.equal(health.status, 'ok', 'health endpoint should report ok');
assert.ok(typeof health.database === 'string' && health.database.length > 0, 'health endpoint should report the database driver');
assert.match(serverLog, /Starting compiled server/, 'entrypoint should log which compiled server it launched');

// A client-side route must also be served (or at least the API must remain healthy
// when the web build is intentionally absent from the build:server test path).
const missingAsset = await fetch(`${origin}/api/does-not-exist`);
assert.equal(missingAsset.status, 404, 'unknown API routes should 404 rather than crash the entrypoint');

server.kill('SIGTERM');
const shutdown = await waitForExit(server, 20_000);
assert.ok(shutdown.code === 0 || shutdown.signal === 'SIGTERM', `expected clean shutdown, got code ${shutdown.code} signal ${shutdown.signal}`);

// 2. Missing build + disabled auto-build must fail with actionable guidance.
const shimSource = readFileSync(path.join(root, 'server.js'), 'utf8');
const emptyDir = mkdtempSync(path.join(os.tmpdir(), 'rookstone-empty-'));
const { writeFileSync } = await import('node:fs');
writeFileSync(path.join(emptyDir, 'server.js'), shimSource);

const broken = spawn(process.execPath, ['server.js'], {
  cwd: emptyDir,
  env: env({ PORT: String(port + 1), PGLITE_DIR: path.join(emptyDir, 'pglite') }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let brokenLog = '';
broken.stdout.on('data', (chunk) => { brokenLog += chunk; });
broken.stderr.on('data', (chunk) => { brokenLog += chunk; });
const brokenExit = await waitForExit(broken, 20_000);
assert.equal(brokenExit.code, 1, 'missing build should exit non-zero');
assert.match(brokenLog, /could not start/i);
assert.match(brokenLog, /npm run build/);
assert.match(brokenLog, /Start command: npm start/);

// 3. Production misconfiguration must report every missing setting, not one at a time.
const misconfigured = { ...env() };
delete misconfigured.SESSION_SECRET;
delete misconfigured.DATABASE_URL;
misconfigured.ALLOW_EMBEDDED_DB = 'false';
misconfigured.PGLITE_DIR = path.join(dataDir, 'unused');

const blocked = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: misconfigured,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let blockedLog = '';
blocked.stdout.on('data', (chunk) => { blockedLog += chunk; });
blocked.stderr.on('data', (chunk) => { blockedLog += chunk; });
const blockedExit = await waitForExit(blocked, 20_000);
assert.equal(blockedExit.code, 1, 'incomplete production configuration must fail closed');
assert.match(blockedLog, /cannot start because its production configuration is incomplete/i);
assert.match(blockedLog, /SESSION_SECRET must be set to at least 32/);
assert.match(blockedLog, /DATABASE_URL must point at PostgreSQL/);
assert.doesNotMatch(blockedLog, /Testing|127\.0\.0\.1:\d+\/api\/health/, 'must not report healthy when misconfigured');

// 4. Configuration must stay aligned with the verified runtime.
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.match(pkg.scripts.start, /dist-server\/server\/index\.js/);
assert.equal(pkg.engines.node, '>=22.12.0 <23', 'Node range must exclude unverified major versions');
assert.ok(existsSync(path.join(root, '.node-version')), '.node-version should pin the verified runtime');

const renderYaml = readFileSync(path.join(root, 'render.yaml'), 'utf8');
assert.match(renderYaml, /NODE_VERSION[\s\S]{0,40}22\.22\.3/, 'render.yaml should pin Node');
assert.match(renderYaml, /startCommand: npm start/);
assert.match(renderYaml, /healthCheckPath: \/api\/health/);

console.log('deploy entrypoint checks passed');
console.log(`  stale command \`node server.js\` served /api/health (driver: ${health.database})`);
console.log('  clean SIGTERM shutdown');
console.log('  missing build fails with actionable startup guidance');
console.log('  missing SESSION_SECRET/DATABASE_URL fail closed with all problems listed');
console.log('  Node runtime and Render start command pinned');
process.exit(0);
