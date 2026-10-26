import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Chess, type Color, type Square } from 'chess.js';
import type { Arrow } from 'react-chessboard';
import { ChessBoard } from '../features/chess/ChessBoard';
import { useStockfish } from '../features/engine/useStockfish';
import {
  DEFAULT_LEVEL_ID, ENGINE_LEVELS, coachRequest, evalBarPercent, evalLabel, levelById, levelRequest,
  parseUciMove, randomMove, whitePerspective,
} from '../features/engine/levels';
import { useToast } from '../app/ToastProvider';
import { PageHeader } from '../components/PageHeader';
import { Icon } from '../components/Icon';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

interface MoveRecord { uci: string; san: string; fenAfter: string; by: 'player' | 'engine' }
type Phase = 'idle' | 'playing' | 'over';
type ColourChoice = 'white' | 'black' | 'random';

interface Outcome { title: string; detail: string; won: boolean }

/** The result of a finished game, or null while it is still live. */
function outcomeOf(chess: Chess, playerColor: Color): Outcome | null {
  if (chess.isCheckmate()) {
    const winner: Color = chess.turn() === 'w' ? 'b' : 'w';
    const won = winner === playerColor;
    return {
      won,
      title: won ? 'You won by checkmate' : 'The engine won by checkmate',
      detail: won ? 'Well played. Raise the level when you are ready.' : 'Look at the last few moves, then try the same level again.',
    };
  }
  if (chess.isStalemate()) return { won: false, title: 'Draw by stalemate', detail: 'No legal move and no check.' };
  if (chess.isInsufficientMaterial()) return { won: false, title: 'Draw by insufficient material', detail: 'Neither side can force mate.' };
  if (chess.isThreefoldRepetition()) return { won: false, title: 'Draw by threefold repetition', detail: 'The same position appeared three times.' };
  if (chess.isDraw()) return { won: false, title: 'Draw', detail: 'The fifty-move rule or another draw condition applies.' };
  return null;
}

function sanFor(fen: string, uci: string): string | null {
  const parsed = parseUciMove(uci);
  if (!parsed) return null;
  try {
    const move = new Chess(fen).move({ from: parsed.from as Square, to: parsed.to as Square, promotion: parsed.promotion });
    return move?.san ?? null;
  } catch { return null; }
}

