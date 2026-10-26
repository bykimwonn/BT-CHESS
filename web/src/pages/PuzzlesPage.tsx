import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Chess, type Square } from 'chess.js';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../app/AuthProvider';
import { useToast } from '../app/ToastProvider';
import { ChessBoard } from '../features/chess/ChessBoard';
import { PageHeader, ErrorState } from '../components/PageHeader';
import { Icon } from '../components/Icon';

interface Puzzle { id: string; fen: string; theme: string; rating: number; source: string }

export function PuzzlesPage() {
  const { user } = useAuth();
  const toast = useToast();
  const [selected, setSelected] = useState(0);
  const [fen, setFen] = useState('');
  const [moves, setMoves] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<{ correct: boolean; delta: number; solution?: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const puzzles = useQuery({ queryKey: ['puzzles'], queryFn: () => api<{ items: Puzzle[] }>('/puzzles') });
  const profile = useQuery({
    queryKey: ['puzzle-profile', user?.username],
    queryFn: () => api<{ user: { puzzleRating: number; gamesPlayed: number } }>(`/users/${encodeURIComponent(user!.username)}/profile`),
    enabled: !!user,
  });
  const current = puzzles.data?.items[selected];

  useEffect(() => { if (current) { setFen(current.fen); setMoves([]); setFeedback(null); } }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const legalMoves = useMemo(() => {
    try { return new Chess(fen).moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion ?? '')); } catch { return []; }
  }, [fen]);

  const onMove = (from: string, to: string, promotion?: string) => {
    if (feedback) return;
    const chess = new Chess(fen);
    const move = chess.move({ from: from as Square, to: to as Square, promotion });
    if (!move) return;
    setFen(chess.fen());
    setMoves((list) => [...list, move.from + move.to + (move.promotion ?? '')]);
    setFeedback(null);
  };

  const check = async () => {
    if (!current || !user) { toast.error('Sign in required', 'Create an account to persist puzzle ratings.'); return; }
    if (!moves.length) { toast.info('Make a move', 'Try a legal move before checking the solution.'); return; }
    setBusy(true);
    try {
      const result = await api<{ correct: boolean; ratingDelta: number; solution?: string[] }>(`/puzzles/${current.id}/attempt`, {
        method: 'POST', body: { moves },
      });
      setFeedback({ correct: result.correct, delta: result.ratingDelta, solution: result.solution });
      void profile.refetch();
    } catch (error) { toast.error('Could not check puzzle', errorMessage(error)); }
    finally { setBusy(false); }
  };

  const next = () => {
    if (!puzzles.data?.items.length) return;
    setSelected((index) => (index + 1) % puzzles.data.items.length);
  };

  return (
    <div className="container">
      <PageHeader eyebrow="Training" title="Puzzles" description="Original composed positions with server-verified solutions. Puzzle ratings come from persisted attempts — there are no prefabricated statistics."
        actions={<span className="pill pill-teal">Puzzle rating: {profile.data?.user.puzzleRating ?? (user ? '—' : 'Sign in')}</span>} />
      <div className="split">
        <div className="stack">
          {puzzles.isLoading && <div className="card"><span className="loading" /> Loading puzzles…</div>}
          {puzzles.error && <ErrorState message={errorMessage(puzzles.error)} retry={() => void puzzles.refetch()} />}
          {current && <>
            <div className="card">
              <div className="card-header"><div><h2 className="card-title">{current.theme} · rated {current.rating}</h2><p className="card-subtitle">Find the winning move. The server validates the exact solution and checks mate.</p></div>
                <span className="pill">{moves.length} move{moves.length === 1 ? '' : 's'} played</span></div>
              <ChessBoard fen={fen} legalMoves={legalMoves} onMove={onMove} onIllegal={(message) => toast.info('Illegal move', message)}
                disabled={!!feedback?.correct} lastMove={moves.length ? { from: moves[moves.length - 1].slice(0, 2), to: moves[moves.length - 1].slice(2, 4) } : null} />
            </div>
            <div className="card">
              <div className="row-wrap">
                <button className="btn btn-primary" onClick={() => void check()} disabled={busy || !user}>{busy ? <span className="loading" /> : <Icon name="check" size={16} />} Check solution</button>
                <button className="btn" onClick={() => { setFen(current.fen); setMoves([]); setFeedback(null); }}>Reset</button>
                <button className="btn" onClick={next}>Next puzzle</button>
              </div>
              {feedback && <div className={`alert ${feedback.correct ? 'alert-success' : 'alert-danger'}`} style={{ marginTop: '.75rem' }}>
                <strong>{feedback.correct ? 'Correct — checkmate verified.' : 'Not the solution.'}</strong>
                <div className="small">Puzzle rating change: {feedback.delta > 0 ? '+' : ''}{feedback.delta}. {feedback.solution && `Solution: ${feedback.solution.join(' ')}`}</div>
              </div>}
              {!user && <p className="small muted" style={{ marginBottom: 0, marginTop: '.75rem' }}>Sign in to record attempts and update your puzzle rating.</p>}
            </div>
          </>}
        </div>
        <div className="sidebar">
          <section className="card">
            <div className="card-header"><h2 className="card-title">Puzzle set</h2><span className="pill">{puzzles.data?.items.length ?? 0} positions</span></div>
            <div className="stack" style={{ gap: '.4rem' }}>
              {puzzles.data?.items.map((puzzle, index) => (
                <button className={`btn btn-sm ${index === selected ? 'btn-primary' : ''}`} key={puzzle.id} onClick={() => setSelected(index)}>
                  {puzzle.theme} · {puzzle.rating}
                </button>
              ))}
            </div>
          </section>
          <section className="card">
            <h2 className="card-title">How ratings work</h2>
            <p className="small soft">The server checks every submitted UCI move against the stored solution and requires checkmate. Correct attempts add 8 rating points; incorrect attempts subtract 5. These values are recorded in <code>puzzle_attempts</code>.</p>
            <p className="tiny muted" style={{ marginBottom: 0 }}>Positions are original compositions shipped with this application, not copied from a third-party puzzle database.</p>
          </section>
        </div>
      </div>
    </div>
  );
}
