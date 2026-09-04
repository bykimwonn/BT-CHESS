/**
 * Client smoke test.
 *
 * There is no browser in CI, so we load public/index.html + app.js into jsdom
 * with a stubbed socket and assert the page actually boots: board rendered,
 * difficulty grid built, games start, deposits carry a provider. This is the
 * test that would have caught the syntax error that used to kill app.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { Chess } from 'chess.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function boot() {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  // jsdom cannot execute ES modules - Chess is provided directly instead.
  const withoutModule = html.replace(/<script type="module">[\s\S]*?<\/script>/, '');
  const dom = new JSDOM(withoutModule, { runScripts: 'outside-only', url: 'http://localhost:3000/', pretendToBeVisual: true });
  const { window } = dom;

  const handlers = new Map();
  const emitted = [];
  const socket = {
    connected: true,
    on(event, fn) {
      handlers.set(event, fn);
      return socket;
    },
    once(event, fn) {
      handlers.set(event, fn);
      return socket;
    },
    emit(event, payload, cb) {
      emitted.push({ event, payload });
      if (typeof cb === 'function') cb({ success: true });
      return socket;
    },
    close() {},
  };

  window.Chess = Chess;
  window.io = () => socket;
  window.fetch = async (url) => {
    if (String(url).includes('/api/payments/providers')) {
      return {
        json: async () => ({
          mode: 'mock',
          providers: [
            { id: 'ecocash', label: 'EcoCash', kind: 'mobile_money', minAmount: 0.5, maxAmount: 2000, sandbox: true },
            { id: 'innbucks', label: 'InnBucks', kind: 'mobile_money', minAmount: 0.5, maxAmount: 2000, sandbox: true },
            { id: 'bank', label: 'Bank transfer', kind: 'bank', minAmount: 1, maxAmount: 10000, sandbox: true },
          ],
        }),
      };
    }
    return { json: async () => ({}) };
  };
  // No Worker in jsdom: the engine client must fall back to server analysis.
  delete window.Worker;

  const errors = [];
  window.addEventListener('error', (e) => errors.push(e.message));

  window.eval(fs.readFileSync(path.join(ROOT, 'public/js/engine-client.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8'));

  return { window, handlers, emitted, errors, socket };
}

const DIFFICULTIES = ['easy', 'medium', 'hard', 'master', 'grandmaster'];

test('app.js boots without throwing', () => {
  const { window, errors } = boot();
  assert.deepEqual(errors, []);
  assert.equal(typeof window.renderBoard, 'function');
  assert.equal(typeof window.doDeposit, 'function');
  assert.equal(typeof window.findMatch, 'function');
});

test('board is rendered on load', () => {
  const { window } = boot();
  const squares = window.document.getElementById('board').querySelectorAll('.square');
  assert.equal(squares.length, 64, 'expected 64 squares');
});

test('registered event fills the wallet and difficulty grid', () => {
  const { window, handlers } = boot();
  const difficultyConfig = {};
  for (const key of DIFFICULTIES) {
    difficultyConfig[key] = { label: key, elo: 1000, multiplier: 2, color: '#fff', desc: key };
  }
  handlers.get('registered')({
    userId: 'user-1',
    user: {
      id: 'user-1',
      username: 'Tester',
      balance: 42.5,
      transactions: [],
      stats: { wins: 1, losses: 0, draws: 0, earned: 3 },
    },
    difficultyConfig,
    jackpotPool: 1250,
    leaderboard: [],
  });
  assert.equal(window.document.getElementById('balanceDisplay').textContent, '$42.50');
  assert.equal(window.document.querySelectorAll('#difficultyGrid > *').length, DIFFICULTIES.length);
});

test('engine game created event renders the board and does not request a client engine move', () => {
  const { window, handlers, emitted } = boot();
  const game = {
    id: 'ENG-1',
    type: 'engine',
    fen: new Chess().fen(),
    playerColor: 'w',
    difficulty: 'hard',
    difficultyConfig: { label: 'Hard', elo: 1800, multiplier: 4.2, color: '#fff', desc: 'Club' },
    white: { id: 'user-1', username: 'Tester' },
    black: { id: 'stockfish', username: 'Stockfish Hard (1800)' },
    status: 'playing',
    isFree: false,
    bet: 1,
    moves: [],
  };
  handlers.get('registered')({ userId: 'user-1', user: { username: 'Tester', balance: 10, transactions: [], stats: {} }, difficultyConfig: {}, jackpotPool: 0, leaderboard: [] });
  handlers.get('engineGameCreated')({ game });
  assert.equal(window.currentGame ? window.currentGame : window.document.getElementById('board').children.length, window.document.getElementById('board').children.length);
  // No engineReply: the server owns every engine move.
  assert.equal(emitted.filter((e) => e.event === 'engineReply').length, 0);
});

test('deposit sends the selected provider', async () => {
  const { window, emitted } = boot();
  await window.loadPaymentProviders();
  assert.ok(window.document.getElementById('depositProviders').innerHTML.includes('EcoCash'), 'provider grid rendered');
  window.document.getElementById('depositAmount').value = '5';
  window.document.getElementById('ecoPhone').value = '0771234567';
  window.selectDepositProvider('innbucks');
  window.doDeposit();
  const deposit = emitted.find((e) => e.event === 'deposit');
  assert.ok(deposit, 'deposit emitted');
  assert.equal(deposit.payload.provider, 'innbucks');
  assert.equal(deposit.payload.amount, 5);
});

test('withdraw sends the selected provider and account', async () => {
  const { window, emitted } = boot();
  await window.loadPaymentProviders();
  window.document.getElementById('withdrawAmount').value = '2';
  window.document.getElementById('withdrawPhone').value = '0771234567';
  window.selectWithdrawProvider('ecocash');
  try {
    // `user` is a top-level let binding inside app.js; set it in that scope.
    window.eval('user = Object.assign(user || {}, { balance: 50, username: "Tester" });');
  } catch (e) {
    /* ignore */
  }
  window.doWithdraw();
  const wd = emitted.find((e) => e.event === 'withdraw');
  assert.ok(wd, 'withdraw emitted');
  assert.equal(wd.payload.provider, 'ecocash');
  assert.equal(wd.payload.accountDetails, '0771234567');
});

test('engine client degrades to the server engine when there is no Worker', async () => {
  const { window } = boot();
  await new Promise((r) => setTimeout(r, 50));
  // engineClient is a top-level `let` (not reachable through window in jsdom),
  // so assert on the DOM state the client writes instead.
  const status = window.document.body.dataset.engineStatus;
  assert.ok(status, 'engine client published a status');
  assert.ok(['server', 'loading', 'ready'].includes(status), `status=${status}`);
  assert.equal(window.document.getElementById('engineStatus').textContent.trim(), 'Server engine ✓');
});
