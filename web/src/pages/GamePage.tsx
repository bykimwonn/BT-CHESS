import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../app/AuthProvider';
import { useToast } from '../app/ToastProvider';
import { capturedPieces } from '@shared/contracts';
import { ChessBoard } from '../features/chess/ChessBoard';
import { PlayerBar } from '../features/chess/PlayerBar';
import { MoveList } from '../features/chess/MoveList';
import { ChatPanel } from '../features/chess/ChatPanel';
import { useGame } from '../features/chess/useGame';
import { ConfirmDialog } from '../components/Modal';
import { Icon } from '../components/Icon';
import { ErrorState } from '../components/PageHeader';

interface MoveQuality {
  ply: number; san: string; uci: string; bestMove: string | null;
  bestScoreCp: number | null; playedScoreCp: number | null; lossCp: number | null;
  quality: string; depth: number; engine: string | null;
}
interface GameAnalysis {
  gameId: string; engine: string | null; moves: MoveQuality[];
  summary: { white: { averageLossCp: number | null; blunders: number; inaccuracies: number }; black: { averageLossCp: number | null; blunders: number; inaccuracies: number } };
  note: string;
}

function PostGameAnalysis({ gameId }: { gameId: string }) {
  const [analysis, setAnalysis] = useState<GameAnalysis | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true); setError(null);
    try { setAnalysis(await api<GameAnalysis>(`/games/${gameId}/analysis?depth=12&maxMoves=40`)); }
    catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  };
  return (
    <section className="card" aria-labelledby="post-game-title">
      <div className="card-header"><div><h2 className="card-title" id="post-game-title">Game review</h2><p className="card-subtitle">Server Stockfish, computed from the saved moves.</p></div>
        <button className="btn btn-sm btn-primary" onClick={() => void run()} disabled={busy}>{busy ? <span className="loading" /> : <Icon name="analysis" size={15} />} {analysis ? 'Re-run' : 'Review game'}</button></div>
      {error && <div className="alert alert-danger">{error}</div>}
      {analysis && <>
        <div className="grid-3" style={{ marginBottom: '.75rem' }}>
          <div className="stat"><div className="stat-label">White avg. loss</div><div className="stat-value" style={{ fontSize: '1.2rem' }}>{analysis.summary.white.averageLossCp === null ? '—' : `${analysis.summary.white.averageLossCp} cp`}</div></div>
          <div className="stat"><div className="stat-label">Black avg. loss</div><div className="stat-value" style={{ fontSize: '1.2rem' }}>{analysis.summary.black.averageLossCp === null ? '—' : `${analysis.summary.black.averageLossCp} cp`}</div></div>
          <div className="stat"><div className="stat-label">Engine</div><div className="stat-value mono" style={{ fontSize: '.9rem' }}>{analysis.engine ?? 'Unavailable'}</div></div>
        </div>
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Ply</th><th>Played</th><th>Best</th><th>Loss</th><th>Quality</th><th>Depth</th></tr></thead>
          <tbody>{analysis.moves.map((move) => <tr key={move.ply}>
            <td>{move.ply}</td><td className="mono">{move.san}</td><td className="mono">{move.bestMove ?? '—'}</td>
            <td>{move.lossCp === null ? '—' : `${move.lossCp} cp`}</td><td>{move.quality}</td><td>{move.depth || '—'}</td>
          </tr>)}</tbody>
        </table></div>
        <p className="tiny muted" style={{ marginBottom: 0 }}>{analysis.note}</p>
      </>}
    </section>
  );
}

