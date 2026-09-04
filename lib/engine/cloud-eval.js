'use strict';

/**
 * Lichess cloud eval client.
 *
 * https://lichess.org/api/cloud-eval  ->  deep engine analyses cached by Lichess
 * for every position that has been analysed on the site. No API key required.
 *
 * Used for:
 *   - instant, very strong engine moves for common positions
 *   - the analysis panel / eval bar
 *   - anti-cheat scoring (compare a player's move with Lichess's top move)
 *
 * It is a *network* dependency, so everything here fails soft: short timeout,
 * in-memory LRU cache and a circuit breaker that stops hammering it when it is
 * unreachable (offline dev, blocked egress, Lichess down, ...).
 */

const CLOUD_EVAL_URL = 'https://lichess.org/api/cloud-eval';

class CloudEvalClient {
  constructor({
    enabled = true,
    baseUrl = CLOUD_EVAL_URL,
    timeoutMs = 2500,
    cacheSize = 20000,
    maxFailures = 4,
    cooldownMs = 5 * 60 * 1000,
    userAgent = 'BetChessZW/2.0 (+https://github.com/bykimwonn/BT-CHESS)',
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.enabled = enabled && typeof fetchImpl === 'function';
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
    this.maxFailures = maxFailures;
    this.cooldownMs = cooldownMs;
    this.userAgent = userAgent;
    this.fetchImpl = fetchImpl;
    this.cache = new Map(); // fen -> entry (LRU)
    this.cacheSize = cacheSize;
    this.consecutiveFailures = 0;
    this.disabledUntil = 0;
    this.stats = { hits: 0, misses: 0, cacheHits: 0, errors: 0, lastError: null };
  }

  get available() {
    if (!this.enabled) return false;
    if (this.disabledUntil && Date.now() < this.disabledUntil) return false;
    return true;
  }

  status() {
    return {
      enabled: this.enabled,
      available: this.available,
      cooldownRemainingMs: Math.max(0, this.disabledUntil - Date.now()),
      cacheSize: this.cache.size,
      ...this.stats,
    };
  }

  _cacheGet(fen) {
    if (!this.cache.has(fen)) return undefined;
    const entry = this.cache.get(fen);
    // refresh LRU position
    this.cache.delete(fen);
    this.cache.set(fen, entry);
    if (entry.expires && entry.expires < Date.now()) {
      this.cache.delete(fen);
      return undefined;
    }
    this.stats.cacheHits++;
    return entry.value;
  }

  _cacheSet(fen, value, ttlMs) {
    if (this.cache.size >= this.cacheSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(fen, { value, expires: ttlMs ? Date.now() + ttlMs : 0 });
  }

  _noteFailure(err) {
    this.consecutiveFailures++;
    this.stats.errors++;
    this.stats.lastError = err && err.message ? err.message : String(err);
    if (this.consecutiveFailures >= this.maxFailures) {
      this.disabledUntil = Date.now() + this.cooldownMs;
      this.consecutiveFailures = 0;
    }
  }

  /**
   * @param {string} fen
   * @param {number} multiPv
   * @returns {Promise<null | {found: boolean, bestMove: string|null, cp: number|null, mate: number|null,
   *   depth: number, nodes: number, pv: string[], pvs: Array, source: string}>}
   */
  async get(fen, multiPv = 1) {
    if (!this.available) return null;

    const cached = this._cacheGet(fen);
    if (cached !== undefined) {
      this.stats.hits++;
      return cached;
    }

    const url = `${this.baseUrl}?fen=${encodeURIComponent(fen)}&multiPv=${Math.max(1, Math.min(5, multiPv))}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        headers: { Accept: 'application/json', 'User-Agent': this.userAgent },
        signal: controller.signal,
      });
      if (res.status === 404) {
        // Position not in the cloud - cache the miss briefly.
        this.stats.misses++;
        this.consecutiveFailures = 0;
        this._cacheSet(fen, null, 60_000);
        return null;
      }
      if (!res.ok) throw new Error(`cloud-eval HTTP ${res.status}`);
      const data = await res.json();
      const parsed = this._parse(data);
      this.consecutiveFailures = 0;
      this.stats.hits++;
      // Cloud evals are effectively immutable, cache them for a day.
      this._cacheSet(fen, parsed, 24 * 60 * 60 * 1000);
      return parsed;
    } catch (err) {
      this._noteFailure(err);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  _parse(data) {
    if (!data || !Array.isArray(data.pvs) || !data.pvs.length) return null;
    const pvs = data.pvs.map((pv) => {
      const moves = typeof pv.moves === 'string' ? pv.moves.split(' ') : [];
      return {
        moves,
        cp: typeof pv.cp === 'number' ? pv.cp : null,
        mate: typeof pv.mate === 'number' ? pv.mate : null,
      };
    });
    const first = pvs[0];
    return {
      found: true,
      bestMove: first.moves[0] || null,
      cp: first.cp,
      mate: first.mate,
      depth: data.depth || 0,
      nodes: data.knodes ? data.knodes * 1000 : 0,
      pv: first.moves,
      pvs,
      source: 'lichess-cloud',
    };
  }
}

module.exports = { CloudEvalClient, CLOUD_EVAL_URL };
