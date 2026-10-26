import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Chess, type Square } from 'chess.js';
import type { Arrow } from 'react-chessboard';
import { ChessBoard } from '../features/chess/ChessBoard';
import { EnginePanel, type EngineResultView } from '../features/engine/EnginePanel';
import { BOARD_THEMES, PIECE_THEMES, usePreferences } from '../app/ThemeProvider';
import { useToast } from '../app/ToastProvider';
import { PageHeader } from '../components/PageHeader';
import { Icon } from '../components/Icon';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

interface HistoryEntry extends EngineResultView { at: string; ply: number }

function replay(baseFen: string, moves: string[], ply: number) {
  const chess = new Chess();
  try { if (baseFen !== START_FEN) chess.load(baseFen); } catch { /* caller validates */ }
  const sans: string[] = [];
  for (const uci of moves.slice(0, ply)) {
    const move = chess.move({ from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square, promotion: uci[4] });
    if (!move) break;
    sans.push(move.san);
  }
  return { chess, fen: chess.fen(), sans };
}

function EvalGraph({ history }: { history: HistoryEntry[] }) {
  const points = history.filter((h) => h.scoreCp !== null || h.mate !== null).slice(-40);
  if (points.length < 2) return <div className="rating-chart" style={{ display: 'grid', placeItems: 'center', textAlign: 'center' }}><span className="small muted">Run analyses at two or more positions to build a real evaluation graph.</span></div>;
  const width = 600, height = 160;
  const coords = points.map((point, index) => {
    const score = point.mate !== null ? (point.mate > 0 ? 1000 : -1000) : point.scoreCp ?? 0;
    const clamped = Math.max(-1000, Math.min(1000, score));
    return `${(index / Math.max(1, points.length - 1)) * width},${height / 2 - (clamped / 1000) * (height / 2 - 10)}`;
  }).join(' ');
  return (
    <svg className="rating-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Evaluation graph derived from actual Stockfish results">
      <line x1="0" y1={height / 2} x2={width} y2={height / 2} stroke="var(--border)" />
      <polyline points={coords} fill="none" stroke="var(--accent)" strokeWidth="3" strokeLinejoin="round" />
      {points.map((point, index) => {
        const [x, y] = coords.split(' ')[index].split(',');
        return <circle key={`${point.at}-${index}`} cx={x} cy={y} r="3" fill="var(--teal)" />;
      })}
    </svg>
  );
}