export function TrainPage() {
  const toast = useToast();
  const engine = useStockfish();
  const chessRef = useRef(new Chess());
  const playerColorRef = useRef<Color>('w');
  const levelRef = useRef(DEFAULT_LEVEL_ID);
  const runRef = useRef(0);
  // `analyse` changes identity when the engine reports its name; keep the
  // latest one in a ref so the game callbacks never capture a stale engine.
  const analyseRef = useRef(engine.analyse);
  analyseRef.current = engine.analyse;

  const [phase, setPhase] = useState<Phase>('idle');
  const [levelId, setLevelId] = useState(DEFAULT_LEVEL_ID);
  const [colourChoice, setColourChoice] = useState<ColourChoice>('white');
  const [playerColor, setPlayerColor] = useState<Color>('w');
  const [fen, setFen] = useState(START_FEN);
  const [history, setHistory] = useState<MoveRecord[]>([]);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [thinking, setThinking] = useState(false);
  const [evaluation, setEvaluation] = useState<{ cp: number; mate: number | null }>({ cp: 0, mate: null });
  const [hint, setHint] = useState<{ uci: string; san: string | null; fen: string } | null>(null);
  const [review, setReview] = useState<{ played: string; bestSan: string | null } | null>(null);
  const [busyAction, setBusyAction] = useState<'hint' | 'review' | null>(null);

  const level = levelById(levelId);
  const turn = useMemo(() => { try { return new Chess(fen).turn(); } catch { return 'w' as Color; } }, [fen]);
  const isPlayerTurn = phase === 'playing' && turn === playerColor && !thinking;
  const lastMove = useMemo(() => {
    const last = history[history.length - 1];
    const parsed = parseUciMove(last?.uci);
    return parsed ? { from: parsed.from, to: parsed.to } : null;
  }, [history]);
  const arrows: Arrow[] = useMemo(() => {
    if (!hint || hint.fen !== fen) return [];
    const parsed = parseUciMove(hint.uci);
    return parsed ? [{ startSquare: parsed.from, endSquare: parsed.to, color: '#f2b134' }] : [];
  }, [hint, fen]);

  useEffect(() => { levelRef.current = levelId; }, [levelId]);

  /** Republish React state from the authoritative local chess.js instance. */
  const publish = useCallback(() => {
    const chess = chessRef.current;
    setFen(chess.fen());
    setHistory(chess.history({ verbose: true }).map((move) => ({
      uci: `${move.from}${move.to}${move.promotion ?? ''}`,
      san: move.san,
      fenAfter: move.after,
      by: move.color === playerColorRef.current ? 'player' : 'engine',
    })));
  }, []);

  const checkGameOver = useCallback((): boolean => {
    const result = outcomeOf(chessRef.current, playerColorRef.current);
    if (!result) return false;
    setOutcome(result);
    setPhase('over');
    setThinking(false);
    return true;
  }, []);

  /** Ask the engine for a move at the chosen level and apply it. */
  const engineMove = useCallback(async () => {
    const chess = chessRef.current;
    const run = runRef.current;
    if (chess.isGameOver() || chess.turn() === playerColorRef.current) return;
    setThinking(true);
    try {
      const activeLevel = levelById(levelRef.current);
      const legal = chess.moves({ verbose: true }).map((move) => `${move.from}${move.to}${move.promotion ?? ''}`);
      const bluff = activeLevel.blunderChance > 0 && Math.random() < activeLevel.blunderChance
        ? randomMove(legal)
        : null;
      let chosen = bluff;
      let result = null;
      if (chosen) {
        // Evaluate anyway so the bar and the coaching stay truthful.
        try { result = await analyseRef.current({ fen: chess.fen(), ...coachRequest(10, 400), multipv: 1 }); } catch { result = null; }
      } else {
        result = await analyseRef.current({ fen: chess.fen(), ...levelRequest(activeLevel), multipv: 1 });
        chosen = parseUciMove(result.bestMove) ? result.bestMove : randomMove(legal);
      }
      if (run !== runRef.current) return;
      const parsed = parseUciMove(chosen);
      if (!parsed) { setThinking(false); return; }
      // The search score is for the side that was to move — which is the engine.
      const searchSign: 1 | -1 = chess.turn() === 'w' ? 1 : -1;
      const move = chess.move({ from: parsed.from as Square, to: parsed.to as Square, promotion: parsed.promotion });
      if (!move) { setThinking(false); return; }
      if (result) setEvaluation(whitePerspective(result, searchSign));
      publish();
      setThinking(false);
      checkGameOver();
    } catch (error) {
      if (run !== runRef.current) return;
      setThinking(false);
      toast.error('The engine did not answer', (error as Error).message);
    }
  }, [publish, checkGameOver, toast]);

  const startGame = useCallback((choice: ColourChoice) => {
    const colour: Color = choice === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : choice === 'white' ? 'w' : 'b';
    runRef.current += 1;
    chessRef.current = new Chess();
    playerColorRef.current = colour;
    setPlayerColor(colour);
    setFen(START_FEN);
    setHistory([]);
    setOutcome(null);
    setHint(null);
    setReview(null);
    setThinking(false);
    setEvaluation({ cp: 0, mate: null });
    setPhase('playing');
    if (colour === 'b') {
      setThinking(true);
      const run = runRef.current;
      // Let the starting position paint before the first engine search.
      window.setTimeout(() => { if (run === runRef.current) void engineMove(); }, 80);
    }
  }, [engineMove]);

  const onPlayerMove = useCallback((from: string, to: string, promotion?: string) => {
    const chess = chessRef.current;
    if (phase !== 'playing' || chess.turn() !== playerColorRef.current) return;
    let move = null;
    try { move = chess.move({ from: from as Square, to: to as Square, promotion }); } catch { move = null; }
    if (!move) { toast.info('Illegal move', 'That move is not legal in this position.'); return; }
    setHint(null);
    setReview(null);
    publish();
    if (checkGameOver()) return;
    setThinking(true);
    const run = runRef.current;
    window.setTimeout(() => { if (run === runRef.current) void engineMove(); }, 120);
  }, [phase, publish, checkGameOver, engineMove, toast]);

  const takeback = useCallback(() => {
    const chess = chessRef.current;
    if (!chess.history().length) return;
    runRef.current += 1;
    setThinking(false);
    setHint(null);
    setReview(null);
    setOutcome(null);
    setPhase('playing');
    // Rewind to the position before the player's last move.
    for (let guard = 0; guard < 6 && chess.history().length && chess.turn() !== playerColorRef.current; guard++) chess.undo();
    if (chess.history().length) chess.undo();
    publish();
  }, [publish]);

  const requestHint = useCallback(async () => {
    const chess = chessRef.current;
    if (phase !== 'playing' || chess.turn() !== playerColorRef.current) return;
    setBusyAction('hint');
    const position = chess.fen();
    try {
      const result = await analyseRef.current({ fen: position, ...coachRequest(13, 700), multipv: 1 });
      if (result.bestMove) setHint({ uci: result.bestMove, san: sanFor(position, result.bestMove), fen: position });
      else toast.info('No hint available', 'The engine returned no move for this position.');
    } catch (error) {
      toast.error('Hint failed', (error as Error).message);
    } finally { setBusyAction(null); }
  }, [phase, toast]);

  const reviewLastMove = useCallback(async () => {
    const index = history.map((move) => move.by).lastIndexOf('player');
    if (index < 0) { toast.info('Nothing to review yet', 'Make a move first.'); return; }
    const played = history[index];
    const before = index === 0 ? START_FEN : history[index - 1].fenAfter;
    setBusyAction('review');
    try {
      const result = await analyseRef.current({ fen: before, ...coachRequest(13, 800), multipv: 1 });
      const bestSan = result.bestMove ? sanFor(before, result.bestMove) : null;
      const wasBest = result.bestMove === played.uci || (bestSan !== null && bestSan === played.san);
      setReview({ played: played.san, bestSan });
      if (wasBest) toast.success('That was the engine’s choice', `${played.san} is the top move here.`);
    } catch (error) {
      toast.error('Review failed', (error as Error).message);
    } finally { setBusyAction(null); }
  }, [history, toast]);

  const resign = useCallback(() => {
    if (phase !== 'playing') return;
    runRef.current += 1;
    setThinking(false);
    setPhase('over');
    setOutcome({ won: false, title: 'You resigned', detail: 'Start again, or take the moves into Analysis to see where it turned.' });
  }, [phase]);

  const pgn = useMemo(() => {
    const chess = new Chess();
    for (const record of history) {
      const parsed = parseUciMove(record.uci);
      if (!parsed) continue;
      try {
        chess.move({ from: parsed.from as Square, to: parsed.to as Square, promotion: parsed.promotion });
      } catch { break; }
    }
    chess.setHeader('Event', 'Practice against Stockfish');
    chess.setHeader('Site', 'Rookstone Arena');
    chess.setHeader('White', playerColor === 'w' ? 'You' : `Stockfish level ${level.id}`);
    chess.setHeader('Black', playerColor === 'b' ? 'You' : `Stockfish level ${level.id}`);
    return chess.pgn({ maxWidth: 78 });
  }, [history, playerColor, level.id]);

  const copyPgn = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(pgn);
      toast.success('PGN copied', 'Paste it into the analysis board or any chess program.');
    } catch {
      toast.error('Could not copy', 'Your browser blocked clipboard access. Select the moves and copy them manually.');
    }
  }, [pgn, toast]);

  const engineName = engine.engineName || 'Stockfish 19';
  const barPercent = evalBarPercent(evaluation.cp);
  const playerIsWhite = playerColor === 'w';
  const opponent = `Engine · level ${level.id} · ${level.name}`;
  const topLabel = playerIsWhite ? opponent : 'You';
  const bottomLabel = playerIsWhite ? 'You' : opponent;

  return (
    <div className="container">
      <PageHeader
        eyebrow="Training"
        title="Play the engine"
        description="A real Stockfish 19 build plays against you in your browser at eight strengths. Practice games are never rated, never staked and never touch your wallet — use them to learn an opening, drill an endgame or warm up before a rated game."
        actions={<Link className="btn btn-ghost btn-sm" to="/analysis"><Icon name="analysis" size={16} /> Analysis board</Link>}
      />

      {engine.status === 'error' && (
        <div className="alert alert-danger" style={{ marginBottom: '1rem' }}>
          <strong>The engine could not start.</strong>
          <div className="small">{engine.error}</div>
          <div className="tiny muted">Reload the page to retry — practice and analysis both need the bundled WebAssembly engine.</div>
        </div>
      )}

      <div className="board-stage">
        <div className="board-column">
          <div className="train-player"><span className={`turn-dot ${phase === 'playing' && !isPlayerTurn ? 'live' : ''}`} aria-hidden="true" />{topLabel}</div>
          <ChessBoard
            fen={fen}
            orientation={playerIsWhite ? 'white' : 'black'}
            onMove={isPlayerTurn ? onPlayerMove : undefined}
            disabled={!isPlayerTurn}
            lastMove={lastMove}
            arrows={arrows}
            onIllegal={(message) => toast.info('Illegal move', message)}
          />
          <div className="train-player"><span className={`turn-dot ${isPlayerTurn ? 'live' : ''}`} aria-hidden="true" />{bottomLabel}</div>

          <div className="board-actions" style={{ marginTop: '.85rem' }}>
            <button className="btn btn-primary btn-sm" onClick={() => startGame(colourChoice)} disabled={thinking && phase === 'playing'}>
              <Icon name="play" size={16} /> {phase === 'idle' ? 'Start practice' : 'New game'}
            </button>
            <button className="btn btn-sm" onClick={takeback} disabled={!history.length || (thinking && phase === 'playing')}>
              <Icon name="arrowLeft" size={16} /> Takeback
            </button>
            <button className="btn btn-sm" onClick={() => void requestHint()} disabled={!isPlayerTurn || busyAction !== null}>
              <Icon name="spark" size={16} /> {busyAction === 'hint' ? 'Searching…' : 'Hint'}
            </button>
            <button className="btn btn-sm" onClick={() => void reviewLastMove()} disabled={!history.length || busyAction !== null}>
              <Icon name="info" size={16} /> {busyAction === 'review' ? 'Reviewing…' : 'Review last move'}
            </button>
            <button className="btn btn-sm" onClick={resign} disabled={phase !== 'playing'}>
              <Icon name="flag" size={16} /> Resign
            </button>
          </div>
        </div>

        <aside className="stack">
          {phase === 'idle' ? (
            <section className="card">
              <h2 className="card-title">Choose an opponent</h2>
              <p className="small soft">Lower levels blunder on purpose, so you get real chances to convert. Levels 7 and 8 play at full strength.</p>
              <div className="level-grid" role="group" aria-label="Engine strength">
                {ENGINE_LEVELS.map((entry) => (
                  <button key={entry.id} type="button" className="level-option" aria-pressed={levelId === entry.id}
                    onClick={() => setLevelId(entry.id)}>
                    <span className="level-number">{entry.id}</span>
                    <span className="level-name">{entry.name}</span>
                    <span className="level-rating">≈{entry.rating}</span>
                  </button>
                ))}
              </div>
              <p className="tiny muted" style={{ marginBottom: 0 }}>{level.note}</p>
              <div className="segmented" role="group" aria-label="Play as">
                {(['white', 'black', 'random'] as const).map((option) => (
                  <button key={option} type="button" aria-pressed={colourChoice === option} onClick={() => setColourChoice(option)}>
                    {option === 'white' ? 'White' : option === 'black' ? 'Black' : 'Random'}
                  </button>
                ))}
              </div>
              <button className="btn btn-primary btn-block" onClick={() => startGame(colourChoice)}>
                <Icon name="play" size={16} /> Start at level {level.id} · ≈{level.rating}
              </button>
              <p className="tiny muted" style={{ marginBottom: 0 }}>{engineName} · {engine.status === 'ready' || engine.status === 'analysing' ? 'ready' : engine.status}</p>
            </section>
          ) : (
            <section className="card">
              <div className="card-header"><h2 className="card-title">Position</h2>
                <span className={`pill ${thinking ? 'pill-accent' : 'pill-teal'}`}>{thinking ? 'Engine thinking…' : isPlayerTurn ? 'Your move' : 'Engine'}</span></div>
              <div className="eval-bar" role="img" aria-label={`Evaluation ${evalLabel(evaluation.cp, evaluation.mate)} for White`}>
                <div className="eval-fill" style={{ width: `${barPercent}%` }} />
                <span className="eval-number">{evalLabel(evaluation.cp, evaluation.mate)}</span>
              </div>
              <div className="tiny muted">The engine's last search, shown from White's point of view.</div>
              {outcome && (
                <div className={`alert ${outcome.won ? '' : 'alert-warning'}`} role="status">
                  <strong>{outcome.title}</strong>
                  <div className="small">{outcome.detail}</div>
                </div>
              )}
              {review && (
                <div className="alert" role="status">
                  <strong>Move review</strong>
                  <div className="small">You played <strong>{review.played}</strong>. The engine preferred <strong>{review.bestSan ?? 'another move'}</strong>.</div>
                </div>
              )}
              {hint && hint.fen === fen && (
                <div className="alert" role="status">
                  <strong>Hint</strong>
                  <div className="small">The engine suggests <strong>{hint.san ?? hint.uci}</strong>. The arrow shows it on the board.</div>
                </div>
              )}
              <div className="row-wrap">
                <button className="btn btn-sm" onClick={() => startGame(colourChoice)} disabled={thinking && phase === 'playing'}>Rematch</button>
                <Link className="btn btn-sm" to="/analysis"><Icon name="analysis" size={16} /> Analyse</Link>
                <button className="btn btn-sm" onClick={() => void copyPgn()} disabled={!history.length}>Copy PGN</button>
              </div>
            </section>
          )}

          <section className="card">
            <div className="card-header"><h2 className="card-title">Moves</h2><span className="pill">{Math.ceil(history.length / 2)}</span></div>
            {history.length === 0
              ? <p className="small muted" style={{ margin: 0 }}>Moves appear here in algebraic notation once the game starts.</p>
              : (
                <ol className="train-moves">
                  {history.map((record, index) => (
                    <li key={`${record.uci}-${index}`} className={record.by === 'player' ? 'mine' : ''}>
                      <span className="tiny muted">{Math.floor(index / 2) + 1}{index % 2 === 0 ? '.' : '…'}</span>
                      <span className="mono small">{record.san}</span>
                      {record.by === 'player' && <span className="tiny muted">you</span>}
                    </li>
                  ))}
                </ol>
              )}
          </section>
        </aside>
      </div>

      <section className="card" style={{ marginTop: '1.5rem' }}>
        <h2 className="card-title">How practice works</h2>
        <ul className="small soft" style={{ paddingLeft: '1.1rem', marginBottom: 0 }}>
          <li>The opponent is the same GPL-licensed Stockfish 19 WebAssembly build used by the analysis board — no scripted or fake moves.</li>
          <li>Strength uses the engine's own <code>Skill Level</code> option plus a depth and think-time limit. The three lowest levels also play deliberate random legal moves so the game feels human.</li>
          <li>Practice runs entirely in your browser. It is never submitted to the server, never rated, never staked and never recorded against your account.</li>
          <li>Hint and <em>Review last move</em> always search at full strength, so the coaching is honest even when the opponent is not.</li>
        </ul>
      </section>
    </div>
  );
}
