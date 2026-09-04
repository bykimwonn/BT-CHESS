/**
 * Browser engine client.
 *
 * Primary: the Lichess Stockfish 18 wasm engine running in /engine-worker.js.
 * Fallback: the server's engine (same build) over the socket, so the eval bar,
 * hints and analysis still work on browsers/devices that cannot start wasm.
 */
(function (global) {
  'use strict';

  class EngineClient {
    constructor({ socket, workerUrl = '/engine-worker.js', initTimeoutMs = 25000 } = {}) {
      this.socket = socket;
      this.workerUrl = workerUrl;
      this.initTimeoutMs = initTimeoutMs;
      this.status = 'idle'; // idle | loading | ready | server | unavailable
      this.engineName = '';
      this.worker = null;
      this.seq = 0;
      this.pending = new Map();
      this.listeners = [];
      this._lastRequest = 0;
      this._lastFen = null;
      this._lastResult = null;
    }

    onStatus(fn) {
      this.listeners.push(fn);
      fn(this.status, this.engineName);
      return () => {
        this.listeners = this.listeners.filter((f) => f !== fn);
      };
    }

    _setStatus(status, name) {
      this.status = status;
      if (name) this.engineName = name;
      for (const fn of this.listeners) fn(this.status, this.engineName);
    }

    /** Start the wasm engine. Never throws - falls back to the server. */
    async init() {
      if (this.status === 'ready' || this.status === 'server') return this.status;
      this._setStatus('loading', 'Starting engine…');

      const ok = await this._startWorker();
      if (ok) {
        this._setStatus('ready', 'Lichess Stockfish 18');
      } else {
        this._teardownWorker();
        this._setStatus('server', 'Server engine (Lichess SF18)');
      }
      return this.status;
    }

    _startWorker() {
      return new Promise((resolve) => {
        if (typeof Worker === 'undefined') return resolve(false);
        let settled = false;
        const done = (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        };
        const timer = setTimeout(() => done(false), this.initTimeoutMs);

        try {
          this.worker = new Worker(this.workerUrl);
        } catch (e) {
          return done(false);
        }

        this.worker.onmessage = (event) => {
          const msg = event.data || {};
          if (msg.id && this.pending.has(msg.id)) {
            const job = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            clearTimeout(job.timer);
            if (msg.type === 'error') job.reject(new Error(msg.message || 'engine error'));
            else job.resolve(msg);
            return;
          }
          if (msg.type === 'error') {
            // Engine died on us - drop to server analysis.
            this._teardownWorker();
            this._setStatus('server', 'Server engine (Lichess SF18)');
          }
        };
        this.worker.onerror = () => {
          this._teardownWorker();
          done(false);
        };

        this._call({ cmd: 'init' }, this.initTimeoutMs)
          .then(() => done(true))
          .catch(() => done(false));
      });
    }

    _teardownWorker() {
      try {
        if (this.worker) this.worker.terminate();
      } catch (e) {
        /* ignore */
      }
      this.worker = null;
    }

    _call(payload, timeoutMs = 15000) {
      return new Promise((resolve, reject) => {
        if (!this.worker) return reject(new Error('no worker'));
        const id = ++this.seq;
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error('engine request timed out'));
        }, timeoutMs);
        this.pending.set(id, { resolve, reject, timer });
        this.worker.postMessage(Object.assign({ id }, payload));
      });
    }

    _serverAnalyse({ fen, movetimeMs, multiPv }) {
      return new Promise((resolve) => {
        if (!this.socket) return resolve(null);
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        setTimeout(() => finish(null), (movetimeMs || 400) + 6000);
        try {
          this.socket.emit(
            'analyse',
            { fen, movetimeMs: Math.min(1500, movetimeMs || 400), multiPv: multiPv || 1 },
            (res) => {
              if (!res || res.error) return finish(null);
              finish({
                bestMove: res.bestMove,
                cp: res.cp,
                mate: res.mate,
                depth: res.depth,
                pv: res.pv || [],
                pvs: res.pvs || [],
                source: res.source || 'server',
              });
            }
          );
        } catch (e) {
          finish(null);
        }
      });
    }

    /**
     * Analyse a position.
     * @returns {Promise<null|{bestMove:string, cp:number|null, mate:number|null, depth:number, pv:string[], source:string}>}
     */
    async analyse({ fen, movetimeMs = 400, depth = 0, multiPv = 1, options = {} } = {}) {
      if (!fen) return null;

      if (this.worker && this.status === 'ready') {
        try {
          const res = await this._call(
            { cmd: 'analyse', fen, movetimeMs, depth, multiPv, options },
            Math.max(8000, (movetimeMs || 400) * 3 + 8000)
          );
          const line = (res.pvs || [])[0] || {};
          return {
            bestMove: res.bestMove,
            cp: line.cp !== undefined ? line.cp : null,
            mate: line.mate !== undefined ? line.mate : null,
            depth: line.depth || 0,
            pv: line.pv || [],
            pvs: res.pvs || [],
            source: 'lichess-sf18-browser',
          };
        } catch (e) {
          // Fall through to the server engine for this request.
        }
      }

      return this._serverAnalyse({ fen, movetimeMs, multiPv });
    }

    /** Best move only (hint, puzzle help). */
    async bestMove(fen, opts = {}) {
      const res = await this.analyse({ fen, movetimeMs: opts.movetimeMs || 400, multiPv: 1 });
      return res ? res.bestMove : null;
    }

    stop() {
      if (this.worker) {
        try {
          this.worker.postMessage({ id: ++this.seq, cmd: 'stop' });
        } catch (e) {
          /* ignore */
        }
      }
    }

    destroy() {
      this._teardownWorker();
    }
  }

  global.EngineClient = EngineClient;
})(window);
