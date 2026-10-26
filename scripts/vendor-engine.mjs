/**
 * Copy the exact GPL-3.0 Stockfish.js 19 lite-single WASM distribution used by
 * both the browser worker and the Node analysis service into web/public/engine.
 * Source: https://github.com/official-stockfish/Stockfish (engine)
 * Port:   https://github.com/nmrugg/stockfish.js (WASM build)
 * npm:    stockfish@19.0.1, licence GPL-3.0 (Copying.txt)
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const packageRoot = path.dirname(require.resolve('stockfish/package.json'));
const source = path.join(packageRoot, 'bin');
const target = path.join(root, 'web', 'public', 'engine');
const licenseDir = path.join(root, 'docs', 'licenses');

fs.mkdirSync(target, { recursive: true });
fs.mkdirSync(licenseDir, { recursive: true });
for (const name of ['stockfish-19-lite-single.js', 'stockfish-19-lite-single.wasm']) {
  const from = path.join(source, name);
  if (!fs.existsSync(from)) throw new Error(`Missing Stockfish distribution file: ${from}`);
  fs.copyFileSync(from, path.join(target, name));
}
const copying = path.join(packageRoot, 'Copying.txt');
if (!fs.existsSync(copying)) throw new Error('Missing GPL-3.0 Copying.txt from stockfish package');
fs.copyFileSync(copying, path.join(licenseDir, 'stockfish-GPL-3.0.txt'));
const meta = {
  engine: 'Stockfish 19 Lite WASM',
  distribution: 'stockfish npm package 19.0.1 (nmrugg/stockfish.js)',
  upstream: 'https://github.com/official-stockfish/Stockfish',
  port: 'https://github.com/nmrugg/stockfish.js',
  licence: 'GPL-3.0-or-later',
  files: ['stockfish-19-lite-single.js', 'stockfish-19-lite-single.wasm'],
  verifiedBy: 'UCI handshake: id name Stockfish 19 Lite WASM / uciok / readyok',
};
fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(meta, null, 2) + '\n');
console.log(`Vendored ${meta.engine} (${meta.licence}) to ${target}`);
