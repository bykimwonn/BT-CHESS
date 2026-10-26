import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { defaultPieces } from 'react-chessboard';
import { ChessBoard } from '../features/chess/ChessBoard';
import {
  BOARD_THEMES, PIECE_THEMES, pieceSrc, usePreferences, type BoardTheme, type PieceTheme,
} from '../app/ThemeProvider';
import { PageHeader } from '../components/PageHeader';
import { Icon } from '../components/Icon';
import { useToast } from '../app/ToastProvider';

/** Three positions so a set can be judged on pawns, officers and an endgame. */
const POSITIONS: Array<{ id: string; label: string; fen: string }> = [
  { id: 'start', label: 'Starting position', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' },
  { id: 'middlegame', label: 'Mid-game', fen: 'r1bq1rk1/pp2bppp/2n1pn2/2pp4/3P1B2/2PBPN2/PP1N1PPP/R2Q1RK1 w - - 0 9' },
  { id: 'endgame', label: 'Endgame', fen: '8/5pk1/6p1/8/3P4/4P1K1/5P2/8 w - - 0 1' },
];

/** The two pieces that best show off a set's character. */
const SAMPLE_PIECES = ['wK', 'wN', 'bQ', 'bB'] as const;

function Swatch({ light, dark }: { light: string; dark: string }) {
  return (
    <span className="swatch" aria-hidden="true">
      <span style={{ background: light }} />
      <span style={{ background: dark }} />
      <span style={{ background: dark }} />
      <span style={{ background: light }} />
    </span>
  );
}

function PieceSample({ theme, light, dark }: { theme: PieceTheme; light: string; dark: string }) {
  const backgrounds = [light, dark, light, dark];
  return (
    <span className="piece-sample" aria-hidden="true">
      {SAMPLE_PIECES.map((piece, index) => (
        <span key={piece} style={{ background: backgrounds[index] }}>
          {theme === 'staunton'
            ? defaultPieces[piece]?.({ fill: piece.startsWith('w') ? '#f8fafc' : '#1e293b' })
            : <img className={`piece-image ${theme}`} src={pieceSrc(theme, piece)} alt="" draggable={false} />}
        </span>
      ))}
    </span>
  );
}

export function BoardsPage() {
  const prefs = usePreferences();
  const toast = useToast();
  const [position, setPosition] = useState(POSITIONS[1].id);
  const fen = useMemo(() => POSITIONS.find((entry) => entry.id === position)?.fen ?? POSITIONS[0].fen, [position]);
  const board = BOARD_THEMES.find((entry) => entry.id === prefs.boardTheme) ?? BOARD_THEMES[0];
  const pieces = PIECE_THEMES.find((entry) => entry.id === prefs.pieceTheme) ?? PIECE_THEMES[0];

  const chooseBoard = (id: BoardTheme) => {
    prefs.set('boardTheme', id);
    toast.info('Board updated', `${BOARD_THEMES.find((entry) => entry.id === id)?.label ?? id} squares applied.`);
  };
  const choosePieces = (id: PieceTheme) => {
    prefs.set('pieceTheme', id);
    toast.info('Pieces updated', `${PIECE_THEMES.find((entry) => entry.id === id)?.label ?? id} applied.`);
  };
  const reset = () => {
    prefs.set('boardTheme', 'green');
    prefs.set('pieceTheme', 'chesscom');
    toast.success('Back to the default look', 'Tournament green with Classic Staunton pieces.');
  };

  return (
    <div className="container">
      <PageHeader
        eyebrow="Board studio"
        title="Choose how your board looks"
        description="Every combination below is the real board component — nothing here is a mock-up. Pick a palette and a piece set and it applies instantly across play, puzzles, lessons, practice and analysis. Choices are saved in this browser."
        actions={<button className="btn btn-ghost btn-sm" onClick={reset}><Icon name="arrowLeft" size={16} /> Reset to default</button>}
      />

      <div className="board-stage">
        <div className="board-column">
          <div className="segmented" role="group" aria-label="Preview position">
            {POSITIONS.map((entry) => (
              <button key={entry.id} type="button" aria-pressed={position === entry.id} onClick={() => setPosition(entry.id)}>
                {entry.label}
              </button>
            ))}
          </div>
          <div style={{ marginTop: '.75rem' }}>
            <ChessBoard fen={fen} allowArrows={false} showCaption={false} />
          </div>
          <div className="board-caption">
            <span><strong>{board.label}</strong> · {pieces.label}</span>
            <span>{pieces.attribution ?? 'Project artwork'}</span>
          </div>
        </div>

        <aside className="stack">
          <section className="card">
            <div className="card-header"><h2 className="card-title">Board</h2><span className="pill">{BOARD_THEMES.length}</span></div>
            <div className="theme-list" role="group" aria-label="Board palette">
              {BOARD_THEMES.map((theme) => (
                <button key={theme.id} type="button" className="theme-option" aria-pressed={prefs.boardTheme === theme.id}
                  onClick={() => chooseBoard(theme.id)}>
                  <Swatch light={theme.light} dark={theme.dark} />
                  <span className="theme-copy">
                    <strong>{theme.label}</strong>
                    <span className="tiny muted">{theme.note}</span>
                  </span>
                  {prefs.boardTheme === theme.id && <Icon name="check" size={16} />}
                </button>
              ))}
            </div>
          </section>

          <section className="card">
            <div className="card-header"><h2 className="card-title">Pieces</h2><span className="pill">{PIECE_THEMES.length}</span></div>
            <div className="theme-list" role="group" aria-label="Piece set">
              {PIECE_THEMES.map((theme) => (
                <button key={theme.id} type="button" className="theme-option" aria-pressed={prefs.pieceTheme === theme.id}
                  onClick={() => choosePieces(theme.id)}>
                  <PieceSample theme={theme.id} light={board.light} dark={board.dark} />
                  <span className="theme-copy">
                    <strong>{theme.label}</strong>
                    <span className="tiny muted">{theme.note}</span>
                    <span className="tiny muted">{theme.attribution}</span>
                  </span>
                  {prefs.pieceTheme === theme.id && <Icon name="check" size={16} />}
                </button>
              ))}
            </div>
          </section>

          <section className="card">
            <h2 className="card-title">Also in this browser</h2>
            <div className="stack" style={{ gap: '.55rem' }}>
              <label className="checkbox"><input type="checkbox" checked={prefs.showCoordinates} onChange={(e) => prefs.set('showCoordinates', e.target.checked)} /> Show coordinates</label>
              <label className="checkbox"><input type="checkbox" checked={prefs.showLegalMoves} onChange={(e) => prefs.set('showLegalMoves', e.target.checked)} /> Highlight legal moves</label>
              <label className="checkbox"><input type="checkbox" checked={prefs.animations && !prefs.reducedMotion} disabled={prefs.reducedMotion} onChange={(e) => prefs.set('animations', e.target.checked)} /> Piece animations</label>
              <p className="tiny muted" style={{ marginBottom: 0 }}>More options live in <Link to="/settings">Settings</Link>. The same choices are used by <Link to="/train">Practice</Link> and <Link to="/analysis">Analysis</Link>.</p>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
