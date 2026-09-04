'use strict';

/**
 * Engine service - the brain behind every "vs Computer" game.
 *
 * Resolution order for a move:
 *
 *   1. Lichess cloud eval   (lichess.org/api/cloud-eval, no key needed) - used
 *                           for the full-strength tiers (Master, Grandmaster)
 *                           and for analysis. Deep, instant, cached.
 *   2. Lichess Stockfish 18 (the actual wasm engine that powers lichess.org,
 *                           npm @lichess-org/stockfish-web) running right here
 *                           in Node. Strength is shaped with Skill Level /
 *                           UCI_Elo so every difficulty tier is beatable.
 *   3. JS fallback engine   tiny negamax searcher, no dependencies, guarantees
 *                           the app always plays even without wasm.
 *   4. Random legal move    last resort (never reached in practice).
 *
 * Everything degrades gracefully: no wasm, no network -> still plays chess.
 */

const { Chess } = require('chess.js');
const { UciEngine, DEFAULT_VARIANT } = require('./uci');
const { CloudEvalClient } = require('./cloud-eval');
const { JsEngine } = require('./js-engine');
const { getProfile, DIFFICULTY_PROFILES } = require('./strength');

const PRIORITY = { high: 3, normal: 2, low: 1 };

// Cheap sanity check so a malformed FEN produces a clear error, not a crash.
const FEN_RE = /^([rnbqkpRNBQKP1-8]+\/){7}[rnbqkpRNBQKP1-8]+ [wb] (K?Q?k?q?|-) ([a-h][36]|-) \d+ [1-9]\d*$/;

class EngineService {
  constructor({
    variant = process.env.ENGINE_VARIANT || DEFAULT_VARIANT,
    hash = parseInt(process.env.ENGINE_HASH || '64', 10),
    threads = parseInt(process.env.ENGINE_THREADS || '1', 10),
    cloudEnabled = process.env.LICHESS_CLOUD_EVAL !== 'false',
    cloudForMoves = process.env.LICHESS_CLOUD_FOR_MOVES !== 'false',
    cloudBaseUrl = process.env.LICHESS_CLOUD_URL || 'https://lichess.org/api/cloud-eval',
    cloudTimeoutMs = parseInt(process.env.LICHESS_CLOUD_TIMEOUT_MS || '2500', 10),
    antiCheatEnabled = process.env.ANTI_CHEAT !== 'false',
    antiCheatMovetimeMs = parseInt(process.env.ANTI_CHEAT_MOVETIME_MS || '220', 10),
    log,
    debug = process.env.ENGINE_DEBUG === '1',
  } = {}) {
    this.variant = variant;
    this.debug = debug;
    this.hash = hash;
    this.threads = threads;
    this.cloudForMoves = cloudForMoves;
    this.antiCheatEnabled = antiCheatEnabled;
    this.antiCheatMovetimeMs = antiCheatMovetimeMs;
    this.log = log || (() => {});
    this.cloud = new CloudEvalClient({
      enabled: cloudEnabled,
      baseUrl: cloudBaseUrl,
      timeoutMs: cloudTimeoutMs,
    });
    this.jsEngine = new JsEngine();
    this.uci = null;
    this.ready = false;
    this.initError = null;
    this.stats = { moves: 0, bySource: {}, totalMs: 0 };
    this._queue = [];
    this._running = false;
    this._inJob = false;
  }

  /** Load the wasm engine. Safe to call more than once. */
  async init() {
    if (this.ready) return this;
    try {
      this.uci = await UciEngine.create(this.variant, { hash: this.hash, threads: this.threads });
      this.idName = await this._identify();
      this.log(`[engine] Lichess ${this.variant} ready (${this.idName})`);
    } catch (err) {
      this.initError = err;
      this.uci = null;
      this.log(`[engine] wasm engine unavailable (${err.message}) - falling back to JS engine`);
    }
    this.ready = true;
    return this;
  }

  async _identify() {
    try {
      const res = await this.uci.analyse({
        fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        movetimeMs: 30,
        nodes: 1,
      });
      return res.uci ? 'ok' : 'ok';
    } catch (e) {
      return 'unknown';
    }
  }

