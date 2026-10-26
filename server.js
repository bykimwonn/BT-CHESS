#!/usr/bin/env node
/**
 * Compatibility entrypoint for hosting providers whose dashboard still runs
 * `node server.js` (for example an older Render start command).
 *
 * The application entrypoint is the compiled ESM server at
 * `dist-server/server/index.js`, produced by `npm run build`. This shim does not
 * contain application logic: it locates the compiled server, builds it once when
 * build artifacts are missing, then imports it in this process so platform
 * health checks, signals and logs continue to work normally.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(root, 'dist-server', 'server', 'index.js');
const webIndex = path.join(root, 'dist', 'web', 'index.html');

function fail(message) {
  console.error('');
  console.error('Rookstone Arena could not start.');
  console.error(message);
  console.error('');
  console.error('Recommended hosting settings:');
  console.error('  Build command: npm ci --include=dev && npm run build');
  console.error('  Start command: npm start');
  console.error('  Node version:  22.x (verified on 22.22.3)');
  console.error('');
  process.exit(1);
}

function buildOnce() {
  if (process.env.ROOKSTONE_SKIP_AUTO_BUILD === 'true') {
    fail('Compiled server is missing and ROOKSTONE_SKIP_AUTO_BUILD=true.\nRun `npm run build` in the build step.');
  }
  console.warn('[rookstone] Compiled server is missing; running `npm run build` once before startup.');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['run', 'build'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env },
  });
  if (result.error) {
    fail(`Could not run the build command: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`Build failed with exit code ${result.status ?? 'unknown'}.\nEnsure devDependencies are installed (npm ci --include=dev) and Node.js 22 is selected.`);
  }
}

if (!existsSync(entry)) {
  buildOnce();
}

if (!existsSync(entry)) {
  fail(`Compiled server was not produced at ${entry}.`);
}

if (!existsSync(webIndex)) {
  console.warn('[rookstone] dist/web/index.html is missing; API and WebSocket routes will start, but the browser UI will not be served until `npm run build` completes.');
}

console.info('[rookstone] Starting compiled server from dist-server/server/index.js');
await import(pathToFileURL(entry).href);
