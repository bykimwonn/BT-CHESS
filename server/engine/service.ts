import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { Chess } from 'chess.js';
import { env } from '../config/env.js';
import { badRequest, unavailable } from '../services/errors.js';
import type { AppLogger } from '../services/logger.js';
import { START_FEN, validFen } from '../games/rules.js';

const require = createRequire(import.meta.url);
export const ENGINE_DISTRIBUTION = {
  package: 'stockfish@19.0.1',
  upstream: 'https://github.com/official-stockfish/Stockfish',
  port: 'https://github.com/nmrugg/stockfish.js',
  licence: 'GPL-3.0-or-later',
  variant: 'stockfish-19-lite-single.wasm',
} as const;

export interface AnalysisLine {
  multipv: number;
  depth: number;
  scoreCp: number | null;
  mate: number | null;
  pv: string[];
  nodes: number | null;
}

export interface AnalysisRequest {
  fen: string;
  moves?: string[];
  depth?: number;
  timeMs?: number;
  multipv?: number;
  signal?: AbortSignal;
}

export interface AnalysisResult {
  fen: string;
  bestMove: string | null;
  ponder: string | null;
  depth: number;
  scoreCp: number | null;
  mate: number | null;
  pv: string[];
  lines: AnalysisLine[];
  nodes: number | null;
  nps: number | null;
  elapsedMs: number;
  engine: string;
}

interface Waiter {
  startIndex: number;
  predicate: (line: string, index: number) => boolean;
  resolve: (line: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class UciSession {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly lines: string[] = [];
  private readonly waiters = new Set<Waiter>();
  private buffer = '';
  private stderr = '';
  private closed = false;

  constructor(private readonly enginePath: string) {
    this.process = spawn(process.execPath, [enginePath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    this.process.stdout.setEncoding('utf8');
    this.process.stderr.setEncoding('utf8');
    this.process.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    this.process.stderr.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-2000); });
    this.process.on('error', (error) => this.failAll(error));
    this.process.on('exit', (code) => {
      this.closed = true;
      this.failAll(new Error(`Stockfish exited with code ${code ?? 'unknown'}: ${this.stderr}`));
    });
  }

  private failAll(error: Error): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) {
        const index = this.lines.push(line) - 1;
        for (const waiter of [...this.waiters]) {
          if (index >= waiter.startIndex && waiter.predicate(line, index)) {
            clearTimeout(waiter.timer);
            this.waiters.delete(waiter);
            waiter.resolve(line);
          }
        }
      }
      newline = this.buffer.indexOf('\n');
    }
  }

  send(command: string): void {
    if (this.closed) throw new Error('Stockfish process is closed');
    this.process.stdin.write(`${command}\n`);
  }

  waitFor(predicate: (line: string, index: number) => boolean, startIndex = 0, timeoutMs = 10_000): Promise<string> {
    for (let i = Math.max(0, startIndex); i < this.lines.length; i++) {
      if (predicate(this.lines[i], i)) return Promise.resolve(this.lines[i]);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`Timed out waiting for Stockfish response (${timeoutMs}ms)`));
      }, timeoutMs);
      const waiter: Waiter = { startIndex, predicate, resolve, reject, timer };
      this.waiters.add(waiter);
    });
  }

  historySince(index: number): string[] { return this.lines.slice(index); }
  engineName(): string { return this.lines.find((line) => line.startsWith('id name '))?.slice(8) ?? 'Unknown UCI engine'; }

  async handshake(): Promise<void> {
    this.send('uci');
    await this.waitFor((line) => line === 'uciok', 0, 10_000);
    this.send('isready');
    await this.waitFor((line) => line === 'readyok', 0, 10_000);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error('Stockfish session closed'));
    try { this.send('quit'); } catch { /* process already gone */ }
    this.process.stdin.end();
    setTimeout(() => { if (!this.process.killed) this.process.kill('SIGKILL'); }, 200).unref();
  }
}

function parseInfo(line: string): AnalysisLine | null {
  if (!line.startsWith('info ') || !line.includes(' pv ')) return null;
  const tokens = line.split(/\s+/);
  const get = (key: string): string | undefined => {
    const index = tokens.indexOf(key);
    return index >= 0 ? tokens[index + 1] : undefined;
  };
  const scoreIndex = tokens.indexOf('score');
  const scoreType = scoreIndex >= 0 ? tokens[scoreIndex + 1] : undefined;
  const scoreValue = scoreIndex >= 0 ? Number(tokens[scoreIndex + 2]) : NaN;
  const pvIndex = tokens.indexOf('pv');
  return {
    multipv: Number(get('multipv') ?? 1),
    depth: Number(get('depth') ?? 0),
    scoreCp: scoreType === 'cp' && Number.isFinite(scoreValue) ? scoreValue : null,
    mate: scoreType === 'mate' && Number.isFinite(scoreValue) ? scoreValue : null,
    pv: pvIndex >= 0 ? tokens.slice(pvIndex + 1).filter((m) => /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(m)) : [],
    nodes: get('nodes') ? Number(get('nodes')) : null,
  };
}

export class EngineService {
  private active = 0;
  private waiting: Array<() => void> = [];
  private readonly enginePath: string;
  private healthCache: { available: boolean; name: string | null; version: string | null; error?: string } | null = null;

  constructor(private readonly log: AppLogger) {
    this.enginePath = require('stockfish').findEngine('lite-single') as string;
  }

