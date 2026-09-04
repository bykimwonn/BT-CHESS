#!/usr/bin/env node
/**
 * Copies browser-facing assets out of node_modules into public/.
 *
 *   chess.js        -> public/vendor/chess.js   (ESM build, loaded as a module script
 *                                                so the app has no CDN dependency)
 *   Lichess engine  -> public/engine/*          (Stockfish 18 wasm + glue, served to
 *                                                browser workers)
 *
 * Runs automatically on `npm install` (postinstall). Safe to re-run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

function copy(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return true;
}

const report = [];

// 1. chess.js (browser ESM build)
const chessEsm = path.join(ROOT, 'node_modules/chess.js/dist/esm/chess.js');
const chessDest = path.join(PUBLIC, 'vendor/chess.js');
if (copy(chessEsm, chessDest)) {
  report.push(`chess.js  -> public/vendor/chess.js (${(fs.statSync(chessDest).size / 1024).toFixed(0)} KB)`);
} else {
  report.push('chess.js  -> NOT FOUND (run npm install)');
}

// 2. Lichess Stockfish wasm builds
const ENGINE_DIR = path.join(ROOT, 'node_modules/@lichess-org/stockfish-web');
// Only ship the builds the app can actually use. The big-net builds need a
// separate NNUE download, the smallnet builds embed their net in the wasm.
const ENGINE_FILES = [
  'sf_18_smallnet.js',
  'sf_18_smallnet.wasm',
  'sf_18_smallnet_relaxed-simd.js',
  'sf_18_smallnet_relaxed-simd.wasm',
];
let copied = 0;
for (const file of ENGINE_FILES) {
  if (copy(path.join(ENGINE_DIR, file), path.join(PUBLIC, 'engine', file))) copied++;
}
report.push(
  copied
    ? `stockfish -> public/engine/ (${copied} files, ${(
        fs
          .readdirSync(path.join(PUBLIC, 'engine'))
          .reduce((sum, f) => sum + fs.statSync(path.join(PUBLIC, 'engine', f)).size, 0) /
        1024
      ).toFixed(0)} KB)`
    : 'stockfish -> NOT FOUND (run npm install)'
);

// 3. Generated SVG chess piece set -> public/pieces/
try {
  const { execFileSync } = await import('node:child_process');
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-pieces.mjs')], { stdio: 'inherit' });
} catch (e) {
  report.push('pieces   -> skipped (' + e.message + ')');
}

console.log('[vendor] ' + report.join('\n[vendor] '));
