import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Arrow } from 'react-chessboard';
import { api, errorMessage } from '../../lib/api';
import { useToast } from '../../app/ToastProvider';
import { Icon } from '../../components/Icon';
import { useStockfish, type BrowserEngineResult } from './useStockfish';

export interface EngineResultView {
  fen: string;
  moves: string[];
  bestMove: string | null;
  scoreCp: number | null;
  mate: number | null;
  depth: number;
  pv: string[];
  engine: string;
}

interface EnginePanelProps {
  fen: string;
  moves: string[];
  onArrowsChange?: (arrows: Arrow[]) => void;
  onResult?: (result: EngineResultView) => void;
  compact?: boolean;
}

function scoreLabel(result: BrowserEngineResult | null, server: Record<string, unknown> | null): string {
  const scoreCp = result?.scoreCp ?? (typeof server?.scoreCp === 'number' ? server.scoreCp : null);
  const mate = result?.mate ?? (typeof server?.mate === 'number' ? server.mate : null);
  if (mate !== null && mate !== undefined) return `Mate in ${Math.abs(mate)} for ${mate > 0 ? 'the side to move' : 'the opponent'}`;
  if (scoreCp === null) return 'No evaluation yet';
  const pawns = scoreCp / 100;
  return `${pawns > 0 ? '+' : ''}${pawns.toFixed(2)} for the side to move`;
}

function evalPercent(result: BrowserEngineResult | null, server: Record<string, unknown> | null): number {
  const scoreCp = result?.scoreCp ?? (typeof server?.scoreCp === 'number' ? server.scoreCp : null);
  const mate = result?.mate ?? (typeof server?.mate === 'number' ? server.mate : null);
  if (mate !== null && mate !== undefined) return mate > 0 ? 100 : 0;
  if (scoreCp === null) return 50;
  return Math.max(2, Math.min(98, 50 + Math.tanh(scoreCp / 400) * 48));
}

