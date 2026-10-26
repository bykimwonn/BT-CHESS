import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIME_PRESETS } from '../../shared/contracts.js';
import { createHarness, makeUsers, fundUser, type Harness } from '../helpers.js';

const { hmacHex } = await import('../../server/services/ids.js');
const { EligibilityService } = await import('../../server/eligibility/service.js');
const { PaymentService } = await import('../../server/payments/service.js');

const BLITZ = TIME_PRESETS.blitz;

class FakeProvider {
  id = 'paynow' as const;
  name = 'Fake Paynow';
  docsUrl = 'https://example.invalid/docs';
  state: any = 'failed';
  amountCents: number | null = 100;
  authenticated = true;
  calls = 0;
  health() {
    return {
      id: 'paynow', name: this.name, configured: true, sandbox: true,
      enabledForRealMoney: false, reason: 'Integration test fake', capabilities: ['deposit-redirect', 'server-status-lookup'],
    };
  }
  async initiateDeposit(input: any) {
    return {
      providerReference: `FAKE-${input.reference}`, redirectUrl: null,
      instructions: 'Sandbox test only', metadata: { kind: 'deposit', fake: true }, sandbox: true,
    };
  }
  async initiateWithdrawal(): Promise<any> { throw new Error('not implemented'); }
  parseCallback(rawBody: string) {
    const body = JSON.parse(rawBody);
    return {
      eventId: String(body.eventId),
      authenticated: this.authenticated && body.authenticated !== false,
      references: [String(body.reference)],
      reason: this.authenticated ? undefined : 'invalid test signature',
      raw: body,
    };
  }
  async checkStatus(input: any) {
    this.calls++;
    return {
      state: this.state, amountCents: this.amountCents, currency: 'USD',
      providerReference: input.providerReference ?? 'FAKE', raw: { fake: true, call: this.calls }, authoritative: true,
    };
  }
}

function fakePayments(harness: Harness, fake: FakeProvider) {
  const adapters: any = {
    paynow: fake,
    ecocash: { ...fake, id: 'ecocash', name: 'Fake EcoCash' },
    onemoney: { ...fake, id: 'onemoney', name: 'Fake OneMoney' },
    pesepay: { ...fake, id: 'pesepay', name: 'Fake PesePay' },
  };
  return new PaymentService(
    harness.db, harness.ctx.ledger, harness.ctx.auth, harness.ctx.eligibility,
    harness.ctx.compliance, adapters, harness.ctx.log,
  );
}

test('free international play needs no deposit and creates no financial transaction', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const zimbabwe = harness.client();
  const japan = harness.client();
  const zw = await zimbabwe.register('FreeZW', 'free-zw@example.com', 'Password123!', {
    country: 'ZW', countryShared: true, timezone: 'Africa/Harare', timezoneShared: true,
  });
  const jp = await japan.register('FreeJP', 'free-jp@example.com', 'Password123!', {
    country: 'JP', countryShared: true, timezone: 'Asia/Tokyo', timezoneShared: true,
  });

  const anonymous = harness.client();
  const globalEligibility = await anonymous.get('/api/eligibility');
  assert.equal(globalEligibility.status, 200);
  assert.equal(globalEligibility.body.freePlay.allowed, true);
  assert.equal(globalEligibility.body.moneyMatches.allowed, false);

  const zwEligibility = await zimbabwe.get('/api/me/international');
  const jpEligibility = await japan.get('/api/me/international');
  assert.equal(zwEligibility.body.countryOfResidence, 'ZW');
  assert.equal(jpEligibility.body.countryOfResidence, 'JP');
  assert.equal(zwEligibility.body.freePlay.allowed, true);
  assert.equal(jpEligibility.body.freePlay.allowed, true);
  assert.equal(zwEligibility.body.moneyMatches.allowed, false);
  assert.equal(jpEligibility.body.moneyMatches.allowed, false);

  const created = await harness.ctx.games.createGame({
    whiteId: zw.user.id, blackId: jp.user.id, mode: 'free', timeControl: BLITZ,
  });
  const snapshot = await harness.ctx.games.getSnapshot(created.gameId);
  assert.match(snapshot.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(snapshot.white.countryShared, true);
  assert.equal(snapshot.black.countryShared, true);
  assert.equal(snapshot.white.timezone, 'Africa/Harare');
  assert.equal(snapshot.black.timezone, 'Asia/Tokyo');
  assert.ok(snapshot.legalMoves.includes('e2e4'));

  await harness.ctx.games.submitMove(zw.user.id, {
    gameId: created.gameId, version: 1, from: 'e2', to: 'e4', nonce: 'free-intl-e4',
  });
  await harness.ctx.games.submitMove(jp.user.id, {
    gameId: created.gameId, version: 2, from: 'e7', to: 'e5', nonce: 'free-intl-e5',
  });
  await harness.ctx.games.resign(zw.user.id, created.gameId);
  const journals = await harness.db.query(
    'SELECT COUNT(*)::int AS n FROM ledger_transactions WHERE game_id = $1 OR type LIKE $2',
    [created.gameId, '%deposit%'],
  );
  assert.equal(Number(journals.rows[0].n), 0);
});

