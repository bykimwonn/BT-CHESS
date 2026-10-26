import { useState } from 'react';
import { formatLocalDateTime } from '@shared/countries';
import type { GameSnapshot } from '@shared/contracts';
import { useToast } from '../../app/ToastProvider';
import { Icon } from '../../components/Icon';

interface MoveListProps {
  game: GameSnapshot;
  replayPly: number | null;
  setReplayPly: (ply: number | null) => void;
  displayFen: string;
}

function downloadText(filename: string, text: string, type = 'text/plain') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; anchor.click();
  URL.revokeObjectURL(url);
}

/** The score sheet: moves, replay controls and the PGN/FEN data on demand. */
export function MoveList({ game, replayPly, setReplayPly, displayFen }: MoveListProps) {
  const toast = useToast();
  const [copied, setCopied] = useState<string | null>(null);
  const activePly = replayPly ?? game.moves.length;
  const minutes = Math.round(game.timeControl.baseMs / 60_000);
  const increment = game.timeControl.incrementMs / 1000;

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      toast.success(`${label} copied`);
    } catch {
      toast.error('Clipboard unavailable', 'Select and copy the text manually.');
    }
  };

  return (
    <section className="card move-list-panel" aria-labelledby="moves-title">
      <div className="card-header">
        <h2 className="card-title" id="moves-title">Moves</h2>
        <div className="replay-controls" role="group" aria-label="Replay controls">
          <button className="btn btn-icon btn-sm" onClick={() => setReplayPly(0)} aria-label="Go to starting position"><Icon name="first" size={16} /></button>
          <button className="btn btn-icon btn-sm" onClick={() => setReplayPly(Math.max(0, activePly - 1))} aria-label="Previous move"><Icon name="arrowLeft" size={16} /></button>
          <button className="btn btn-icon btn-sm" onClick={() => setReplayPly(Math.min(game.moves.length, activePly + 1))} aria-label="Next move"><Icon name="arrowRight" size={16} /></button>
          <button className="btn btn-icon btn-sm" onClick={() => setReplayPly(game.moves.length)} aria-label="Go to last move"><Icon name="last" size={16} /></button>
          <button className="btn btn-sm" onClick={() => setReplayPly(null)} aria-pressed={replayPly === null}>Live</button>
        </div>
      </div>
      <p className="tiny muted move-meta" style={{ margin: 0 }}>
        {game.timeControl.category} · {minutes}+{increment} · started{' '}
        <span data-testid="viewer-local-time" title={formatLocalDateTime(game.startedAt)}>
          {new Date(game.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </p>
      <div className="move-list">
        {game.moves.length === 0 && <p className="small muted">No moves yet.</p>}
        {Array.from({ length: Math.ceil(game.moves.length / 2) }, (_, index) => (
          <div className="move-row" key={index}>
            <span className="move-number">{index + 1}.</span>
            {[0, 1].map((offset) => {
              const move = game.moves[index * 2 + offset];
              return move ? (
                <button key={move.ply} className={`move-cell ${activePly === move.ply ? 'active' : ''}`}
                  onClick={() => setReplayPly(move.ply)} aria-label={`Replay to move ${move.ply}, ${move.san}`}>
                  {move.san}
                </button>
              ) : <span className="move-cell" />;
            })}
          </div>
        ))}
      </div>
      <details className="game-data">
        <summary className="tiny muted">Game data (PGN / FEN)</summary>
        <div className="row-wrap" style={{ marginTop: '.5rem' }}>
          <button className="btn btn-sm" onClick={() => void copy(game.pgn, 'PGN')}>
            <Icon name="copy" size={15} /> {copied === 'PGN' ? 'Copied' : 'Copy PGN'}
          </button>
          <button className="btn btn-sm" onClick={() => downloadText(`rookstone-${game.id}.pgn`, game.pgn, 'application/x-chess-pgn')}>
            <Icon name="download" size={15} /> Download
          </button>
          <button className="btn btn-sm" onClick={() => void copy(displayFen, 'FEN')}>Copy FEN</button>
        </div>
        <label className="field" style={{ marginTop: '.5rem' }}>
          <span className="field-label">PGN</span>
          <textarea className="textarea pgn-box" readOnly value={game.pgn} aria-label="Portable Game Notation" />
        </label>
        <label className="field">
          <span className="field-label">FEN</span>
          <input className="input mono small" readOnly value={displayFen} aria-label="Forsyth-Edwards Notation" />
        </label>
      </details>
    </section>
  );
}
