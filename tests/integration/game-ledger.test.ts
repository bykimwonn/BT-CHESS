import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, createStakedGame, makeUsers, createAdmin } from '../helpers.js';

test('moves are authoritative: stale versions, duplicate nonces and out-of-turn moves are rejected', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { whiteId, blackId } = await makeUsers(harness, 'Move');
  const created = await harness.ctx.games.createGame({
    whiteId, blackId, mode: 'free',
    timeControl: { category: 'blitz', baseMs: 180_000, incrementMs: 2_000 },
  });
  const gameId = created.gameId;
  const first = await harness.ctx.games.submitMove(whiteId, {
    gameId, version: 1, from: 'e2', to: 'e4', nonce: 'move-nonce-0001',
  });
  assert.equal(first.snapshot.version, 2);
  assert.equal(first.snapshot.moves[0].san, 'e4');
  assert.equal(first.snapshot.pgn.includes('1. e4'), true);

  const duplicate = await harness.ctx.games.submitMove(whiteId, {
    gameId, version: 1, from: 'e2', to: 'e4', nonce: 'move-nonce-0001',
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.snapshot.version, 2);
  assert.equal(duplicate.snapshot.moves.length, 1);

  await assert.rejects(() => harness.ctx.games.submitMove(blackId, {
    gameId, version: 1, from: 'e7', to: 'e5', nonce: 'move-nonce-0002',
  }), /Stale game state/);
  await assert.rejects(() => harness.ctx.games.submitMove(whiteId, {
    gameId, version: 2, from: 'e2', to: 'e4', nonce: 'move-nonce-0003',
  }), /not your turn/);
  await assert.rejects(() => harness.ctx.games.submitMove(blackId, {
    gameId, version: 2, from: 'e7', to: 'e6', promotion: 'q', nonce: 'move-nonce-0004',
  }), /Illegal move/);
  const snapshot = await harness.ctx.games.getSnapshot(gameId);
  assert.equal(snapshot.moves.length, 1);
});

test('server clock timeout adjudicates from persisted turn timestamps', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { whiteId, blackId } = await makeUsers(harness, 'Clock');
  const created = await harness.ctx.games.createGame({
    whiteId, blackId, mode: 'free',
    timeControl: { category: 'custom', baseMs: 1_200, incrementMs: 0 },
  });
  await new Promise((resolve) => setTimeout(resolve, 1_350));
  await harness.ctx.games.checkTimeouts();
  const snapshot = await harness.ctx.games.getSnapshot(created.gameId);
  assert.equal(snapshot.status, 'finished');
  assert.equal(snapshot.result, 'black');
  assert.equal(snapshot.termination, 'timeout');
  assert.equal(snapshot.whiteClockMs, 0);
});

test('decisive competition settlement is exactly-once and balances the ledger', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { whiteId, blackId } = await makeUsers(harness, 'Settle');
  const { gameId, terms } = await createStakedGame(harness.ctx, whiteId, blackId, 100, 500);
  await harness.ctx.games.resign(whiteId, gameId);

  const snapshot = await harness.ctx.games.getSnapshot(gameId);
  assert.equal(snapshot.result, 'black');
  assert.equal(snapshot.termination, 'resignation');
  const settlement = await harness.ctx.settlement.getForGame(gameId);
  assert.equal(settlement.status, 'posted');
  assert.equal(Number(settlement.fee_cents), 10);
  assert.equal(Number(settlement.payout_cents), 190);
  assert.equal(Number(settlement.winner_id === blackId), 1);

  const whiteWallet = await harness.ctx.ledger.walletView(whiteId);
  const blackWallet = await harness.ctx.ledger.walletView(blackId);
  assert.equal(whiteWallet.availableCents, 100);
  assert.equal(whiteWallet.reservedCents, 0);
  assert.equal(blackWallet.availableCents, 290);
  assert.equal(blackWallet.reservedCents, 0);

  const gameRow = { id: gameId, white_id: whiteId, black_id: blackId, mode: 'test', terms };
  const duplicate = await harness.ctx.settlement.settleInTransaction(harness.db, gameRow as never, 'black', 'resignation');
  assert.equal(duplicate.status, 'duplicate');
  const posted = await harness.db.query(
    `SELECT COUNT(*)::int AS n FROM ledger_transactions WHERE game_id = $1 AND type = 'competition_settlement' AND status = 'posted'`, [gameId]);
  assert.equal(Number(posted.rows[0].n), 1);
  const reconciliation = await harness.ctx.ledger.reconcile();
  assert.equal(reconciliation.discrepancies.length, 0);
  assert.equal(reconciliation.unbalancedTransactions.length, 0);
});