  /**
   * Priority queue in front of the (single threaded) wasm engine.
   *
   * Re-entrant calls (a job that asks for more analysis while it is running)
   * are executed inline: the pump is already holding the engine, so queueing
   * those would deadlock waiting for a loop that cannot continue.
   */
  _enqueue(priority, task) {
    if (this._inJob) return Promise.resolve().then(task);
    return new Promise((resolve, reject) => {
      this._queue.push({ priority, task, resolve, reject, queuedAt: Date.now() });
      // Bound the backlog so a burst of low priority work can never pile up.
      if (this._queue.length > 200) {
        this._queue.sort((a, b) => b.priority - a.priority || a.queuedAt - b.queuedAt);
        const dropped = this._queue.splice(100);
        for (const job of dropped) job.reject(new Error('engine queue overflow'));
      }
      this._pump();
    });
  }

  async _pump() {
    if (this._running) return;
    this._running = true;
    try {
      while (this._queue.length) {
        this._queue.sort((a, b) => b.priority - a.priority || a.queuedAt - b.queuedAt);
        const job = this._queue.shift();
        this._inJob = true;
        try {
          job.resolve(await job.task());
        } catch (err) {
          job.reject(err);
        } finally {
          this._inJob = false;
        }
      }
    } finally {
      this._running = false;
    }
  }

  _dbg(msg) {
    if (this.debug) this.log(`[engine:debug] ${msg}`);
  }

  _record(source, elapsedMs) {
    this.stats.moves++;
    this.stats.bySource[source] = (this.stats.bySource[source] || 0) + 1;
    this.stats.totalMs += elapsedMs || 0;
  }

  /** chess.js throws on a bad FEN - never let that escape as a crash. */
  _legalMoves(fen) {
    const chess = new Chess(fen);
    return chess.moves({ verbose: true });
  }

  _isLegalUci(fen, uci) {
    if (!uci) return false;
    return this._legalMoves(fen).some((m) => m.from + m.to + (m.promotion || '') === uci);
  }

