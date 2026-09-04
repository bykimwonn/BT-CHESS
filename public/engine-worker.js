/*!
 * BetChess ZW - analysis engine worker.
 *
 * Runs the official Lichess Stockfish 18 WebAssembly build
 * (npm @lichess-org/stockfish-web, vendored to /engine/) inside a Web Worker so
 * the UI never blocks. If the wasm cannot start for any reason the worker says
 * so and the client falls back to the server-side engine.
 */
(function () {
  const ENGINE_FILE = '/engine/sf_18_smallnet.js';

  let engine = null;
  let ready = false;
  let searching = false;
  let pending = null; // { resolve, reject, timer }
  let pvs = new Map();
  let waiters = [];
  let chain = Promise.resolve();

  const post = (msg) => self.postMessage(msg);

  function parseInfo(line) {
    const out = { multipv: 1, depth: 0, cp: null, mate: null, nodes: 0, pv: [] };
    const m = (re) => {
      const r = re.exec(line);
      return r ? r[1] : null;
    };
    out.multipv = parseInt(m(/multipv (\d+)/) || '1', 10);
    out.depth = parseInt(m(/\bdepth (\d+)/) || '0', 10);
    out.nodes = parseInt(m(/nodes (\d+)/) || '0', 10);
    const cp = m(/score cp (-?\d+)/);
    if (cp !== null) out.cp = parseInt(cp, 10);
    const mate = m(/score mate (-?\d+)/);
    if (mate !== null) out.mate = parseInt(mate, 10);
    const pv = m(/ pv ([a-h1-8qrbn ]+)$/);
    if (pv) out.pv = pv.trim().split(/\s+/);
    return out;
  }

  /** Single output handler handed to the wasm module at construction. */
  function handleOutput(raw) {
    const line = String(raw == null ? '' : raw).trim();
    if (!line) return;

    for (let i = waiters.length - 1; i >= 0; i--) {
      if (line.startsWith(waiters[i].token)) {
        const waiter = waiters.splice(i, 1)[0];
        clearTimeout(waiter.timer);
        waiter.resolve(line);
      }
    }

    if (line.startsWith('info ') && line.includes(' score ')) {
      const info = parseInfo(line);
      pvs.set(info.multipv, info);
      return;
    }

    if (line.startsWith('bestmove') && pending) {
      const parts = line.split(/\s+/);
      const uci = parts[1];
      const job = pending;
      pending = null;
      searching = false;
      clearTimeout(job.timer);
      const lines = Array.from(pvs.values()).sort((a, b) => a.multipv - b.multipv);
      pvs = new Map();
      job.resolve({
        bestMove: !uci || uci === '(none)' ? null : uci,
        pvs: lines,
        ponder: parts[3] || null,
      });
    }
  }

  function handleError(msg) {
    post({ type: 'error', message: String(msg) });
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(String(msg)));
      pending = null;
      searching = false;
    }
  }

  function send(cmd) {
    if (!engine) throw new Error('engine not loaded');
    engine.uci(cmd);
  }

  function waitFor(token, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters = waiters.filter((w) => w.resolve !== resolve);
        reject(new Error(`timeout waiting for ${token}`));
      }, timeoutMs);
      waiters.push({ token, resolve: (v) => { clearTimeout(timer); resolve(v); }, timer });
    });
  }

  async function init() {
    const mod = await import(/* webpackIgnore: true */ ENGINE_FILE);
    const factory = mod.default || mod;
    engine = await factory({ listen: handleOutput, onError: handleError });

    send('uci');
    await waitFor('uciok', 20000);
    send('setoption name Threads value 1');
    send('setoption name Hash value 32');
    send('setoption name MultiPV value 1');
    send('isready');
    await waitFor('readyok', 20000);
    ready = true;
  }

  function analyse({ fen, movetimeMs = 500, depth = 0, multiPv = 1, options = {} }) {
    return new Promise((resolve, reject) => {
      if (!ready) return reject(new Error('engine not ready'));
      if (searching) return reject(new Error('engine busy'));

      searching = true;
      const timer = setTimeout(
        () => {
          try {
            send('stop');
          } catch (e) {
            /* ignore */
          }
          setTimeout(() => {
            if (pending) {
              const job = pending;
              pending = null;
              searching = false;
              job.reject(new Error('engine timeout'));
            }
          }, 3000);
        },
        Math.max(4000, (movetimeMs || 0) * 3 + 6000)
      );

      pending = { resolve, reject, timer };
      try {
        send(`setoption name MultiPV value ${Math.max(1, multiPv)}`);
        for (const [name, value] of Object.entries(options || {})) {
          send(`setoption name ${name} value ${value}`);
        }
        send(`position fen ${fen}`);
        send(
          ['go', movetimeMs ? `movetime ${Math.round(movetimeMs)}` : '', depth ? `depth ${Math.round(depth)}` : '']
            .filter(Boolean)
            .join(' ')
        );
      } catch (err) {
        clearTimeout(timer);
        pending = null;
        searching = false;
        reject(err);
      }
    });
  }

  self.onmessage = async (event) => {
    const msg = event.data || {};
    const { id, cmd } = msg;
    const reply = (payload) => post(Object.assign({ id, type: 'result' }, payload));
    const error = (message) => post({ id, type: 'error', message });

    try {
      if (cmd === 'init') {
        if (!ready) await init();
        return reply({ ok: true, engine: 'lichess-sf18', name: 'Lichess Stockfish 18' });
      }

      if (!ready) await init();

      if (cmd === 'analyse') {
        chain = chain.then(() => analyse(msg), () => analyse(msg));
        const res = await chain;
        return reply({ ok: true, engine: 'lichess-sf18', ...res });
      }

      if (cmd === 'stop') {
        if (searching) send('stop');
        return reply({ ok: true });
      }

      if (cmd === 'quit') {
        try {
          send('quit');
        } catch (e) {
          /* ignore */
        }
        ready = false;
        return reply({ ok: true });
      }

      error(`unknown command: ${cmd}`);
    } catch (err) {
      error(err && err.message ? err.message : String(err));
    }
  };
})();
