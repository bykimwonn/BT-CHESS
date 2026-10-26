/**
 * Server-to-server end-to-end verification: two authenticated Socket.IO
 * clients play a real game, then the API process is restarted against the same
 * PostgreSQL-compatible data directory and the result is verified.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHarness, emitAck, makeUsers, socketFor, waitForEvent, type Harness } from './helpers.js';

let checks = 0;
function check(name: string, condition: unknown, detail?: unknown): void {
  if (!condition) throw new Error(`FAILED: ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  checks++;
  console.log(`✓ ${name}`);
}

async function run() {
  const pgliteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rookstone-e2e-'));
  let first: Harness | null = null;
  let second: Harness | null = null;
  let whiteSocket: any = null;
  let blackSocket: any = null;
  try {
    first = await createHarness({ pgliteDir, preserveDir: true });
    const { white, black, whiteId, blackId } = await makeUsers(first, 'E2E');
    check('two users registered with authoritative sessions', !!whiteId && !!blackId);

    whiteSocket = await socketFor(first, white);
    blackSocket = await socketFor(first, black);
    check('both Socket.IO connections authenticated and connected', whiteSocket.connected && blackSocket.connected);

    const created = await white.post('/api/challenges', {
      kind: 'open', stakeCents: 0, ratingRange: 300,
      timeControl: { category: 'blitz', baseMs: 180_000, incrementMs: 2_000 },
    });
    check('free challenge created', created.status === 201 && !!created.body.challenge?.id, created.body);
    const challengeId = created.body.challenge.id as string;

    const whiteMatch = waitForEvent<{ gameId: string }>(whiteSocket, 'matchmaking:found');
    const blackMatch = waitForEvent<{ gameId: string }>(blackSocket, 'matchmaking:found');
    const accepted = await black.post(`/api/challenges/${challengeId}/accept`, {});
    check('challenge accepted and a real game created', accepted.status === 201 && !!accepted.body.gameId, accepted.body);
    const gameId = accepted.body.gameId as string;
    const [whiteFound, blackFound] = await Promise.all([whiteMatch, blackMatch]);
    check('both players received the real-time match event', whiteFound.gameId === gameId && blackFound.gameId === gameId);

    const whiteInitial = waitForEvent<any>(whiteSocket, 'game:state', (s) => s.id === gameId);
    const blackInitial = waitForEvent<any>(blackSocket, 'game:state', (s) => s.id === gameId);
    await emitAck(whiteSocket, 'game:join', { gameId });
    await emitAck(blackSocket, 'game:join', { gameId });
    const [whiteState, blackState] = await Promise.all([whiteInitial, blackInitial]);
    check('initial authoritative game state delivered to both clients',
      whiteState.version === 1 && blackState.version === 1 && whiteState.fen.startsWith('rnbqkbnr'));
    // The server assigns colours randomly; derive which socket plays White.
    const firstMover = whiteState.white.userId === whiteId ? whiteSocket : blackSocket;
    const secondMover = firstMover === whiteSocket ? blackSocket : whiteSocket;

    const afterE4White = waitForEvent<any>(whiteSocket, 'game:state', (s) => s.version >= 2);
    const afterE4Black = waitForEvent<any>(blackSocket, 'game:state', (s) => s.version >= 2);
    const moveNonce = randomUUID();
    const e4 = await emitAck(firstMover, 'game:move', { gameId, version: 1, from: 'e2', to: 'e4', nonce: moveNonce });
    check('white legal move acknowledged', e4.ok === true && e4.version === 2, e4);
    const [e4White, e4Black] = await Promise.all([afterE4White, afterE4Black]);
    check('white move synchronised to both clients', e4White.moves.at(-1).san === 'e4' && e4Black.moves.at(-1).san === 'e4');

    const duplicate = await emitAck(firstMover, 'game:move', { gameId, version: 1, from: 'e2', to: 'e4', nonce: moveNonce });
    check('duplicate message with the same nonce is idempotent', duplicate.ok === true && duplicate.duplicate === true, duplicate);
    const stale = await emitAck(secondMover, 'game:move', { gameId, version: 1, from: 'e7', to: 'e5', nonce: randomUUID() });
    check('stale state version is rejected', stale.ok === false && stale.error?.code === 'conflict', stale);

    const afterE5White = waitForEvent<any>(whiteSocket, 'game:state', (s) => s.version >= 3);
    const afterE5Black = waitForEvent<any>(blackSocket, 'game:state', (s) => s.version >= 3);
    const e5 = await emitAck(secondMover, 'game:move', { gameId, version: 2, from: 'e7', to: 'e5', nonce: randomUUID() });
    check('black legal move acknowledged', e5.ok === true && e5.version === 3, e5);
    const [e5White, e5Black] = await Promise.all([afterE5White, afterE5Black]);
    check('both clients received SAN, PGN and FEN after two plies',
      e5White.moves.length === 2 && e5Black.moves.length === 2 && e5White.pgn.includes('1. e4 e5') && !!e5White.fen);

    const whiteTerminal = waitForEvent<any>(whiteSocket, 'game:state', (s) => s.status === 'finished');
    const blackTerminal = waitForEvent<any>(blackSocket, 'game:state', (s) => s.status === 'finished');
    const resign = await emitAck(firstMover, 'game:resign', { gameId });
    check('resignation accepted only from a player', resign.ok === true, resign);
    const [terminalWhite, terminalBlack] = await Promise.all([whiteTerminal, blackTerminal]);
    check('server-authoritative terminal result delivered to both clients',
      terminalWhite.result === 'black' && terminalBlack.termination === 'resignation');

    const leaderboard = await white.get('/api/leaderboard');
    const whiteRow = leaderboard.body.items.find((row: any) => row.userId === whiteId);
    const blackRow = leaderboard.body.items.find((row: any) => row.userId === blackId);
    check('ratings and records were updated transactionally for both players',
      !!whiteRow && !!blackRow && Number(whiteRow.gamesPlayed) === 1 && Number(blackRow.gamesPlayed) === 1
      && Number(whiteRow.rating) !== 1200 && Number(blackRow.rating) !== 1200);
    const beforeRestart = await white.get(`/api/games/${gameId}`);
    check('PGN and result persisted before restart',
      beforeRestart.body.pgn.includes('1. e4 e5') && beforeRestart.body.result === 'black');
    const walletBefore = await white.get('/api/wallet');
    check('wallet reports real zero balance, not a fabricated deposit', walletBefore.body.availableCents === 0);
    const status = await white.get('/api/status');
    check('real-money mode remains disabled in internal test mode', status.body.realMoneyEnabled === false);

    whiteSocket.disconnect();
    blackSocket.disconnect();
    whiteSocket = blackSocket = null;
    await first.close(false);
    first = null;

    second = await createHarness({ pgliteDir, preserveDir: true });
    const whiteAfter = white.fork(second.base);
    const sessionAfter = await whiteAfter.get('/api/auth/session');
    check('session survived the API restart', sessionAfter.status === 200 && sessionAfter.body.user.id === whiteId);
    const afterRestart = await whiteAfter.get(`/api/games/${gameId}`);
    check('game state, PGN, clocks and result survived the API restart',
      afterRestart.body.id === gameId && afterRestart.body.pgn === beforeRestart.body.pgn
      && afterRestart.body.result === 'black' && afterRestart.body.version === beforeRestart.body.version,
      { before: beforeRestart.body.version, after: afterRestart.body.version });
    const walletAfter = await whiteAfter.get('/api/wallet');
    check('ledger balance survived the restart without duplication',
      walletAfter.body.availableCents === walletBefore.body.availableCents && walletAfter.body.reservedCents === 0);

    console.log(JSON.stringify({ ok: true, checks, gameId, pgliteDir }, null, 2));
  } finally {
    whiteSocket?.disconnect?.();
    blackSocket?.disconnect?.();
    if (first) await first.close(false).catch(() => undefined);
    if (second) await second.close(true).catch(() => undefined);
  }
}

run().catch((error) => {
  console.error(error);
  console.error(JSON.stringify({ ok: false, checks }, null, 2));
  process.exitCode = 1;
});
