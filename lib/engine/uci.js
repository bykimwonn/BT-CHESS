'use strict';

/**
 * Thin UCI wrapper around the official Lichess Stockfish WebAssembly builds
 * (npm: @lichess-org/stockfish-web, the engine that powers lichess.org analysis).
 *
 * The wasm module is single threaded, so every search is serialised through an
 * internal queue - callers just await and never have to care.
 */

const VARIANTS = {
  // Stockfish 18 with the small (embedded) NNUE net - self contained, no extra
  // download, ~600KB wasm. This is the default.
  'sf18-smallnet': '@lichess-org/stockfish-web/sf_18_smallnet.js',
  'sf18-smallnet-simd': '@lichess-org/stockfish-web/sf_18_smallnet_relaxed-simd.js',
  // Full strength build. Needs the big NNUE net fed in through setNnueBuffer(),
  // which we do not ship - listed for completeness / advanced setups.
  'sf18': '@lichess-org/stockfish-web/sf_18.js',
  'sf18-simd': '@lichess-org/stockfish-web/sf_18_relaxed-simd.js',
  'sfdev-smallnet': '@lichess-org/stockfish-web/sf_dev_smallnet.js',
  // Fairy-Stockfish 14 (chess variants, multi-variant build).
  'fairy14': '@lichess-org/stockfish-web/fsf_14.js',
};

const DEFAULT_VARIANT = 'sf18-smallnet';

function parseInfo(line) {
  const out = { multipv: 1, depth: 0, seldepth: 0, cp: null, mate: null, nodes: 0, nps: 0, pv: [] };
  const m = (re) => {
    const r = re.exec(line);
    return r ? r[1] : null;
  };
  out.multipv = parseInt(m(/multipv (\d+)/) || '1', 10);
  out.depth = parseInt(m(/\bdepth (\d+)/) || '0', 10);
  out.seldepth = parseInt(m(/seldepth (\d+)/) || '0', 10);
  out.nodes = parseInt(m(/nodes (\d+)/) || '0', 10);
  out.nps = parseInt(m(/nps (\d+)/) || '0', 10);
  const cp = m(/score cp (-?\d+)/);
  if (cp !== null) out.cp = parseInt(cp, 10);
  const mate = m(/score mate (-?\d+)/);
  if (mate !== null) out.mate = parseInt(mate, 10);
  const pv = m(/ pv ([a-h1-8qrbn ]+)$/);
  if (pv) out.pv = pv.trim().split(/\s+/);
  return out;
}

class UciEngine {
  constructor(sf, variant) {
    this.sf = sf;
    this.variant = variant;
    this.dead = false;
    this.searching = false;
    this._chain = Promise.resolve();
    this._pending = null;
    this._pvs = new Map();
    this._waiters = [];
    this.nodes = 0;

    sf.listen = (line) => this._onLine(typeof line === 'string' ? line : String(line));
    sf.onError = (msg) => {
      this.dead = true;
      const err = new Error(`stockfish error: ${msg}`);
      if (this._pending) this._pending.fail(err);
      this._rejectWaiters(err);
    };
  }

  static async create(variant = DEFAULT_VARIANT, { hash = 64, threads = 1, log } = {}) {
    const file = VARIANTS[variant] || VARIANTS[DEFAULT_VARIANT];
    const mod = await import(file);
    const factory = mod.default || mod;
    const sf = await factory({ listen: () => {}, onError: () => {} });
    const engine = new UciEngine(sf, VARIANTS[variant] ? variant : DEFAULT_VARIANT);
    if (log) engine._log = log;

    await engine._sendAndWait('uci', 'uciok', 15000);
    engine.configure({
      Threads: threads,
      Hash: hash,
      MultiPV: 1,
      Ponder: false,
      'Move Overhead': 20,
    });
    await engine._sendAndWait('isready', 'readyok', 15000);
    engine.ready = true;
    return engine;
  }

  _logLine(line) {
    if (this._log) this._log(line);
  }

  _send(cmd) {
    if (this.dead) throw new Error('engine is dead');
    this._logLine('> ' + cmd);
    this.sf.uci(cmd);
  }