test('a selected country cannot override a restricted verified jurisdiction', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { whiteId, white } = await makeUsers(harness, 'Juris');
  // Make the voluntary country permissive, but the verified jurisdiction restrictive.
  await harness.db.query(
    `UPDATE jurisdiction_policies
     SET real_money_allowed = TRUE, permitted_competition_types = ARRAY['free','test','real'],
         allowed_providers = ARRAY['paynow','ecocash','pesepay'], reason = 'Test permissive country policy'
     WHERE code = 'US'`,
  );
  await harness.db.query(
    `UPDATE users SET country = 'US', country_shared = TRUE,
       email_verified = TRUE, age_verified = TRUE, identity_verified = TRUE,
       eligibility_jurisdiction = 'ZW', eligibility_verified_at = now(),
       eligibility_provider_ref = 'test-provider', location_verified_at = now()
     WHERE id = $1`, [whiteId],
  );
  await fundUser(harness.ctx, whiteId, 1000);

  const authorisedCompliance = {
    ...harness.ctx.compliance,
    realMoneyEnabled: true, competitionsEnabled: true, blockers: [], testMode: false,
  };
  const eligibility = new EligibilityService(harness.db, authorisedCompliance, harness.ctx.log);
  const state = await eligibility.stateFor(whiteId);
  assert.equal(state.countryOfResidence, 'US');
  assert.equal(state.verifiedEligibilityJurisdiction, 'ZW');
  assert.equal(state.policyCode, 'ZW');
  assert.equal(state.moneyMatches.allowed, false);
  await assert.rejects(() => eligibility.assertRealMoneyEligible(whiteId), /Money matches are not available/);
  await assert.rejects(() => eligibility.assertPaymentProviderAllowed(whiteId, 'paynow'), /not an approved payment provider/);

  const quote = await harness.ctx.competition.quote({
    context: 'challenge', kind: 'open', stakeCents: 100, timeControl: BLITZ, ratingRange: 300,
  }, whiteId);
  assert.equal(quote.allowed, false);
  await assert.rejects(() => harness.ctx.competition.createChallenge(whiteId, {
    kind: 'open', stakeCents: 100, timeControl: BLITZ, ratingRange: 300,
    acceptedTermsHash: quote.termsHash ?? 'f'.repeat(64),
  }), /Money matches are not available/);
  assert.ok(white.cookie.includes('rs_session'));
});

test('a staked match requires identical accepted terms and verified funds before a game exists', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { white, whiteId, blackId } = await makeUsers(harness, 'Stake');
  await fundUser(harness.ctx, whiteId, 100);
  const quote = await harness.ctx.competition.quote({
    context: 'challenge', kind: 'open', stakeCents: 100, timeControl: BLITZ, ratingRange: 300,
  }, whiteId);
  assert.equal(quote.allowed, true);
  assert.equal(quote.terms?.stakeCents, 100);
  const created = await harness.ctx.competition.createChallenge(whiteId, {
    kind: 'open', stakeCents: 100, timeControl: BLITZ, ratingRange: 300,
    acceptedTermsHash: quote.termsHash,
  });

  await assert.rejects(() => harness.ctx.competition.acceptChallenge(blackId, created.challenge.id, {}),
    /exact disclosed competition terms/);
  await assert.rejects(() => harness.ctx.competition.acceptChallenge(blackId, created.challenge.id,
    { acceptedTermsHash: quote.termsHash ?? '' }), /Insufficient|funds/i);

  let games = await harness.db.query('SELECT id FROM games WHERE challenge_id = $1', [created.challenge.id]);
  assert.equal(games.rows.length, 0);
  const reservation = await harness.db.query(
    `SELECT COUNT(*)::int AS n FROM ledger_transactions WHERE reference = $1 AND status = 'posted'`,
    [`RSV-${created.challenge.id}`],
  );
  assert.equal(Number(reservation.rows[0].n), 0);

  await fundUser(harness.ctx, blackId, 100);
  const accepted = await harness.ctx.competition.acceptChallenge(blackId, created.challenge.id,
    { acceptedTermsHash: quote.termsHash ?? '' });
  assert.ok(accepted.gameId);
  games = await harness.db.query('SELECT id, terms FROM games WHERE challenge_id = $1', [created.challenge.id]);
  assert.equal(games.rows.length, 1);
  assert.equal((games.rows[0].terms as any).payoutCents, 190);
  const whiteWallet = await harness.ctx.ledger.walletView(whiteId);
  const blackWallet = await harness.ctx.ledger.walletView(blackId);
  assert.equal(whiteWallet.reservedCents, 100);
  assert.equal(blackWallet.reservedCents, 100);
  assert.ok(white.cookie.includes('rs_session'));
});

