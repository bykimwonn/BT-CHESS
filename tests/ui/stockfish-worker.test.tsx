import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useRef, useState } from 'react';
import { useStockfish } from '../../web/src/features/engine/useStockfish';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

class MockWorker {
  static instances: MockWorker[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  posted: string[] = [];
  closed = false;
  constructor() { MockWorker.instances.push(this); }
  private emit(line: string) { this.onmessage?.({ data: line }); }
  postMessage(command: string) {
    this.posted.push(String(command));
    queueMicrotask(() => {
      if (command === 'uci') {
        this.emit('id name Stockfish 19 Lite WASM');
        this.emit('uciok');
      } else if (command === 'isready') {
        this.emit('readyok');
      } else if (command.startsWith('go ')) {
        this.emit('info depth 8 score cp 29 nodes 100 pv e2e4');
        this.emit('bestmove e2e4 ponder e7e5');
      } else if (command === 'stop') {
        this.emit('bestmove e2e4');
      }
    });
  }
  terminate() { this.closed = true; }
}

function Probe() {
  const engine = useStockfish();
  const started = useRef(false);
  const [best, setBest] = useState('none');
  useEffect(() => {
    if (engine.status !== 'ready' || started.current) return;
    started.current = true;
    void engine.analyse({ fen: START_FEN, depth: 8, timeMs: 100 }).then((result) => setBest(result.bestMove ?? 'none'));
  }, [engine.status]);
  return (
    <div>
      <span data-testid="status">{engine.status}</span>
      <span data-testid="engine">{engine.engineName}</span>
      <span data-testid="best">{best}</span>
    </div>
  );
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); MockWorker.instances.length = 0; });

describe('browser Stockfish UCI worker', () => {
  it('performs a real UCI handshake and parses a bestmove response', async () => {
    vi.stubGlobal('Worker', MockWorker);
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('best').textContent).toBe('e2e4'));
    expect(screen.getByTestId('engine').textContent).toContain('Stockfish 19 Lite WASM');
    cleanup(); // triggers the hook's worker shutdown path
    const worker = MockWorker.instances[0];
    expect(worker.posted).toContain('uci');
    expect(worker.posted).toContain('isready');
    expect(worker.posted.some((command) => command.startsWith('go '))).toBe(true);
    expect(worker.posted).toContain('quit');
  });
});