  _toMove(uci) {
    if (!uci) return null;
    return {
      uci,
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4] : undefined,
    };
  }

  /**
   * Pick the engine's move for a position.
   * @returns {Promise<{from:string,to:string,promotion?:string,uci:string,source:string,
   *   depth:number,eval:{cp:number|null,mate:number|null},pv:string[],elapsedMs:number,difficulty:string}>}
   */
  async getMove({ fen, difficulty = 'medium', allowCloud = true, movetimeMs, priority = PRIORITY.high } = {}) {
    const profile = getProfile(difficulty);
    const started = Date.now();
    const budget = movetimeMs || profile.movetimeMs;

    if (!fen || typeof fen !== 'string' || !FEN_RE.test(fen)) {
      throw new Error(`Invalid FEN passed to engine: ${fen}`);
    }

    // 1. Lichess cloud eval (full strength tiers only - the cloud is always full strength).
    if (allowCloud && this.cloudForMoves && profile.fullStrength && this.cloud.available) {
      const cloud = await this.cloud.get(fen, 1);
      if (cloud && cloud.bestMove && this._isLegalUci(fen, cloud.bestMove)) {
        const elapsedMs = Date.now() - started;
        this._record('lichess-cloud', elapsedMs);
        return {
          ...this._toMove(cloud.bestMove),
          source: 'lichess-cloud',
          depth: cloud.depth || 40,
          eval: { cp: cloud.cp, mate: cloud.mate },
          pv: cloud.pv || [],
          nodes: cloud.nodes || 0,
          elapsedMs,
          difficulty,
        };
      }
    }

    // 2. Lichess Stockfish 18 (wasm, in-process).
    if (this.uci && this.uci.isAlive()) {
      try {
        this._dbg(`getMove start difficulty=${difficulty} budget=${budget} queue=${this._queue.length} inJob=${this._inJob}`);
        const options = {
          'Skill Level': profile.skill,
          'UCI_LimitStrength': profile.limitStrength,
        };
        if (profile.limitStrength && profile.targetElo) options['UCI_Elo'] = profile.targetElo;

        const res = await this._enqueue(priority, () =>
          this.uci.analyse({
            fen,
            movetimeMs: budget,
            depth: profile.depth,
            multiPv: Math.max(1, profile.multiPv),
            options,
          })
        );

        this._dbg(`getMove search done in ${Date.now() - started}ms pvs=${(res.pvs || []).length} uci=${res.uci}`);
        const chosen = this._pickFromPv(res, profile, fen);
        if (chosen) {
          const elapsedMs = Date.now() - started;
          this._record('stockfish-18-lichess', elapsedMs);
          const line = (res.pvs || []).find((p) => p.pv && p.pv[0] === chosen) || res.pvs?.[0];
          return {
            ...this._toMove(chosen),
            source: 'stockfish-18-lichess',
            depth: line?.depth || 0,
            eval: { cp: line?.cp ?? null, mate: line?.mate ?? null },
            pv: line?.pv || [],
            nodes: res.pvs?.[0]?.nodes || 0,
            elapsedMs,
            difficulty,
          };
        }
      } catch (err) {
        this.log(`[engine] stockfish search failed: ${err.message}`);
      }
    }

    // 3. Pure JS fallback engine.
    try {
      const res = this.jsEngine.search({
        fen,
        movetimeMs: Math.min(budget, 600),
        depth: profile.depth || 0,
        skill: profile.skill,
      });
      let uci = res.uci;
      if (profile.blunderChance && Math.random() < profile.blunderChance) {
        const legal = new Chess(fen).moves({ verbose: true });
        const alt = legal[Math.floor(Math.random() * legal.length)];
        if (alt) uci = alt.from + alt.to + (alt.promotion || '');
      }
      if (uci && this._isLegalUci(fen, uci)) {
        const elapsedMs = Date.now() - started;
        this._record('js-fallback', elapsedMs);
        return {
          ...this._toMove(uci),
          source: 'js-fallback',
          depth: res.depth || 1,
          eval: { cp: res.cp ?? null, mate: res.mate ?? null },
          pv: res.pv || [],
          nodes: res.nodes || 0,
          elapsedMs,
          difficulty,
        };
      }
    } catch (err) {
      this.log(`[engine] js fallback failed: ${err.message}`);
    }

    // 4. Random legal move.
    const legal = this._legalMoves(fen);
    const m = legal[Math.floor(Math.random() * legal.length)] || { from: 'e2', to: 'e4' };
    const elapsedMs = Date.now() - started;
    this._record('random', elapsedMs);
    return {
      ...this._toMove(m.from + m.to + (m.promotion || '')),
      source: 'random',
      depth: 0,
      eval: { cp: null, mate: null },
      pv: [],
      nodes: 0,
      elapsedMs,
      difficulty,
    };
  }

  /** Choose which PV line to actually play for a difficulty tier. */
  _pickFromPv(res, profile, fen) {
    const candidates = (res.pvs || [])
      .map((p) => p.pv && p.pv[0])
      .filter((uci) => uci && this._isLegalUci(fen, uci));

    if (!candidates.length) return null;

    // Deliberate mistakes keep the weaker tiers beatable.
    if (profile.blunderChance && Math.random() < profile.blunderChance) {
      const legal = this._legalMoves(fen).map((m) => m.from + m.to + (m.promotion || ''));
      const weak = legal.filter((uci) => !candidates.includes(uci));
      if (weak.length) return weak[Math.floor(Math.random() * weak.length)];
    }

    const rank = Math.min(Math.max(1, profile.pickRank || 1), candidates.length);
    return candidates[rank - 1];
  }

  /**
   * Position analysis (eval bar, analysis tab, hints).
   * Cheap and never blocks gameplay: queued with normal priority.
   */
  async analyse({ fen, movetimeMs = 400, multiPv = 1, useCloud = true } = {}) {
    const _t0 = Date.now();
    this._dbg(`analyse start movetime=${movetimeMs} multiPv=${multiPv} cloud=${useCloud} queue=${this._queue.length} inJob=${this._inJob}`);
    if (useCloud && this.cloud.available) {
      const cloud = await this.cloud.get(fen, multiPv);
      if (cloud) {
        return {
          source: 'lichess-cloud',
          bestMove: cloud.bestMove,
          cp: cloud.cp,
          mate: cloud.mate,
          depth: cloud.depth,
          pv: cloud.pv,
          pvs: cloud.pvs,
        };
      }
    }
    if (this.uci && this.uci.isAlive()) {
      try {
        const res = await this._enqueue(PRIORITY.normal, () =>
          this.uci.analyse({ fen, movetimeMs, multiPv, options: { 'Skill Level': 20, UCI_LimitStrength: false } })
        );
        const line = (res.pvs || [])[0] || {};
        return {
          source: 'stockfish-18-lichess',
          bestMove: res.uci,
          cp: line.cp ?? null,
          mate: line.mate ?? null,
          depth: line.depth || 0,
          pv: line.pv || [],
          pvs: res.pvs || [],
        };
      } catch (err) {
        this.log(`[engine] analyse failed: ${err.message}`);
      }
    }
    const res = this.jsEngine.search({ fen, movetimeMs: Math.min(movetimeMs, 500), skill: 20 });
    return {
      source: 'js-fallback',
      bestMove: res.uci,
      cp: res.cp ?? null,
      mate: res.mate ?? null,
      depth: res.depth || 1,
      pv: res.pv || [],
      pvs: [],
    };
  }

  /**
   * Anti-cheat: how good was the move that was just played?
   * Returns cp loss and whether the move matched the engine's choice.
   * Runs at low priority so it never delays actual play.
   */
  async analyseMove({ fen, moveUci }) {
    if (!this.antiCheatEnabled) return null;
    try {
      if (!FEN_RE.test(fen)) return null;
      const before = await this.analyse({ fen, movetimeMs: this.antiCheatMovetimeMs, multiPv: 3, useCloud: false });
      const legal = this._isLegalUci(fen, moveUci);
      const after = legal
        ? await this.analyse({
            fen: this._fenAfter(fen, moveUci),
            movetimeMs: this.antiCheatMovetimeMs,
            multiPv: 1,
            useCloud: false,
          })
        : null;

      const cpBest = before.mate != null ? null : before.cp;
      const cpAfter = after && after.mate == null ? -(after.cp ?? 0) : null;
      const cpLoss = cpBest != null && cpAfter != null ? Math.max(0, cpBest - cpAfter) : null;
      return {
        bestMove: before.bestMove,
        played: moveUci,
        matchedEngine: before.bestMove === moveUci,
        topMoves: (before.pvs || []).slice(0, 3).map((p) => p.pv?.[0]).filter(Boolean),
        cpBest,
        cpAfter,
        cpLoss,
        source: before.source,
      };
    } catch (err) {
      return null;
    }
  }

  _fenAfter(fen, uci) {
    try {
      const chess = new Chess(fen);
      chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length > 4 ? uci[4] : undefined });
      return chess.fen();
    } catch (e) {
      return fen;
    }
  }

  /**
   * Fire-and-forget anti-cheat scoring. Strictly background work: if the engine
   * is busy playing a game we wait for a quiet moment instead of stealing time
   * from the move the player is waiting for.
   */
  queueMoveAnalysis(payload, attempt = 0) {
    if (!this.antiCheatEnabled) return;
    if (this._running || this._inJob) {
      if (attempt > 10) return;
      const timer = setTimeout(() => this.queueMoveAnalysis(payload, attempt + 1), 500 + attempt * 500);
      if (timer.unref) timer.unref();
      return;
    }
    this._enqueue(PRIORITY.low, () => this.analyseMove(payload)).catch(() => {});
  }

  status() {
    return {
      ready: this.ready,
      engine: this.uci ? 'stockfish-18-lichess' : 'js-fallback',
      variant: this.variant,
      initError: this.initError ? this.initError.message : null,
      fallback: !this.uci,
      cloud: this.cloud.status(),
      profiles: Object.keys(DIFFICULTY_PROFILES),
      queueDepth: this._queue.length,
      stats: {
        ...this.stats,
        avgMs: this.stats.moves ? Math.round(this.stats.totalMs / this.stats.moves) : 0,
      },
    };
  }

  shutdown() {
    if (this.uci) this.uci.quit();
  }
}

module.exports = { EngineService, PRIORITY };