test('payment failures, invalid signatures and amount mismatches cannot create fake balances', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const client = harness.client();
  const registered = await client.register('PayFail', 'pay-fail@example.com');
  const userId = registered.user.id;
  const fake = new FakeProvider();
  const payments = fakePayments(harness, fake);

  const first = await payments.initiateDeposit(userId, { provider: 'paynow', amountCents: 100 });
  fake.state = 'failed';
  const failed = await payments.handleCallback('paynow', JSON.stringify({ eventId: 'evt-failed', reference: first.id, authenticated: true }), {});
  assert.equal(failed.authenticated, true);
  assert.equal((await harness.ctx.ledger.walletView(userId)).availableCents, 0);

  const second = await payments.initiateDeposit(userId, { provider: 'paynow', amountCents: 100 });
  fake.state = 'paid';
  fake.amountCents = 100;
  const paid = await payments.handleCallback('paynow', JSON.stringify({ eventId: 'evt-paid', reference: second.id, authenticated: true }), {});
  assert.equal(paid.processed.length, 1);
  assert.equal((await harness.ctx.ledger.walletView(userId)).availableCents, 100);

  const replay = await payments.handleCallback('paynow', JSON.stringify({ eventId: 'evt-paid', reference: second.id, authenticated: true }), {});
  assert.equal(replay.duplicate, true);
  assert.equal((await harness.ctx.ledger.walletView(userId)).availableCents, 100);

  const third = await payments.initiateDeposit(userId, { provider: 'paynow', amountCents: 100 });
  fake.amountCents = 999;
  const mismatch = await payments.handleCallback('paynow', JSON.stringify({ eventId: 'evt-mismatch', reference: third.id, authenticated: true }), {});
  assert.ok(mismatch.processed.length <= 1);
  assert.equal((await harness.ctx.ledger.walletView(userId)).availableCents, 100);

  fake.amountCents = 100;
  fake.authenticated = false;
  const forged = await payments.handleCallback('paynow', JSON.stringify({ eventId: 'evt-forged', reference: second.id, authenticated: false }), {});
  assert.equal(forged.authenticated, false);
  assert.equal((await harness.ctx.ledger.walletView(userId)).availableCents, 100);

  const credits = await harness.db.query(
    `SELECT COUNT(*)::int AS n FROM ledger_transactions WHERE type IN ('deposit_credit','test_deposit_credit') AND status = 'posted'`,
  );
  assert.equal(Number(credits.rows[0].n), 1);
});

