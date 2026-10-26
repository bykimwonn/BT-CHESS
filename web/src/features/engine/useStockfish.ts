import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface BrowserEngineLine {
  multipv: number;
  depth: number;
  scoreCp: number | null;
  mate: number | null;
  pv: string[];
}

export interface BrowserEngineResult {
  bestMove: string | null;
  ponder: string | null;
  depth: number;
  scoreCp: number | null;
  mate: number | null;
  pv: string[];
  lines: BrowserEngineLine[];
  nodes: number | null;
  nps: number | null;
  engine: string;
}

export interface AnalyseInput {
  fen: string;
  moves?: string[];
  depth?: number;
  timeMs?: number;
  multipv?: number;
}

type EngineStatus = 'loading' | 'ready' | 'analysing' | 'error';

const ENGINE_URL = '/engine/stockfish-19-lite-single.js';
export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function parseInfo(line: string): BrowserEngineLine | null {
  if (!line.startsWith('info ') || !line.includes(' pv ')) return null;
  const tokens = line.split(/\s+/);
  const get = (key: string) => {
    const index = tokens.indexOf(key);
    return index >= 0 ? tokens[index + 1] : undefined;
  };
  const scoreIndex = tokens.indexOf('score');
  const type = scoreIndex >= 0 ? tokens[scoreIndex + 1] : undefined;
  const value = scoreIndex >= 0 ? Number(tokens[scoreIndex + 2]) : NaN;
  const pvIndex = tokens.indexOf('pv');
  return {
    multipv: Number(get('multipv') ?? 1),
    depth: Number(get('depth') ?? 0),
    scoreCp: type === 'cp' && Number.isFinite(value) ? value : null,
    mate: type === 'mate' && Number.isFinite(value) ? value : null,
    pv: pvIndex >= 0 ? tokens.slice(pvIndex + 1).filter((m) => /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(m)) : [],
  };
}