  _onLine(line) {
    const l = line.trim();
    this._logLine('< ' + l);
    if (!l) return;

    if (l.startsWith('info ') && l.includes(' score ')) {
      const info = parseInfo(l);
      this.nodes = info.nodes;
      this._pvs.set(info.multipv, info);
    }

    if (this._pending && l.startsWith('bestmove')) {
      const parts = l.split(/\s+/);
      const uci = parts[1];
      const pending = this._pending;
      this._pending = null;
      this.searching = false;
      const pvs = [...this._pvs.values()].sort((a, b) => a.multipv - b.multipv);
      this._pvs = new Map();
      if (!uci || uci === '(none)') {
        pending.done({ uci: null, pvs, ponder: parts[3] || null });
      } else {
        pending.done({
          uci,
          pvs,
          ponder: parts[3] || null,
        });
      }
      return;
    }

    for (let i = this._waiters.length - 1; i >= 0; i--) {
      const w = this._waiters[i];
      if (w.match.test(l)) {
        this._waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(l);
      }
    }
  }

  _rejectWaiters(err) {
    const waiters = this._waiters;
    this._waiters = [];
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  _sendAndWait(cmd, token, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const match = new RegExp(`^${token}`);
      const timer = setTimeout(() => {
        const i = this._waiters.findIndex((w) => w.resolve === resolve);
        if (i >= 0) this._waiters.splice(i, 1);
        reject(new Error(`timeout waiting for ${token}`));
      }, timeoutMs);
      this._waiters.push({ match, resolve, reject, timer });
      try {
        this._send(cmd);
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  /** Apply UCI options. `false` / `true` are emitted as UCI booleans. */
  configure(options) {
    for (const [name, value] of Object.entries(options)) {
      if (value === undefined || value === null) continue;
      this._send(`setoption name ${name} value ${typeof value === 'boolean' ? (value ? 'true' : 'false') : value}`);
    }
  }

  /** Serialise: only one search can run at a time. */
  _enqueue(fn) {
    const run = this._chain.then(fn, fn);
    this._chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /**
   * @param {object} opts
   * @param {string} opts.fen
   * @param {number} [opts.movetimeMs]
   * @param {number} [opts.depth]
   * @param {number} [opts.multiPv]
   * @param {object} [opts.options] extra UCI options (Skill Level, UCI_Elo, ...)
   * @returns {Promise<{uci: string|null, pvs: Array, ponder: string|null, elapsedMs: number}>}
   */
  analyse({ fen, movetimeMs = 500, depth = 0, multiPv = 1, nodes = 0, options = {} }) {
    return this._enqueue(async () => {
      if (this.dead) throw new Error('engine is dead');
      this.configure({ MultiPV: Math.max(1, multiPv) });
      if (options && Object.keys(options).length) this.configure(options);

      const started = Date.now();
      const go = [
        'go',
        movetimeMs ? `movetime ${Math.max(20, Math.round(movetimeMs))}` : '',
        depth ? `depth ${Math.round(depth)}` : '',
        nodes ? `nodes ${Math.round(nodes)}` : '',
      ]
        .filter(Boolean)
        .join(' ');

      const budget = Math.max(2000, (movetimeMs || 0) * 3 + 8000);
      const result = await new Promise((resolve, reject) => {
        this.searching = true;
        const timer = setTimeout(() => {
          // Safety net - ask the engine to stop and let the bestmove line land.
          try {
            this._send('stop');
          } catch (e) {
            /* ignore */
          }
          setTimeout(() => {
            if (this._pending) {
              const p = this._pending;
              this._pending = null;
              this.searching = false;
              p.fail(new Error('engine stalled'));
            }
          }, 3000);
        }, budget);
        this._pending = {
          done: (res) => {
            clearTimeout(timer);
            resolve({ ...res, elapsedMs: Date.now() - started });
          },
          fail: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        };
        try {
          this._send(`position fen ${fen}`);
          this._send(go);
        } catch (e) {
          clearTimeout(timer);
          this._pending = null;
          this.searching = false;
          reject(e);
        }
      });
      return result;
    });
  }

  stop() {
    if (this.searching) {
      try {
        this._send('stop');
      } catch (e) {
        /* ignore */
      }
    }
  }

  quit() {
    try {
      this._send('quit');
    } catch (e) {
      /* ignore */
    }
    this.dead = true;
  }

  isAlive() {
    return !this.dead;
  }
}

module.exports = { UciEngine, VARIANTS, DEFAULT_VARIANT, parseInfo };