export function AnalysisPage() {
  const [params] = useSearchParams();
  const prefs = usePreferences();
  const toast = useToast();
  const initialFen = params.get('fen');
  const [baseFen, setBaseFen] = useState(() => {
    if (!initialFen) return START_FEN;
    try { new Chess(initialFen); return initialFen; } catch { return START_FEN; }
  });
  const [moves, setMoves] = useState<string[]>([]);
  const [replayPly, setReplayPly] = useState(0);
  const [fenInput, setFenInput] = useState(baseFen);
  const [pgnInput, setPgnInput] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [arrows, setArrows] = useState<Arrow[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  const current = useMemo(() => replay(baseFen, moves, replayPly), [baseFen, moves, replayPly]);
  const full = useMemo(() => replay(baseFen, moves, moves.length), [baseFen, moves]);
  const legalMoves = useMemo(() => current.chess.moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion ?? '')), [current.chess]);
  const pgn = useMemo(() => {
    const chess = replay(baseFen, moves, moves.length).chess;
    chess.setHeader('Event', 'Rookstone Arena analysis');
    chess.setHeader('Site', 'Rookstone Arena');
    return chess.pgn();
  }, [baseFen, moves]);

  const onResult = useCallback((result: EngineResultView) => {
    setHistory((list) => {
      const ply = replayPly;
      const duplicate = list.some((item) => item.fen === result.fen && item.depth === result.depth && item.bestMove === result.bestMove && item.ply === ply);
      if (duplicate) return list;
      return [...list.slice(-49), { ...result, ply, at: new Date().toISOString() }];
    });
  }, [replayPly]);

  const onMove = (from: string, to: string, promotion?: string) => {
    const chess = replay(baseFen, moves, replayPly).chess;
    const move = chess.move({ from: from as Square, to: to as Square, promotion });
    if (!move) { toast.error('Illegal move', 'That move is not legal in this position.'); return; }
    const uci = move.from + move.to + (move.promotion ?? '');
    setMoves((list) => [...list.slice(0, replayPly), uci]);
    setReplayPly(replayPly + 1);
  };

  const loadFen = () => {
    try { new Chess(fenInput); setBaseFen(fenInput); setMoves([]); setReplayPly(0); setImportError(null); }
    catch { setImportError('This FEN is not a valid legal chess position.'); }
  };

  const importPgn = () => {
    try {
      const chess = new Chess();
      chess.loadPgn(pgnInput);
      const headers = chess.getHeaders() as Record<string, string>;
      const importedBase = headers.SetUp === '1' && headers.FEN ? headers.FEN : START_FEN;
      const importedMoves = chess.history({ verbose: true }).map((m) => m.from + m.to + (m.promotion ?? ''));
      const check = replay(importedBase, importedMoves, importedMoves.length);
      if (importedMoves.length && check.sans.length !== importedMoves.length) throw new Error('Some PGN moves could not be replayed from the starting position.');
      setBaseFen(importedBase); setMoves(importedMoves); setReplayPly(importedMoves.length);
      setFenInput(importedBase); setImportError(null);
      toast.success('PGN imported', `${importedMoves.length} moves loaded from the supplied notation.`);
    } catch (error) { setImportError(error instanceof Error ? error.message : 'Could not import PGN'); }
  };

  const copy = async (value: string, label: string) => {
    try { await navigator.clipboard.writeText(value); toast.success(`${label} copied`); }
    catch { toast.error('Clipboard unavailable'); }
  };

  const lastMove = replayPly > 0 && moves[replayPly - 1]
    ? { from: moves[replayPly - 1].slice(0, 2), to: moves[replayPly - 1].slice(2, 4) } : null;

  return (
    <div className="container">
      <PageHeader eyebrow="Analysis" title="Analysis board" description="Import a FEN or PGN, explore variations and run the genuine Stockfish 19 WASM engine. Every evaluation shown comes from a real UCI result."
        actions={<span className="pill pill-teal">GPL-3.0 Stockfish UCI</span>} />

      <div className="board-stage">
        <div className="board-column">
          <ChessBoard fen={current.fen} legalMoves={legalMoves} lastMove={lastMove} onMove={onMove}
            onIllegal={(message) => toast.info('Illegal move', message)} arrows={arrows} allowArrows />
          <div className="card" style={{ marginTop: '1rem' }}>
            <div className="card-header"><h2 className="card-title">Moves &amp; notation</h2><span className="pill">Ply {replayPly} / {moves.length}</span></div>
            <div className="replay-controls" role="group" aria-label="Analysis replay controls">
              <button className="btn btn-icon btn-sm" onClick={() => setReplayPly(0)} aria-label="Start"><Icon name="first" size={16} /></button>
              <button className="btn btn-icon btn-sm" onClick={() => setReplayPly((p) => Math.max(0, p - 1))} aria-label="Previous"><Icon name="arrowLeft" size={16} /></button>
              <button className="btn btn-icon btn-sm" onClick={() => setReplayPly((p) => Math.min(moves.length, p + 1))} aria-label="Next"><Icon name="arrowRight" size={16} /></button>
              <button className="btn btn-icon btn-sm" onClick={() => setReplayPly(moves.length)} aria-label="End"><Icon name="last" size={16} /></button>
            </div>
            <div className="move-list" style={{ marginTop: '.75rem', maxHeight: 180 }}>
              {moves.length === 0 && <p className="small muted">No moves yet. Play a move on the board or import a PGN.</p>}
              {Array.from({ length: Math.ceil(full.sans.length / 2) }, (_, index) => (
                <div className="move-row" key={index}>
                  <span className="move-number">{index + 1}.</span>
                  {[0, 1].map((offset) => {
                    const ply = index * 2 + offset + 1;
                    return full.sans[ply - 1] ? <button key={ply} className={`move-cell ${replayPly === ply ? 'active' : ''}`} onClick={() => setReplayPly(ply)}>{full.sans[ply - 1]}</button> : <span className="move-cell" />;
                  })}
                </div>
              ))}
            </div>
            <div className="row-wrap" style={{ marginTop: '.75rem' }}>
              <button className="btn btn-sm" onClick={() => void copy(pgn, 'PGN')}><Icon name="copy" size={15} /> Copy PGN</button>
              <button className="btn btn-sm" onClick={() => void copy(current.fen, 'FEN')}>Copy FEN</button>
              <button className="btn btn-sm" onClick={() => { setFenInput(current.fen); setBaseFen(current.fen); setMoves([]); setReplayPly(0); }}>Analyse from here</button>
            </div>
            <details style={{ marginTop: '.75rem' }}><summary className="small">Show notation strings</summary>
              <label className="field" style={{ marginTop: '.5rem' }}><span className="field-label">PGN</span><textarea className="textarea pgn-box" readOnly value={pgn} /></label>
              <label className="field"><span className="field-label">FEN</span><input className="input mono small" readOnly value={current.fen} /></label>
            </details>
          </div>
        </div>

        <div className="sidebar">
          <EnginePanel fen={current.fen} moves={moves.slice(0, replayPly)} onArrowsChange={setArrows} onResult={onResult} />

          <section className="card">
            <div className="card-header"><h2 className="card-title">Evaluation graph</h2><span className="pill">{history.length} real results</span></div>
            <EvalGraph history={history} />
            <div className="table-wrap" style={{ marginTop: '.75rem', maxHeight: 180, overflowY: 'auto' }}>
              <table className="table"><thead><tr><th>Ply</th><th>Score</th><th>Best</th><th>Depth</th></tr></thead>
                <tbody>{history.slice(-8).reverse().map((item, index) => <tr key={`${item.at}-${index}`}>
                  <td>{item.ply}</td><td>{item.mate !== null ? `M${Math.abs(item.mate)}` : item.scoreCp !== null ? `${(item.scoreCp / 100).toFixed(2)}` : '—'}</td>
                  <td className="mono">{item.bestMove ?? '—'}</td><td>{item.depth || '—'}</td></tr>)}</tbody></table>
            </div>
            {history.length === 0 && <p className="tiny muted" style={{ marginBottom: 0 }}>No evaluation history. Run the engine to populate this table.</p>}
          </section>

          <section className="card">
            <div className="card-header"><h2 className="card-title">Position &amp; board editor</h2></div>
            <div className="stack">
              <label className="field"><span className="field-label">FEN</span><textarea className="textarea pgn-box" value={fenInput} onChange={(e) => setFenInput(e.target.value)} aria-label="FEN position" /></label>
              {importError && <div className="alert alert-danger small">{importError}</div>}
              <div className="row-wrap"><button className="btn btn-sm btn-primary" onClick={loadFen}>Load FEN</button>
                <button className="btn btn-sm" onClick={() => { setBaseFen(START_FEN); setFenInput(START_FEN); setMoves([]); setReplayPly(0); }}>Starting position</button></div>
              <label className="field"><span className="field-label">Import PGN</span><textarea className="textarea pgn-box" value={pgnInput} onChange={(e) => setPgnInput(e.target.value)} placeholder="1. e4 e5 2. Nf3 Nc6" /></label>
              <button className="btn btn-sm" onClick={importPgn} disabled={!pgnInput.trim()}>Import PGN</button>
            </div>
          </section>

          <section className="card">
            <div className="card-header"><h2 className="card-title">Board settings</h2></div>
            <div className="stack" style={{ gap: '.6rem' }}>
              <label className="checkbox"><input type="checkbox" checked={prefs.showCoordinates} onChange={(e) => prefs.set('showCoordinates', e.target.checked)} /> Show coordinates</label>
              <label className="checkbox"><input type="checkbox" checked={prefs.showLegalMoves} onChange={(e) => prefs.set('showLegalMoves', e.target.checked)} /> Highlight legal moves</label>
              <label className="checkbox"><input type="checkbox" checked={prefs.animations && !prefs.reducedMotion} disabled={prefs.reducedMotion} onChange={(e) => prefs.set('animations', e.target.checked)} /> Piece animations {prefs.reducedMotion && <span className="tiny muted">(reduced motion active)</span>}</label>
              <label className="field"><span className="field-label">Board theme</span>
                <select className="select" value={prefs.boardTheme} onChange={(e) => prefs.set('boardTheme', e.target.value as typeof prefs.boardTheme)}>
                  {BOARD_THEMES.map((theme) => <option key={theme.id} value={theme.id}>{theme.label}</option>)}
                </select></label>
              <label className="field"><span className="field-label">Piece theme</span>
                <select className="select" value={prefs.pieceTheme} onChange={(e) => prefs.set('pieceTheme', e.target.value as typeof prefs.pieceTheme)}>
                  {PIECE_THEMES.map((theme) => <option key={theme.id} value={theme.id}>{theme.label}</option>)}
                </select></label>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