test('draw refunds both stakes with no commission', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { whiteId, blackId } = await makeUsers(harness, 'Draw');
  const { gameId } = await createStakedGame(harness.ctx, whiteId, blackId, 50, 500);
  await harness.ctx.games.offerDraw(whiteId, gameId);
  await harness.ctx.games.answerDraw(blackId, gameId, true);
  const settlement = await harness.ctx.settlement.getForGame(gameId);
  assert.equal(settlement.status, 'posted');
  assert.equal(Number(settlement.fee_cents), 0);
  assert.equal(Number(settlement.payout_cents), 50);
  const white = await harness.ctx.ledger.walletView(whiteId);
  const black = await harness.ctx.ledger.walletView(blackId);
  assert.equal(white.availableCents, 100);
  assert.equal(black.availableCents, 100);
  assert.equal(white.reservedCents, 0);
  assert.equal(black.reservedCents, 0);
});

test('stake reservation cannot overdraw either player', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { whiteId, blackId } = await makeUsers(harness, 'Over');
  await harness.ctx.payments.grantTestCredits(whiteId, 100, whiteId);
  await harness.ctx.payments.grantTestCredits(blackId, 50, blackId);
  const white = await harness.ctx.ledger.ensureUserAccounts(harness.db, whiteId);
  const black = await harness.ctx.ledger.ensureUserAccounts(harness.db, blackId);
  await assert.rejects(() => harness.ctx.ledger.postTransaction({
    type: 'stake_reservation', reference: 'RSV-OVERDRAW', idempotencyKey: 'reservation:overdraw',
    description: 'Attempt to reserve without enough funds',
    entries: [
      { accountId: white.availableId, amountCents: -100 },
      { accountId: white.reservedId, amountCents: 100 },
      { accountId: black.availableId, amountCents: -100 },
      { accountId: black.reservedId, amountCents: 100 },
    ],
  }), /Insufficient/);
  assert.equal((await harness.ctx.ledger.walletView(blackId)).availableCents, 50);
  assert.equal((await harness.ctx.ledger.walletView(whiteId)).availableCents, 100);
});

test('an unresolved dispute blocks settlement until human resolution', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { whiteId, blackId } = await makeUsers(harness, 'Dispute');
  const admin = await createAdmin(harness.ctx, 'DisputeAdmin', 'dispute-admin@example.com');
  const { gameId } = await createStakedGame(harness.ctx, whiteId, blackId, 100, 500);
  const dispute = await harness.ctx.games.openDispute(whiteId, gameId, 'Connection concern', 'Please review the clock timeline.');
  assert.equal(dispute.settlementBlocked, true);
  await harness.ctx.games.resign(whiteId, gameId);
  const before = await harness.ctx.settlement.getForGame(gameId);
  assert.equal(before.status, 'blocked');
  const resolution = await harness.ctx.admin.resolveDispute(admin.id, dispute.id, 'reject', 'Reviewed persisted clocks and authoritative move log.', true);
  assert.match(resolution.outcome, /authoritative result/i);
  const after = await harness.ctx.settlement.getForGame(gameId);
  assert.equal(after.status, 'posted');
});

test('paid challenges require exact hashed terms and are rejected without acceptance', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { white, whiteId, blackId } = await makeUsers(harness, 'Terms');
  await harness.ctx.payments.grantTestCredits(whiteId, 1000, whiteId);
  await harness.ctx.payments.grantTestCredits(blackId, 1000, blackId);
  const quote = await harness.ctx.competition.quote({
    context: 'challenge', kind: 'open', stakeCents: 100,
    timeControl: { category: 'blitz', baseMs: 180_000, incrementMs: 2_000 }, ratingRange: 300,
  }, whiteId);
  assert.equal(quote.terms?.payoutCents, 190);
  assert.equal(quote.allowed, true);
  await assert.rejects(() => harness.ctx.competition.createChallenge(whiteId, {
    kind: 'open', stakeCents: 100,
    timeControl: { category: 'blitz', baseMs: 180_000, incrementMs: 2_000 }, ratingRange: 300,
    acceptedTermsHash: 'f'.repeat(64),
  }), /exact disclosed competition terms/);
  const created = await harness.ctx.competition.createChallenge(whiteId, {
    kind: 'open', stakeCents: 100,
    timeControl: { category: 'blitz', baseMs: 180_000, incrementMs: 2_000 }, ratingRange: 300,
    acceptedTermsHash: quote.termsHash,
  });
  assert.equal(created.challenge.stakeCents, 100);
  const accepted = await harness.ctx.competition.acceptChallenge(blackId, created.challenge.id, { acceptedTermsHash: quote.termsHash });
  assert.ok(accepted.gameId);
  const snapshot = await harness.ctx.games.getSnapshot(accepted.gameId);
  assert.equal(snapshot.competition?.payoutCents, 190);
  assert.ok(white.cookie.includes('rs_session'));
});
