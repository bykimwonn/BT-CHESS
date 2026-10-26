#!/usr/bin/env node
/**
 * Compatibility entrypoint for hosting providers whose dashboard still runs
 * `node server.js` (for example an older Render start command).
 *
 * The real entrypoint is the compiled ESM server at `dist-server/server/index.js`,
 * produced by `npm run build`. This shim deliberately contains no application
 * logic and performs no build: building during the start phase takes minutes and
 * makes platform port scanners fail the deploy ("No open ports detected") before
 * the server can bind. Compilation belongs in the build step.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(root, 'dist-server', 'server', 'index.js');

if (!existsSync(entry)) {
  console.error('');
  console.error('Rookstone Arena cannot start: the compiled server is missing.');
  console.error(`Expected ${entry}`);
  console.error('');
  console.error('The build step must run before the start step:');
  console.error('  Build command: npm ci --include=dev && npm run build');
  console.error('  Start command: npm start   (this file, `node server.js`, also works)');
  console.error('  Node version:  22.x (verified on 22.22.3)');
  console.error('');
  console.error('This entrypoint intentionally does not build at runtime: a build during the');
  console.error('start phase exceeds platform port-scan timeouts. See docs/DEPLOYMENT.md.');
  console.error('');
  process.exit(1);
}

console.info('[rookstone] Starting compiled server from dist-server/server/index.js');
await import(pathToFileURL(entry).href);
