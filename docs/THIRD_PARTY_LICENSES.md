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

`web/public/pieces` contains four vendored piece sets. None of them is covered by this project's MIT licence.

| Folder | Set | Author | Licence used here | Source |
| --- | --- | --- | --- | --- |
| `web/public/pieces/*.svg` | cburnett / "Classic Staunton" (default) | Colin M. L. Burnett | GPL-2.0-or-later (author also offers BSD-3-Clause / CC-BY-SA-3.0) | [lichess-org/lila `cburnett`](https://github.com/lichess-org/lila/tree/master/public/piece/cburnett), originals on Wikimedia Commons as `Chess_*t45.svg` |
| `web/public/pieces/merida` | Merida | Armando Hernandez Marroquin | GPL-2.0-or-later | [lila `merida`](https://github.com/lichess-org/lila/tree/master/public/piece/merida) |
| `web/public/pieces/chessnut` | Chessnut | Alexis Luengas | Apache-2.0 | [LexLuengas/chessnut-pieces](https://github.com/LexLuengas/chessnut-pieces) via [lila](https://github.com/lichess-org/lila/tree/master/public/piece/chessnut) |
| `web/public/pieces/celtic` | Celtic | Maurizio Monge | MIT | [maurimo/chess-art](https://github.com/maurimo/chess-art) via [lila](https://github.com/lichess-org/lila/tree/master/public/piece/celtic) |

- Attribution and per-file notes: `web/public/pieces/ATTRIBUTION.md`.
- The default set is distributed here under **GPL-2.0-or-later**, the licence the upstream Lichess tree states for it. The author's original upload also offers BSD-3-Clause and CC-BY-SA-3.0; whichever option an operator relies on, `web/public/pieces/ATTRIBUTION.md` must stay in the build and be reachable from the app.
- The **Merida** set is GPL-2.0-or-later. This application already distributes GPL-3.0 Stockfish, so the build is a mixed-licence distribution and the GPL notices under `docs/licenses/` apply to those files too. Removing the folder just removes that set from the picker; the rest of the app stays MIT.
- The **Chessnut** set is Apache-2.0 and the **Celtic** set is MIT; both require keeping the copyright and permission notices, which are in `ATTRIBUTION.md` and this file.
- The alternative vector set (`Vector outline` in the picker) is the MIT-licensed default from `react-chessboard` and ships no image files.

## Other dependencies

Dependencies are pinned in `package.json`; consult each package's `LICENSE` file for its terms. Key runtime dependencies include React, Express, Socket.IO, `chess.js`, `react-chessboard`, PGlite, `pg`, Argon2, Zod, Pino, helmet, express-rate-limit, TanStack Query and nodemailer. Test-only dependencies include Vitest, Testing Library, jsdom, Playwright Core and `@sparticuz/chromium`.

## Payment documentation

Provider documentation links are listed in [PAYMENTS.md](PAYMENTS.md). No provider SDK, endpoint, logo or trademark is bundled beyond what the official documentation requires for integration. Provider names remain the property of their respective owners.