export function useStockfish() {
  const workerRef = useRef<Worker | null>(null);
  const readyRef = useRef<Promise<void> | null>(null);
  const requestRef = useRef<{
    id: number;
    resolve: (result: BrowserEngineResult) => void;
    reject: (error: Error) => void;
    lines: BrowserEngineLine[];
    engine: string;
    nodes: number | null;
    nps: number | null;
    timer: number;
  } | null>(null);
  const [status, setStatus] = useState<EngineStatus>('loading');
  const [engineName, setEngineName] = useState<string>('');
  const [result, setResult] = useState<BrowserEngineResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const boot = useCallback(() => {
    if (workerRef.current) return;
    const worker = new Worker(ENGINE_URL);
    workerRef.current = worker;
    setStatus('loading');
    const ready = new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('Stockfish did not complete its UCI handshake')), 12_000);
      worker.onerror = (event) => {
        window.clearTimeout(timeout);
        setError(event.message || 'Stockfish worker failed to load');
        setStatus('error');
        reject(new Error(event.message || 'Stockfish worker failed to load'));
      };
      worker.onmessage = (event: MessageEvent<string>) => {
        const line = String(event.data);
        if (line.startsWith('id name ')) setEngineName(line.slice(8));
        const req = requestRef.current;
        if (req) {
          const info = parseInfo(line);
          if (info) {
            const existing = req.lines.findIndex((l) => l.multipv === info.multipv);
            if (existing >= 0) req.lines[existing] = info; else req.lines.push(info);
          }
          const nodeMatch = / nodes (\d+)/.exec(line);
          const npsMatch = / nps (\d+)/.exec(line);
          if (nodeMatch) req.nodes = Number(nodeMatch[1]);
          if (npsMatch) req.nps = Number(npsMatch[1]);
          if (line.startsWith('bestmove ')) {
            window.clearTimeout(req.timer);
            const parts = line.split(/\s+/);
            const bestMove = parts[1] && parts[1] !== '0000' && parts[1] !== '(none)' ? parts[1] : null;
            const lines = [...req.lines].sort((a, b) => a.multipv - b.multipv);
            const best = lines[0] ?? null;
            const payload: BrowserEngineResult = {
              bestMove,
              ponder: parts[3] && parts[3] !== '0000' ? parts[3] : null,
              depth: best?.depth ?? 0,
              scoreCp: best?.scoreCp ?? null,
              mate: best?.mate ?? null,
              pv: best?.pv ?? (bestMove ? [bestMove] : []),
              lines,
              nodes: req.nodes,
              nps: req.nps,
              engine: req.engine,
            };
            requestRef.current = null;
            setResult(payload);
            setStatus((s) => s === 'error' ? s : 'ready');
            req.resolve(payload);
          }
        } else if (line === 'uciok') {
          worker.postMessage('isready');
        } else if (line === 'readyok') {
          window.clearTimeout(timeout);
          setStatus((s) => s === 'analysing' ? s : 'ready');
          resolve();
        }
      };
    });
    readyRef.current = ready;
    ready.catch((err: Error) => {
      setError(err.message);
      setStatus('error');
    });
    worker.postMessage('uci');
  }, []);

  useEffect(() => {
    boot();
    return () => {
      const req = requestRef.current;
      if (req) {
        window.clearTimeout(req.timer);
        req.reject(new Error('Analysis worker was closed'));
        requestRef.current = null;
      }
      workerRef.current?.postMessage('quit');
      workerRef.current?.terminate();
      workerRef.current = null;
      readyRef.current = null;
    };
  }, [boot]);

  const analyse = useCallback(async (input: AnalyseInput): Promise<BrowserEngineResult> => {
    const worker = workerRef.current;
    if (!worker || !readyRef.current) throw new Error('Stockfish is not available');
    await readyRef.current;
    if (requestRef.current) worker.postMessage('stop');
    const id = Date.now();
    setStatus('analysing');
    setError(null);
    return new Promise<BrowserEngineResult>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        worker.postMessage('stop');
        const req = requestRef.current;
        if (req && req.id === id) {
          requestRef.current = null;
          setStatus('ready');
          req.reject(new Error('Stockfish analysis timed out'));
        }
      }, Math.max(12_000, (input.timeMs ?? 1000) + 8_000));
      requestRef.current = { id, resolve, reject, lines: [], engine: engineName || 'Stockfish UCI', nodes: null, nps: null, timer };
      const depth = Math.min(Math.max(input.depth ?? 14, 1), 22);
      const timeMs = Math.min(Math.max(input.timeMs ?? 900, 100), 8000);
      const multipv = Math.min(Math.max(input.multipv ?? 1, 1), 4);
      const moves = input.moves ?? [];
      const position = input.fen === START_FEN
        ? `position startpos${moves.length ? ` moves ${moves.join(' ')}` : ''}`
        : `position fen ${input.fen}${moves.length ? ` moves ${moves.join(' ')}` : ''}`;
      worker.postMessage('setoption name Threads value 1');
      worker.postMessage('setoption name Hash value 32');
      worker.postMessage(`setoption name MultiPV value ${multipv}`);
      worker.postMessage('ucinewgame');
      worker.postMessage(position);
      worker.postMessage(`go depth ${depth} movetime ${timeMs}`);
    });
  }, [engineName]);

  const stop = useCallback(() => {
    workerRef.current?.postMessage('stop');
  }, []);

  const reset = useCallback(() => {
    stop();
    setResult(null);
    setStatus(workerRef.current ? 'ready' : 'loading');
  }, [stop]);

  return useMemo(() => ({
    status, engineName, result, error, analyse, stop, reset,
    available: status !== 'error',
    source: {
      name: 'Stockfish 19 Lite WASM',
      licence: 'GPL-3.0-or-later',
      upstream: 'https://github.com/official-stockfish/Stockfish',
      port: 'https://github.com/nmrugg/stockfish.js',
    },
  }), [status, engineName, result, error, analyse, stop, reset]);
}