  private async acquire(): Promise<void> {
    if (!env.engineEnabled) throw unavailable('Stockfish analysis is disabled by ENGINE_ENABLED=false');
    if (this.active < env.engineMaxConcurrent) { this.active++; return; }
    if (this.waiting.length >= 20) throw unavailable('Analysis queue is full; try again shortly');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = this.waiting.filter((fn) => fn !== release);
        reject(unavailable('Timed out waiting for an analysis slot'));
      }, 15_000);
      const release = () => { clearTimeout(timer); this.active++; resolve(); };
      this.waiting.push(release);
    });
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) { next(); return; }
    this.active = Math.max(0, this.active - 1);
  }

  async health(): Promise<{ available: boolean; name: string | null; version: string | null; license: string; source: string; error?: string }> {
    if (this.healthCache) return { ...this.healthCache, license: ENGINE_DISTRIBUTION.licence, source: ENGINE_DISTRIBUTION.upstream };
    if (!env.engineEnabled) {
      this.healthCache = { available: false, name: null, version: null, error: 'ENGINE_ENABLED=false' };
      return this.health();
    }
    await this.acquire();
    const session = new UciSession(this.enginePath);
    try {
      await session.handshake();
      const name = session.engineName();
      const match = /Stockfish\s+([\d.]+)/.exec(name);
      this.healthCache = { available: true, name, version: match?.[1] ?? null };
    } catch (error) {
      this.healthCache = { available: false, name: null, version: null, error: (error as Error).message };
    } finally {
      session.close();
      this.release();
    }
    return { ...this.healthCache, license: ENGINE_DISTRIBUTION.licence, source: ENGINE_DISTRIBUTION.upstream };
  }

  async analyse(request: AnalysisRequest): Promise<AnalysisResult> {
    if (!validFen(request.fen)) throw badRequest('Invalid FEN position');
    const moves = request.moves ?? [];
    if (!moves.every((m) => /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(m))) throw badRequest('Invalid UCI move list');
    const depth = Math.min(Math.max(request.depth ?? 12, 1), env.engineMaxDepth);
    const timeMs = Math.min(Math.max(request.timeMs ?? env.engineMaxTimeMs, 50), 10_000);
    const multipv = Math.min(Math.max(request.multipv ?? 1, 1), 5);
    if (request.signal?.aborted) throw new Error('Analysis cancelled');

    await this.acquire();
    const session = new UciSession(this.enginePath);
    const started = Date.now();
    let aborted = false;
    const onAbort = () => { aborted = true; try { session.send('stop'); } catch { /* closed */ } };
    request.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await session.handshake();
      const chess = new Chess();
      if (request.fen !== START_FEN) chess.load(request.fen);
      for (const move of moves) {
        const applied = chess.move({ from: move.slice(0, 2) as never, to: move.slice(2, 4) as never, promotion: move[4] });
        if (!applied) throw badRequest(`Move ${move} is illegal in the supplied position`);
      }
      if (aborted) throw new Error('Analysis cancelled');
      session.send('setoption name Threads value 1');
      session.send('setoption name Hash value 32');
      session.send(`setoption name MultiPV value ${multipv}`);
      session.send('ucinewgame');
      session.send('isready');
      await session.waitFor((line) => line === 'readyok', 0, 5_000);
      const position = request.fen === START_FEN
        ? `position startpos${moves.length ? ` moves ${moves.join(' ')}` : ''}`
        : `position fen ${request.fen}${moves.length ? ` moves ${moves.join(' ')}` : ''}`;
      const startIndex = session.historySince(0).length;
      session.send(position);
      session.send(`go depth ${depth} movetime ${timeMs}`);
      const bestLine = await session.waitFor((line) => line.startsWith('bestmove '), startIndex, Math.max(10_000, timeMs + 8_000));
      if (aborted) throw new Error('Analysis cancelled');
      const infos = session.historySince(startIndex).map(parseInfo).filter((x): x is AnalysisLine => x !== null);
      const byMultiPv = new Map<number, AnalysisLine>();
      for (const info of infos) {
        const current = byMultiPv.get(info.multipv);
        if (!current || info.depth >= current.depth) byMultiPv.set(info.multipv, info);
      }
      const lines = [...byMultiPv.values()].sort((a, b) => a.multipv - b.multipv);
      const best = lines[0] ?? null;
      const parts = bestLine.split(/\s+/);
      const bestMove = parts[1] && parts[1] !== '(none)' && parts[1] !== '0000' ? parts[1] : null;
      if (bestMove && !chess.moves({ verbose: true }).some((m) => m.from + m.to + (m.promotion ?? '') === bestMove)) {
        throw new Error(`Stockfish returned an illegal move: ${bestMove}`);
      }
      const nodes = infos.length ? infos[infos.length - 1].nodes : null;
      const npsLine = session.historySince(startIndex).reverse().find((line) => line.includes(' nps '));
      const nps = npsLine ? Number(/ nps (\d+)/.exec(npsLine)?.[1] ?? 0) : null;
      return {
        fen: request.fen, bestMove,
        ponder: parts[3] && parts[3] !== '0000' ? parts[3] : null,
        depth: best?.depth ?? 0,
        scoreCp: best?.scoreCp ?? null,
        mate: best?.mate ?? null,
        pv: best?.pv ?? (bestMove ? [bestMove] : []),
        lines, nodes, nps,
        elapsedMs: Date.now() - started,
        engine: session.engineName(),
      };
    } catch (error) {
      this.log.warn({ err: (error as Error).message, fen: request.fen, depth }, 'Stockfish analysis failed');
      throw error;
    } finally {
      request.signal?.removeEventListener('abort', onAbort);
      session.close();
      this.release();
    }
  }
}
