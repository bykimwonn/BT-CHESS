# Third-party licences and attribution

## Stockfish 19 Lite WASM

- Package: `stockfish@19.0.1` from npm.
- WASM port: [nmrugg/stockfish.js](https://github.com/nmrugg/stockfish.js).
- Upstream engine: [official-stockfish/Stockfish](https://github.com/official-stockfish/Stockfish).
- Licence: **GPL-3.0-or-later**.
- Exact vendored files: `web/public/engine/stockfish-19-lite-single.js`, `web/public/engine/stockfish-19-lite-single.wasm`, `web/public/engine/manifest.json`.
- Full licence text: `docs/licenses/stockfish-GPL-3.0.txt` (copied from the npm package's `Copying.txt`).
- Engine file header includes the GPLv3 notice and upstream links.
- `npm run vendor:engine` copies the exact distribution from `node_modules/stockfish` into `web/public/engine`.

GPL obligations: if you distribute the browser bundle or container image containing the Stockfish WASM engine, provide the corresponding source and licence notices as required by GPL-3.0. The upstream engine repository and the WASM port repository are linked above. Do not relicense the engine as MIT; the MIT notice for original application code does not cover GPL third-party files.

## Chess piece SVGs

`web/public/pieces/*.svg` are the **Colin M. L. Burnett** chess set (the set used by Lichess and visually the familiar "chess.com" Staunton look), vendored unchanged into the repository so the application never fetches art from a CDN at runtime.

- Author: Colin M. L. Burnett.
- Source: [lichess-org/lila `public/piece/cburnett`](https://github.com/lichess-org/lila/tree/master/public/piece/cburnett) (mirrors Wikimedia Commons `Chess_*t45.svg`).
- Licence: triple-licensed **GPL-2.0-or-later / BSD-3-Clause / CC-BY-SA-3.0**. This project uses the **BSD-3-Clause** option; the artwork itself is not relicensed as MIT.
- Attribution and per-file notes: `web/public/pieces/ATTRIBUTION.md`.
- The alternative vector set is the default provided by the MIT-licensed `react-chessboard` package.

## Other dependencies

Dependencies are pinned in `package.json`; consult each package's `LICENSE` file for its terms. Key runtime dependencies include React, Express, Socket.IO, `chess.js`, `react-chessboard`, PGlite, `pg`, Argon2, Zod, Pino, helmet, express-rate-limit, TanStack Query and nodemailer. Test-only dependencies include Vitest, Testing Library, jsdom, Playwright Core and `@sparticuz/chromium`.

## Payment documentation

Provider documentation links are listed in [PAYMENTS.md](PAYMENTS.md). No provider SDK, endpoint, logo or trademark is bundled beyond what the official documentation requires for integration. Provider names remain the property of their respective owners.
