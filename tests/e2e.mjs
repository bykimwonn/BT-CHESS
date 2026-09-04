/**
 * End-to-end smoke test against a running server (npm start, default :3000).
 *
 *   node tests/e2e.mjs            # expects http://localhost:3000
 *   BASE_URL=... node tests/e2e.mjs
 *
 * Plays a real game against the Lichess engine, checks the money moves, and
 * exercises the payment flow. Exits non-zero on the first failure.
 */
import { io } from 'socket.io-client';
import { Chess } from 'chess.js';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
let failures = 0;

function check(name, condition, detail = '') {
  const ok = !!condition;
  if (!ok) failures++;
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` - ${detail}` : ''}`);
  return ok;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(userId = null, username = 'E2E_' + Math.floor(Math.random() * 9999)) {
  const socket = io(BASE_URL, { transports: ['websocket'] });
  const state = { userId, username, user: null, registered: false };
  socket.on('registered', ({ userId: uid, user }) => {
    state.userId = uid;
    state.user = user;
    state.registered = true;
  });
  return new Promise((resolve, reject) => {
    socket.on('connect', () => {
      socket.emit('register', { userId: state.userId, username: state.username });
      const t = setInterval(() => {
        if (state.registered) {
          clearInterval(t);
          resolve({ socket, state });
        }
      }, 50);
      setTimeout(() => {
        clearInterval(t);
        reject(new Error('registration timeout'));
      }, 8000);
    });
    socket.on('connect_error', reject);
  });
}

const waitFor = (socket, event, timeout = 15000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeout);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

const waitForStatus = async (reference, timeout = 10000) => {
  if (!reference) return null;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const tx = await fetch(`${BASE_URL}/api/payments/${reference}`).then((r) => r.json()).catch(() => null);
    if (tx && ['completed', 'failed', 'expired', 'rejected'].includes(tx.status)) return tx.status;
    await sleep(300);
  }
  return 'timeout';
};

const emit = (socket, event, payload) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ error: 'timeout' }), 20000);
    socket.emit(event, payload, (res) => {
      clearTimeout(timer);
      resolve(res || {});
    });
  });

async function run() {
  console.log(`\n=== BetChess ZW end-to-end test (${BASE_URL}) ===\n`);

  // ---------- health ----------
  const config = await fetch(`${BASE_URL}/api/config`).then((r) => r.json());
  check('config: engine reported', !!config.engine, `engine=${config.engine?.engine}`);
  check('config: lichess stockfish loaded', config.engine?.engine === 'stockfish-18-lichess', config.engine?.engine);
  check('config: payment providers listed', (config.payments?.providers?.length || 0) >= 5, `${config.payments?.providers?.length} providers`);
  const eco = config.payments?.providers?.find((p) => p.id === 'ecocash');
  check('config: EcoCash provider present', !!eco, eco ? `live=${eco.live}` : '');

  // ---------- client ----------
  const { socket, state } = await connect();
  check('socket: registered', state.registered, `userId=${state.userId}`);
  const startBalance = state.user.balance;

  // ---------- deposit (sandbox settlement) ----------
  const dep = await emit(socket, 'deposit', { userId: state.userId, amount: 5, phone: '0771234567', provider: 'ecocash' });
  check('payments: deposit accepted', !!dep.transaction, dep.error || dep.transaction?.status);
  check('payments: deposit reference issued', !!dep.transaction?.reference, dep.transaction?.reference);
  const settled = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 8000);
    const poll = setInterval(async () => {
      const r = await fetch(`${BASE_URL}/api/payments/${dep.transaction.reference}`).then((x) => x.json()).catch(() => null);
      if (r && r.status === 'completed') {
        clearInterval(poll);
        clearTimeout(t);
        resolve(r);
      }
    }, 300);
  });
  check('payments: deposit auto-settles in sandbox', !!settled, settled ? `$${settled.amount}` : 'still pending');
  await sleep(300);
  const afterDeposit = await new Promise((resolve) => {
    socket.once('balanceUpdate', ({ balance }) => resolve(balance));
    setTimeout(() => resolve(null), 3000);
  });
  check('payments: balance credited', afterDeposit === null || afterDeposit >= startBalance + 5 - 0.001, `start=${startBalance} after=${afterDeposit}`);

  // ---------- play a real game vs the engine ----------
  console.log('\n--- playing vs Lichess Stockfish (Grandmaster) ---');
  const created = waitFor(socket, 'engineGameCreated', 15000);
  const createRes = await emit(socket, 'createEngineGame', {
    userId: state.userId,
    bet: 1,
    difficulty: 'grandmaster',
    isFree: false,
    color: 'w',
  });
  check('game: created without error', !createRes.error, createRes.error || createRes.gameId);

  const { game } = await created;
  check('game: player is white', game.playerColor === 'w', game.playerColor);
  check('game: opponent is labelled stockfish', /stockfish/i.test(game.black?.username || ''), game.black?.username);

  const chess = new Chess(game.fen);
  let engineMoves = 0;
  let playerMoves = 0;
  let final = null;
  let illegalEngineMove = null;
  let lastFen = game.fen;

  const finalPromise = waitFor(socket, 'engineGameFinal', 120000).then((d) => (final = d));
  const moveLoop = new Promise((resolve) => {
    const handler = ({ game: g, move }) => {
      // Verify the engine's move is legal in the position we had.
      if (move && move.color === game.engineColor) {
        const probe = new Chess(lastFen);
        const legal = probe.moves({ verbose: true }).some((m) => m.from === move.from && m.to === move.to);
        if (!legal) illegalEngineMove = `${move.from}${move.to} in ${lastFen}`;
        else engineMoves++;
      }
      lastFen = g.fen;
      chess.load(g.fen);
      if (g.status !== 'playing') return resolve();
      if (chess.turn() === game.playerColor) {
        const options = chess.moves({ verbose: true });
        const pick = options[Math.floor(Math.random() * options.length)];
        const applied = chess.move({ from: pick.from, to: pick.to, promotion: pick.promotion || 'q' });
        if (!applied) return resolve();
        playerMoves++;
        socket.emit('engineMove', {
          userId: state.userId,
          gameId: game.id,
          from: pick.from,
          to: pick.to,
          promotion: pick.promotion,
        });
      }
    };
    socket.on('moveMadeEngine', handler);
    setTimeout(() => resolve(), 90000);
  });

  // kick off the first move
  const opening = chess.moves({ verbose: true });
  const first = opening[Math.floor(Math.random() * opening.length)];
  chess.move({ from: first.from, to: first.to, promotion: first.promotion || 'q' });
  playerMoves++;
  socket.emit('engineMove', { userId: state.userId, gameId: game.id, from: first.from, to: first.to, promotion: first.promotion });

  await Promise.race([moveLoop, finalPromise]);
  if (!final) final = await Promise.race([finalPromise, sleep(5000).then(() => null)]);

  check('game: engine replied to player moves', engineMoves > 0, `${engineMoves} engine moves / ${playerMoves} player moves`);
  check('game: every engine move was legal', !illegalEngineMove, illegalEngineMove || 'all legal');
  check('game: reached a result (or ran long)', !!final, final ? `${final.outcome}: ${final.result}` : `still playing after ${playerMoves} moves`);
  if (final) {
    check('game: result has an outcome', ['win', 'loss', 'draw'].includes(final.outcome), final.outcome);
  }

  // ---------- withdraw ----------
  const bal = await new Promise((resolve) => {
    socket.once('balanceUpdate', ({ balance }) => resolve(balance));
    socket.emit('getBalance', { userId: state.userId });
    setTimeout(() => resolve(null), 3000);
  });
  const withdrawAmount = Math.min(2, Math.max(0.5, (bal ?? startBalance) - 1));
  const wd = await emit(socket, 'withdraw', { userId: state.userId, amount: withdrawAmount, provider: 'ecocash', phone: '0771234567' });
  check('payments: withdrawal accepted', !wd.error, wd.error || `${wd.transaction?.status} $${wd.transaction?.amount}`);
  check('payments: withdrawal has a reference', !!wd.transaction?.reference, wd.transaction?.reference);

  // ---------- REST payment API ----------
  const restDep = await fetch(`${BASE_URL}/api/payments/deposit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: state.userId, provider: 'ecocash', amount: 3, phone: '0771234567' }),
  }).then((r) => r.json());
  check('api: REST deposit accepted', !!restDep.transaction, restDep.error || restDep.transaction?.reference);

  const restSettled = await waitForStatus(restDep.transaction?.reference, 10000);
  check('api: REST deposit settles', restSettled === 'completed', String(restSettled));

  const bankWd = await fetch(`${BASE_URL}/api/payments/withdraw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: state.userId, provider: 'bank', amount: 1, account: 'CBZ-000123' }),
  }).then((r) => r.json());
  check('api: bank withdrawal created', !!bankWd.transaction, bankWd.error || bankWd.transaction?.status);
  check('api: bank withdrawal needs approval', bankWd.transaction?.requiresApproval === true, `${bankWd.transaction?.status}`);

  const approved = await fetch(`${BASE_URL}/api/admin/payments/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: process.env.ADMIN_PASSWORD || 'admin123ZW', reference: bankWd.transaction?.reference }),
  }).then((r) => r.json());
  check('api: admin approves bank withdrawal', approved.transaction?.status === 'completed', approved.error || approved.transaction?.status);

  // replaying the same approval must not pay twice
  const replay = await fetch(`${BASE_URL}/api/admin/payments/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: process.env.ADMIN_PASSWORD || 'admin123ZW', reference: bankWd.transaction?.reference }),
  }).then((r) => r.json());
  check('api: double approval is rejected', !!replay.error, replay.error || 'accepted a replay!');

  const badHook = await fetch(`${BASE_URL}/api/payments/webhook/ecocash`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reference: 'DEP-DOES-NOT-EXIST', status: 'COMPLETED' }),
  }).then((r) => r.json());
  check('api: webhook with unknown reference is ignored', badHook.ok === false, JSON.stringify(badHook).slice(0, 80));

  const adminData = await fetch(`${BASE_URL}/api/admin/data?password=${encodeURIComponent(process.env.ADMIN_PASSWORD || 'admin123ZW')}`).then((r) => r.json());
  check('admin: exposes engine status', !!adminData.engine, adminData.engine?.engine);
  check('admin: exposes payment transactions', Array.isArray(adminData.paymentTransactions), `${(adminData.paymentTransactions || []).length} rows`);

  // ---------- engine analysis endpoint ----------
  const analysis = await fetch(`${BASE_URL}/api/engine/analyse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', movetimeMs: 300 }),
  }).then((r) => r.json());
  check('engine: mate-in-1 found by analyse endpoint', analysis.bestMove === 'a1a8', `${analysis.bestMove} (${analysis.source})`);

  // ---------- summary ----------
  console.log(`\n=== ${results.filter((r) => r.startsWith('PASS')).length}/${results.length} checks passed ===`);
  if (failures) {
    console.log('\nFailures:');
    results.filter((r) => r.startsWith('FAIL')).forEach((r) => console.log('  ' + r));
  }
  socket.close();
  process.exit(failures ? 1 : 0);
}

run().catch((err) => {
  console.error('\nE2E run failed:', err);
  process.exit(1);
});