test('currency-specific accounts stay isolated and conversion quotes never move money', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { whiteId } = await makeUsers(harness, 'Currency');
  const ledger = harness.ctx.ledger;
  const eur = await ledger.ensureUserAccounts(harness.db, whiteId, 'EUR');
  const externalEur = await ledger.systemAccountId(harness.db, 'EUR', 'external');
  await ledger.postTransaction({
    type: 'test_deposit_credit', reference: 'EUR-ISOLATION', idempotencyKey: 'eur-isolation',
    description: 'EUR isolation test', currency: 'EUR',
    entries: [
      { accountId: externalEur, amountCents: -100 },
      { accountId: eur.availableId, amountCents: 100 },
    ],
  });
  assert.equal((await ledger.walletView(whiteId, 'EUR')).availableCents, 100);
  assert.equal((await ledger.walletView(whiteId, 'USD')).availableCents, 0);
  const reconciliation = await ledger.reconcile();
  assert.ok(reconciliation.currencies.includes('USD'));
  assert.ok(reconciliation.currencies.includes('EUR'));
  assert.equal(reconciliation.discrepancies.length, 0);

  await assert.rejects(() => ledger.postTransaction({
    type: 'mixed', reference: 'MIXED-CURRENCY', idempotencyKey: 'mixed-currency',
    description: 'Should fail', currency: 'USD',
    entries: [
      { accountId: externalEur, amountCents: -10 },
      { accountId: eur.availableId, amountCents: 10 },
    ],
  }), /Currency mismatch/);

  await harness.ctx.eligibility.recordExchangeRate(whiteId, {
    fromCurrency: 'USD', toCurrency: 'EUR', rate: '0.920000000000',
    effectiveAt: new Date(Date.now() - 60_000).toISOString(), source: 'Test reference', evidenceRef: 'unit-test',
  }, 'Documented test exchange rate');
  const quote = await harness.ctx.eligibility.quoteConversion(whiteId, {
    fromCurrency: 'USD', toCurrency: 'EUR', amountCents: 1000,
  });
  assert.equal(Number(quote.convertedCents), 920);
  assert.equal(quote.applied, false);
  assert.equal((await ledger.walletView(whiteId, 'EUR')).availableCents, 100);
  assert.equal((await ledger.walletView(whiteId, 'USD')).availableCents, 0);
});

test('free international tournaments pair real entrants and update standings without money', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { white, whiteId, black } = await makeUsers(harness, 'Tourney');
  const created = await white.post('/api/tournaments', {
    name: 'Global Blitz Test', timeControl: BLITZ, maxPlayers: 8, rated: true,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const tournamentId = created.body.id as string;
  const joinA = await white.post(`/api/tournaments/${tournamentId}/join`, {});
  const joinB = await black.post(`/api/tournaments/${tournamentId}/join`, {});
  assert.equal(joinA.status, 200);
  assert.equal(joinB.status, 200);
  const started = await white.post(`/api/tournaments/${tournamentId}/start`, {});
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.pairings.length, 1);
  const gameId = started.body.pairings[0].gameId as string;
  assert.ok(gameId);

  const whitePlayerId = started.body.pairings[0].whiteId as string;
  await harness.ctx.games.resign(whitePlayerId, gameId);
  const detail = await white.get(`/api/tournaments/${tournamentId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.standings.length, 2);
  assert.equal(detail.body.standings.find((s: any) => s.userId !== whitePlayerId).points, 2);
  const journals = await harness.db.query('SELECT COUNT(*)::int AS n FROM ledger_transactions');
  assert.equal(Number(journals.rows[0].n), 0);
  const leaderboard = await harness.ctx.games.leaderboard();
  assert.equal(leaderboard.length, 2);
  assert.ok(leaderboard.every((row) => Number(row.games_played) === 1));
});

test('signed eligibility verification sets a verified jurisdiction without trusting a chosen country', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const client = harness.client();
  const registered = await client.register('Eligible', 'eligible@example.com', 'Password123!', {
    country: 'US', countryShared: true, timezone: 'America/New_York', timezoneShared: false,
  });
  const secret = process.env.AGE_VERIFICATION_WEBHOOK_SECRET!;
  const payload = {
    userId: registered.user.id,
    providerReference: 'provider-ref-001',
    verified: true,
    identityVerified: true,
    locationVerified: true,
    jurisdiction: 'GB',
  };
  const raw = JSON.stringify(payload);
  const signedRaw = JSON.stringify({ ...payload, signature: hmacHex(secret, raw) });
  const valid = await client.request('POST', '/api/auth/eligibility-verification', signedRaw, { headers: { 'Content-Type': 'application/json' } });
  assert.equal(valid.status, 200, JSON.stringify(valid.body));
  const profile = await client.get('/api/me/international');
  assert.equal(profile.body.countryOfResidence, 'US');
  assert.equal(profile.body.verifiedEligibilityJurisdiction, 'GB');
  assert.equal(profile.body.policyCode, 'GB');

  const forgedRaw = JSON.stringify({ ...payload, signature: '0'.repeat(64) });
  const forged = await client.request('POST', '/api/auth/eligibility-verification', forgedRaw, { headers: { 'Content-Type': 'application/json' } });
  assert.equal(forged.status, 401);
});
