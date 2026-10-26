# Chess piece artwork

The piece sets in this directory are third-party artwork, vendored unchanged so
the app never fetches art from a CDN at runtime. **None of it is covered by this
project's MIT licence**; each set keeps its own licence and attribution.

| Folder | Set | Author | Licence | Source |
| --- | --- | --- | --- | --- |
| `/pieces` (root) | cburnett / Classic Staunton | Colin M. L. Burnett | GPL-2.0-or-later | [lichess-org/lila](https://github.com/lichess-org/lila/tree/master/public/piece/cburnett) (originals on Wikimedia Commons as `Chess_*t45.svg`) |
| `/pieces/merida` | Merida | Armando Hernandez Marroquin | GPL-2.0-or-later | [lichess-org/lila](https://github.com/lichess-org/lila/tree/master/public/piece/merida) |
| `/pieces/chessnut` | Chessnut | Alexis Luengas | Apache-2.0 | [chessnut-pieces](https://github.com/LexLuengas/chessnut-pieces) via [lila](https://github.com/lichess-org/lila/tree/master/public/piece/chessnut) |
| `/pieces/celtic` | Celtic | Maurizio Monge | MIT | [maurimo/chess-art](https://github.com/maurimo/chess-art) via [lila](https://github.com/lichess-org/lila/tree/master/public/piece/celtic) |

The per-set licences that matter for redistribution are reproduced or linked in
`docs/THIRD_PARTY_LICENSES.md`. In short:

- **GPL-2.0-or-later** (cburnett, merida): redistributing a build that contains
  these files means offering the corresponding source and keeping the licence
  notice. The application already ships GPL-3.0 Stockfish, so the project as a
  whole is distributed with GPL components and the notices in
  `docs/licenses/`.
- **Apache-2.0** (chessnut): keep this notice and the licence text.
- **MIT** (celtic): keep the copyright notice and the permission notice.

The default `react-chessboard` vector set needs no files here; it is MIT and is
listed in `docs/THIRD_PARTY_LICENSES.md`.

Each set is the twelve files `wK wQ wR wB wN wP bK bQ bR bB bN bP`.svg`.