export function EnginePanel({ fen, moves, onArrowsChange, onResult, compact = false }: EnginePanelProps) {
  const engine = useStockfish();
  const toast = useToast();
  const [depth, setDepth] = useState(14);
  const [timeMs, setTimeMs] = useState(900);
  const [multipv, setMultipv] = useState(3);
  const [auto, setAuto] = useState(false);
  const [serverResult, setServerResult] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);

  const request = useCallback(async () => {
    setBusy(true);
    try {
      const result = await engine.analyse({ fen, moves, depth, timeMs, multipv });
      setServerResult(null);
      if (result.bestMove && onArrowsChange) {
        onArrowsChange([{ startSquare: result.bestMove.slice(0, 2), endSquare: result.bestMove.slice(2, 4), color: '#d8b46a' }]);
      }
    } catch (error) {
      toast.error('Analysis failed', errorMessage(error));
    } finally { setBusy(false); }
  }, [engine, fen, moves, depth, timeMs, multipv, onArrowsChange, toast]);

  useEffect(() => {
    if (!auto || engine.status !== 'ready') return;
    const timer = window.setTimeout(() => { void request(); }, 180);
    return () => window.clearTimeout(timer);
    // request changes with engine state; auto analysis is intentionally debounced.
  }, [auto, fen, moves.join(' '), depth, timeMs, multipv, engine.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const serverAnalyse = useCallback(async () => {
    setBusy(true);
    try {
      const result = await api<Record<string, unknown>>('/analysis', {
        method: 'POST', body: { fen, moves, depth, timeMs, multipv },
      });
      setServerResult(result);
      if (typeof result.bestMove === 'string' && onArrowsChange) {
        onArrowsChange([{ startSquare: result.bestMove.slice(0, 2), endSquare: result.bestMove.slice(2, 4), color: '#d8b46a' }]);
      }
    } catch (error) { toast.error('Server analysis failed', errorMessage(error)); }
    finally { setBusy(false); }
  }, [fen, moves, depth, timeMs, multipv, onArrowsChange, toast]);

  useEffect(() => {
    if (!onResult) return;
    const source = engine.result ?? serverResult;
    if (!source) return;
    const record = source as Record<string, unknown>;
    const resultView: EngineResultView = {
      fen, moves,
      bestMove: typeof record.bestMove === 'string' ? record.bestMove : null,
      scoreCp: typeof record.scoreCp === 'number' ? record.scoreCp : null,
      mate: typeof record.mate === 'number' ? record.mate : null,
      depth: typeof record.depth === 'number' ? record.depth : 0,
      pv: Array.isArray(record.pv) ? record.pv as string[] : [],
      engine: typeof record.engine === 'string' ? record.engine : engine.engineName || 'Stockfish UCI',
    };
    onResult(resultView);
  }, [engine.result, serverResult]); // eslint-disable-line react-hooks/exhaustive-deps

  const lines = useMemo(() => {
    const browserLines = engine.result?.lines.map((line) => ({
      multipv: line.multipv,
      score: line.mate !== null ? `M${Math.abs(line.mate)}` : line.scoreCp !== null ? `${line.scoreCp > 0 ? '+' : ''}${(line.scoreCp / 100).toFixed(2)}` : '—',
      pv: line.pv.join(' '),
    })) ?? [];
    if (browserLines.length) return browserLines;
    if (Array.isArray(serverResult?.lines)) {
      return (serverResult.lines as Array<Record<string, unknown>>).map((line) => ({
        multipv: Number(line.multipv ?? 1),
        score: line.mate ? `M${Math.abs(Number(line.mate))}` : `${((Number(line.scoreCp) || 0) / 100).toFixed(2)}`,
        pv: Array.isArray(line.pv) ? (line.pv as string[]).join(' ') : '',
      }));
    }
    return [];
  }, [engine.result, serverResult]);

  const bestMove = engine.result?.bestMove ?? (typeof serverResult?.bestMove === 'string' ? serverResult.bestMove : null);
  const engineDepth = engine.result?.depth ?? (typeof serverResult?.depth === 'number' ? serverResult.depth : 0);
  const nodes = engine.result?.nodes ?? (typeof serverResult?.nodes === 'number' ? serverResult.nodes : null);
  const nps = engine.result?.nps ?? (typeof serverResult?.nps === 'number' ? serverResult.nps : null);
  const engineName = engine.result?.engine ?? (typeof serverResult?.engine === 'string' ? serverResult.engine : engine.engineName);

  return (
    <section className="card" aria-labelledby="engine-title">
      <div className="card-header">
        <div>
          <h2 className="card-title" id="engine-title"><Icon name="spark" size={18} /> Genuine Stockfish analysis</h2>
          <p className="card-subtitle">{engineName || 'Waiting for UCI handshake…'} · GPL-3.0 WASM</p>
        </div>
        <span className={`pill ${engine.status === 'error' ? 'pill-danger' : engine.status === 'ready' ? 'pill-success' : 'pill-accent'}`}>
          {engine.status === 'ready' ? 'Ready' : engine.status === 'error' ? 'Unavailable' : engine.status}
        </span>
      </div>

      <div className="stack">
        <div>
          <div className="spread small"><span>Evaluation</span><strong>{scoreLabel(engine.result, serverResult)}</strong></div>
          <div className="eval-bar" aria-label="Evaluation bar"><div className="eval-fill" style={{ width: `${evalPercent(engine.result, serverResult)}%` }} /></div>
          <div className="eval-scale"><span>Black</span><span>Equal</span><span>White</span></div>
        </div>

        <div className="grid-2">
          <div className="stat"><div className="stat-label">Best move</div><div className="stat-value mono" style={{ fontSize: '1.1rem' }}>{bestMove ?? '—'}</div></div>
          <div className="stat"><div className="stat-label">Depth / nodes</div><div className="stat-value mono" style={{ fontSize: '1.1rem' }}>{engineDepth || '—'}</div><div className="stat-foot">{nodes ? `${nodes.toLocaleString()} nodes` : '—'}{nps ? ` · ${nps.toLocaleString()} nps` : ''}</div></div>
        </div>

        {!compact && (
          <>
            <div className="row-wrap">
              <label className="field grow" style={{ minWidth: 100 }}>
                <span className="field-label">Depth {depth}</span>
                <input className="input" type="range" min="4" max="22" value={depth} onChange={(e) => setDepth(Number(e.target.value))} />
              </label>
              <label className="field grow" style={{ minWidth: 100 }}>
                <span className="field-label">Time {timeMs} ms</span>
                <input className="input" type="range" min="100" max="4000" step="100" value={timeMs} onChange={(e) => setTimeMs(Number(e.target.value))} />
              </label>
              <label className="field" style={{ minWidth: 90 }}>
                <span className="field-label">Lines</span>
                <select className="select" value={multipv} onChange={(e) => setMultipv(Number(e.target.value))}>
                  {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
            </div>
            <div className="row-wrap">
              <button className="btn btn-primary btn-sm" onClick={() => void request()} disabled={engine.status === 'error' || busy || engine.status === 'loading'}>
                {busy ? <span className="loading" /> : <Icon name="play" size={16} />} {busy ? 'Analysing…' : 'Analyse position'}
              </button>
              <button className="btn btn-sm" onClick={engine.stop} disabled={!busy}><Icon name="pause" size={16} /> Stop</button>
              <button className="btn btn-sm" onClick={engine.reset}>Clear</button>
              <label className="checkbox"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Auto</label>
              <button className="btn btn-sm" onClick={() => void serverAnalyse()} disabled={busy}>Server fallback</button>
            </div>
            <div className="stack" style={{ gap: 0 }}>
              {lines.length === 0 && <p className="small muted">No evaluation has been produced yet. Choose “Analyse position” to run the real UCI engine.</p>}
              {lines.map((line) => (
                <div className="engine-line" key={`${line.multipv}-${line.pv}`}>
                  <span className="mono">{line.score}</span>
                  <span className="mono soft" style={{ overflowWrap: 'anywhere' }}>{line.pv || '—'}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {engine.error && <div className="alert alert-danger"><strong>Browser engine error.</strong> {engine.error} Use the server fallback or check that the GPL WASM assets are deployed.</div>}
        <p className="tiny muted" style={{ margin: 0 }}>
          Engine: <a href={engine.source.upstream} target="_blank" rel="noreferrer">official Stockfish</a> via{' '}
          <a href={engine.source.port} target="_blank" rel="noreferrer">nmrugg/stockfish.js</a>, {engine.source.licence}. No evaluation is fabricated.
        </p>
      </div>
    </section>
  );
}
