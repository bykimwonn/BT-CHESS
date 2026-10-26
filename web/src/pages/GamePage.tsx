import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { Arrow } from 'react-chessboard';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../app/AuthProvider';
import { useToast } from '../app/ToastProvider';
import { ChessBoard } from '../features/chess/ChessBoard';
import { GameSidebar } from '../features/chess/GameSidebar';
import { useGame } from '../features/chess/useGame';
import { EnginePanel } from '../features/engine/EnginePanel';
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
      <div className="card-header"><div><h2 className="card-title" id="post-game-title">Post-game analysis</h2><p className="card-subtitle">Move-by-move evaluation from the server Stockfish engine.</p></div>
        <button className="btn btn-sm btn-primary" onClick={() => void run()} disabled={busy}>{busy ? <span className="loading" /> : <Icon name="analysis" size={15} />} {analysis ? 'Re-run' : 'Analyse game'}</button></div>
      {error && <div className="alert alert-danger">{error}</div>}
      {!analysis && !busy && <p className="small muted">No evaluation is shown until you request one. Results are computed from persisted moves, not invented.</p>}
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
  const [arrows, setArrows] = useState<Arrow[]>([]);
  const [showEngine, setShowEngine] = useState(false);
  const [initialPlyApplied, setInitialPlyApplied] = useState(false);

  useEffect(() => {
    if (!game.snapshot || initialPlyApplied) return;
    const ply = params.get('ply');
    if (ply !== null) game.setReplayPly(Math.max(0, Math.min(Number(ply) || 0, game.snapshot.moves.length)));
    setInitialPlyApplied(true);
    if (game.snapshot.status !== 'active') setShowEngine(true);
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

  if (game.loading) return <div className="container section"><span className="loading" /> Loading authoritative game state…</div>;
  if (!game.snapshot) return <div className="container section"><ErrorState message={game.error ?? 'Game not found'} retry={() => void game.refresh()} /><Link className="btn btn-sm" to="/play">Back to lobby</Link></div>;

  const s = game.snapshot;
  const replaying = game.replayPly !== null;
  const canMove = !game.isSpectator && game.isMyTurn && !replaying && s.status === 'active' && !game.pendingMove;
  const boardFen = game.replayFen ?? s.fen;

  return (
    <div className="container">
      <div className="spread" style={{ flexWrap: 'wrap', marginBottom: '1.25rem' }}>
        <div>
          <span className="eyebrow">{s.mode === 'free' ? 'Free chess' : s.mode === 'test' ? 'Internal test credits' : 'Authorised competition'}</span>
          <h1 style={{ fontSize: 'clamp(1.8rem, 3vw, 2.6rem)', margin: '.25rem 0' }}>{s.white.username} <span className="muted">vs</span> {s.black.username}</h1>
          <div className="row-wrap small muted"><span>Game {s.id.slice(0, 8)}</span><span>·</span><span>{s.status}</span><span>·</span><span>Version {s.version}</span></div>
        </div>
        <div className="row-wrap">
          {game.isSpectator && <span className="pill pill-accent">Spectating</span>}
          {replaying && <span className="pill pill-accent">Replay · ply {game.replayPly}</span>}
          {!game.connected && <span className="pill pill-danger">Reconnecting</span>}
          <button className="btn btn-sm" onClick={() => void game.refresh()}><Icon name="analysis" size={15} /> Refresh</button>
          <Link className="btn btn-sm" to={`/analysis?fen=${encodeURIComponent(boardFen)}`}>Open in analysis</Link>
        </div>
      </div>

      {game.error && <div className="alert alert-danger" style={{ marginBottom: '1rem' }}><strong>Game state warning.</strong> {game.error}</div>}
      {s.status === 'active' && !game.connected && <div className="alert alert-warning" style={{ marginBottom: '1rem' }}><strong>Connection interrupted.</strong> The server continues to hold the authoritative position and clocks. Reconnection will restore state.</div>}
      {s.status === 'disputed' && <div className="alert alert-warning" style={{ marginBottom: '1rem' }}><strong>Under review.</strong> Settlement is blocked until a human administrator resolves the dispute.</div>}

      <div className="board-stage">
        <div className="board-column">
          <ChessBoard fen={boardFen} orientation={game.orientation} legalMoves={s.legalMoves} lastMove={lastMove}
            onMove={canMove ? onMove : undefined} onIllegal={(message) => toast.info('Illegal move', message)}
            disabled={!canMove} arrows={arrows} allowArrows={showEngine} />
          <div className="row-wrap" style={{ marginTop: '.75rem' }}>
            <button className="btn btn-sm" aria-pressed={showEngine} onClick={() => setShowEngine((v) => !v)}><Icon name="spark" size={15} /> {showEngine ? 'Hide' : 'Show'} engine analysis</button>
            {canMove && <span className="small soft">It is your turn. Click or drag a piece, or use keyboard mode.</span>}
            {!canMove && s.status === 'active' && !replaying && <span className="small soft">{game.isSpectator ? 'Spectators cannot move.' : 'Waiting for the opponent or server state.'}</span>}
          </div>
          {s.status !== 'active' && <div style={{ marginTop: '1rem' }}><PostGameAnalysis gameId={id} /></div>}
        </div>

        <div className="sidebar">
          <GameSidebar game={s} clocks={game.clocks} replayPly={game.replayPly} setReplayPly={setReplayPly}
            viewerId={user?.id} isSpectator={game.isSpectator} isMyTurn={game.isMyTurn} pendingMove={game.pendingMove}
            connected={game.connected} chat={game.chat} onResign={game.resign} onOfferDraw={game.offerDraw}
            onAnswerDraw={game.answerDraw} onClaimDraw={game.claimDraw} onChat={game.sendChat}
            displayFen={boardFen} replayMoves={game.replayUciMoves} />
          {showEngine && <EnginePanel fen={boardFen} moves={game.replayUciMoves} onArrowsChange={setArrows} compact />}
        </div>
      </div>
    </div>
  );
}
