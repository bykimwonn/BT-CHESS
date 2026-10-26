#!/usr/bin/env node
/**
 * Produces the deployable build during dependency installation.
 *
 * Platforms are unreliable about the build command: Render can keep its default
 * `npm install`, which installs dependencies, runs `postinstall`, and then starts
 * the service with no compilation step at all — the deploy "succeeds" and the
 * process dies with `Cannot find module dist-server/server/index.js`. Compiling
 * here, inside the install phase, removes that dependency on dashboard settings.
 *
 * Guarantees:
 *   - never fails an install it cannot satisfy (missing toolchain or sources are
 *     reported, not thrown), so `npm ci --omit=dev` still works;
 *   - idempotent: existing artifacts are left alone unless forced;
 *   - opt out with ROOKSTONE_SKIP_BUILD=1.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'dist-server', 'server', 'index.js');
const webIndex = path.join(root, 'dist', 'web', 'index.html');
const log = (message) => console.log(`[rookstone] ${message}`);

if (process.env.ROOKSTONE_SKIP_BUILD === '1') {
  log('Skipping automatic build (ROOKSTONE_SKIP_BUILD=1).');
  process.exit(0);
}

// Docker's dependency layer copies only package.json and scripts before
// `npm ci`, so there is nothing to compile yet; the image builds afterwards.
if (!existsSync(path.join(root, 'server', 'index.ts'))) {
  log('Application sources are not present yet; skipping automatic build.');
  process.exit(0);
}

if (existsSync(entry) && existsSync(webIndex) && process.env.ROOKSTONE_FORCE_BUILD !== '1') {
  log('Build artifacts are already present; skipping automatic build.');
  process.exit(0);
}

const hasToolchain = existsSync(path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'))
  && existsSync(path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'));

if (!hasToolchain) {
  console.warn('[rookstone] Build tools (typescript, vite) are not installed, so the');
  console.warn('[rookstone] application could not be compiled during install.');
  console.warn('[rookstone] Install devDependencies and build explicitly:');
  console.warn('[rookstone]   npm ci --include=dev && npm run build');
  process.exit(0);
}

log('Compiling the application during install (npm run build).');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npm, ['run', 'build'], { cwd: root, stdio: 'inherit', env: process.env });

if (result.error) {
  console.error(`[rookstone] Automatic build could not run: ${result.error.message}`);
  process.exit(0);
}
if (result.status !== 0) {
  // A genuine compile error must fail the build: deploying code that does not
  // compile would only move the failure to production.
  console.error(`[rookstone] Automatic build failed with exit code ${result.status}.`);
  process.exit(result.status ?? 1);
}
if (!existsSync(entry)) {
  console.error('[rookstone] The build finished but dist-server/server/index.js is missing.');
  process.exit(1);
}
log('Automatic build complete.');