export function GamePage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const { user } = useAuth();
  const toast = useToast();
  const game = useGame(id);
  const [initialPlyApplied, setInitialPlyApplied] = useState(false);
  const [confirm, setConfirm] = useState<'resign' | 'claim' | null>(null);

  useEffect(() => {
    if (!game.snapshot || initialPlyApplied) return;
    const ply = params.get('ply');
    if (ply !== null) game.setReplayPly(Math.max(0, Math.min(Number(ply) || 0, game.snapshot.moves.length)));
    setInitialPlyApplied(true);
  }, [game.snapshot, initialPlyApplied, params]); // eslint-disable-line react-hooks/exhaustive-deps

  const setReplayPly = useCallback((ply: number | null) => {
    game.setReplayPly(ply);
    const next = new URLSearchParams(params);
    if (ply === null) next.delete('ply'); else next.set('ply', String(ply));
    setParams(next, { replace: true });
  }, [game.setReplayPly, params, setParams]);

  const onMove = useCallback(async (from: string, to: string, promotion?: string) => {
    try { await game.submitMove(from, to, promotion); }
    catch (error) { toast.error('Move not accepted', errorMessage(error)); }
  }, [game.submitMove, toast]);

  const lastMove = useMemo(() => {
    if (!game.snapshot) return null;
    const ply = game.replayPly;
    if (ply === null) return game.snapshot.lastMove;
    if (ply === 0) return null;
    const move = game.snapshot.moves[ply - 1];
    return move ? { from: move.uci.slice(0, 2), to: move.uci.slice(2, 4) } : null;
  }, [game.snapshot, game.replayPly]);

  if (game.loading) return <div className="container section"><span className="loading" /> Loading game…</div>;
  if (!game.snapshot) return <div className="container section"><ErrorState message={game.error ?? 'Game not found'} retry={() => void game.refresh()} /><Link className="btn btn-sm" to="/play">Back to lobby</Link></div>;

  const s = game.snapshot;
  const replaying = game.replayPly !== null;
  const canMove = !game.isSpectator && game.isMyTurn && !replaying && s.status === 'active' && !game.pendingMove;
  const boardFen = game.replayFen ?? s.fen;
  const captures = capturedPieces(boardFen);
  const bottomColor = game.orientation;
  const topColor = bottomColor === 'white' ? 'black' : 'white';
  const seat = (color: 'white' | 'black') => (color === 'white' ? s.white : s.black);
  const resultLabel = s.result === 'draw' ? 'Draw'
    : s.result === 'white' ? 'White wins'
      : s.result === 'black' ? 'Black wins'
        : s.result === 'void' ? 'Game void' : null;
  const drawOfferedToMe = s.drawOfferBy !== null && s.drawOfferBy !== user?.id;

  return (
    <div className="container play-screen">
      <h1 className="sr-only">
        {s.white.username} vs {s.black.username}{s.status === 'active' ? '' : ` — ${resultLabel ?? s.status}`}
      </h1>
      {(game.isSpectator || replaying || !game.connected) && (
        <div className="play-top">
          {game.isSpectator && <span className="pill pill-accent">Spectating</span>}
          {replaying && <span className="pill pill-accent">Replay · ply {game.replayPly}</span>}
          {!game.connected && <span className="pill pill-danger">Reconnecting…</span>}
        </div>
      )}

      {game.error && <div className="alert alert-danger" style={{ marginBottom: '1rem' }}>{game.error}</div>}
      {s.status === 'active' && !game.connected && <div className="alert alert-warning" style={{ marginBottom: '1rem' }}>Connection interrupted. The game continues on the server; reconnecting restores it.</div>}
      {s.status === 'disputed' && <div className="alert alert-warning" style={{ marginBottom: '1rem' }}>Under review by an administrator.</div>}

      <div className="play-grid">
        <div className="play-board-column">
          <PlayerBar seat={seat(topColor)} color={topColor} clockMs={topColor === 'white' ? game.clocks.white : game.clocks.black}
            active={s.fen.split(' ')[1] === (topColor === 'white' ? 'w' : 'b')} status={s.status}
            isViewer={game.viewerColor === topColor} captured={captures[bottomColor]} />

          {drawOfferedToMe && (
            <div className="draw-offer" role="alert">
              <span>Draw offered</span>
              <button className="btn btn-sm btn-teal" onClick={() => void game.answerDraw(true)}>Accept</button>
              <button className="btn btn-sm" onClick={() => void game.answerDraw(false)}>Decline</button>
            </div>
          )}

          <ChessBoard fen={boardFen} orientation={game.orientation} legalMoves={s.legalMoves} lastMove={lastMove}
            onMove={canMove ? onMove : undefined} onIllegal={(message) => toast.info('Illegal move', message)}
            disabled={!canMove} showCaption={false} />

          <PlayerBar seat={seat(bottomColor)} color={bottomColor} clockMs={bottomColor === 'white' ? game.clocks.white : game.clocks.black}
            active={s.fen.split(' ')[1] === (bottomColor === 'white' ? 'w' : 'b')} status={s.status}
            isViewer={game.viewerColor === bottomColor} captured={captures[topColor]} />

          {s.status === 'active' && !game.isSpectator && (
            <div className="play-controls">
              <button className="btn btn-sm" onClick={() => void game.offerDraw()} disabled={!!s.drawOfferBy}><Icon name="flag" size={15} /> Draw</button>
              <button className="btn btn-sm" onClick={() => setConfirm('claim')}>Claim draw</button>
              <button className="btn btn-sm btn-danger" onClick={() => setConfirm('resign')}>Resign</button>
            </div>
          )}
        </div>

        <div className="play-side">
          {s.status !== 'active' && resultLabel && (
            <section className="card result-card" aria-live="polite">
              <h2 className="card-title">{resultLabel}</h2>
              <p className="tiny muted" style={{ margin: 0 }}>{s.termination?.replace(/_/g, ' ')}</p>
              <Link className="btn btn-sm" style={{ marginTop: '.75rem' }} to={`/analysis?fen=${encodeURIComponent(s.fen)}`}>
                <Icon name="analysis" size={15} /> Open in analysis
              </Link>
            </section>
          )}
          <MoveList game={s} replayPly={game.replayPly} setReplayPly={setReplayPly} displayFen={boardFen} />
          <ChatPanel chat={game.chat} connected={game.connected} isSpectator={game.isSpectator} onChat={game.sendChat} />
        </div>
      </div>

      {s.status !== 'active' && <div style={{ marginTop: '1rem' }}><PostGameAnalysis gameId={id} /></div>}

      <ConfirmDialog open={confirm === 'resign'} onClose={() => setConfirm(null)} onConfirm={async () => { await game.resign(); setConfirm(null); }}
        title="Resign this game?" message="The result is final and the opponent wins." confirmLabel="Resign" danger />
      <ConfirmDialog open={confirm === 'claim'} onClose={() => setConfirm(null)} onConfirm={async () => { await game.claimDraw(); setConfirm(null); }}
        title="Claim a draw?" message="The server checks for a real threefold repetition or fifty-move position before ending the game." confirmLabel="Claim draw" />
    </div>
  );
}
