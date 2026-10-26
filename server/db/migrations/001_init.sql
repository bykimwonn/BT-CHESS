-- Rookstone Arena schema v1.
-- All money is integer USD cents. Ledger entries are immutable and each posted
-- journal must balance to zero; both invariants are enforced in the database.

CREATE TABLE users (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('player', 'admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'self_excluded')),
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  age_verified BOOLEAN NOT NULL DEFAULT FALSE,
  mfa_secret TEXT,
  mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  age_verified_at TIMESTAMPTZ,
  country CHAR(2) NOT NULL DEFAULT 'ZW',
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));
CREATE UNIQUE INDEX users_username_key ON users (lower(username));

CREATE TABLE profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  bio TEXT NOT NULL DEFAULT '',
  rating INTEGER NOT NULL DEFAULT 1200 CHECK (rating BETWEEN 100 AND 4000),
  puzzle_rating INTEGER NOT NULL DEFAULT 1200 CHECK (puzzle_rating BETWEEN 100 AND 4000),
  games_played INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  draws INTEGER NOT NULL DEFAULT 0,
  favourite_time_control TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE auth_sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_hash TEXT NOT NULL,
  ip_hash TEXT,
  user_agent TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE one_time_tokens (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('email_verify', 'password_reset')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE security_events (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  ip_hash TEXT,
  user_agent TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX security_events_created_idx ON security_events (created_at DESC);

CREATE TABLE rating_history (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id UUID,
  rating_before INTEGER NOT NULL,
  rating_after INTEGER NOT NULL,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX rating_history_user_idx ON rating_history (user_id, created_at DESC);

CREATE TABLE challenges (
  id UUID PRIMARY KEY,
  creator_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  opponent_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('open', 'direct', 'private')),
  invite_token_hash TEXT UNIQUE,
  time_control JSONB NOT NULL,
  stake_cents BIGINT NOT NULL DEFAULT 0 CHECK (stake_cents >= 0),
  fee_bps INTEGER NOT NULL DEFAULT 500 CHECK (fee_bps BETWEEN 0 AND 2500),
  terms JSONB,
  terms_hash TEXT,
  rating_range INTEGER NOT NULL DEFAULT 300,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'cancelled', 'expired', 'matched')),
  game_id UUID,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at TIMESTAMPTZ
);
CREATE INDEX challenges_open_idx ON challenges (status, created_at DESC);

CREATE TABLE game_invitations (
  id UUID PRIMARY KEY,
  challenge_id UUID NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  invitee_id UUID REFERENCES users(id) ON DELETE SET NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'expired', 'revoked')),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE competition_agreements (
  id UUID PRIMARY KEY,
  challenge_id UUID NOT NULL REFERENCES challenges(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  terms_hash TEXT NOT NULL,
  terms JSONB NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (challenge_id, user_id),
  CHECK (length(terms_hash) = 64)
);

CREATE TABLE games (
  id UUID PRIMARY KEY,
  challenge_id UUID REFERENCES challenges(id) ON DELETE SET NULL,
  white_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  black_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  mode TEXT NOT NULL CHECK (mode IN ('free', 'test', 'real')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('waiting', 'active', 'finished', 'void', 'abandoned', 'disputed')),
  result TEXT CHECK (result IN ('white', 'black', 'draw', 'void')),
  termination TEXT,
  time_control JSONB NOT NULL,
  initial_fen TEXT NOT NULL,
  current_fen TEXT NOT NULL,
  pgn TEXT NOT NULL DEFAULT '',
  repetition JSONB NOT NULL DEFAULT '{}'::jsonb,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  white_clock_ms BIGINT NOT NULL,
  black_clock_ms BIGINT NOT NULL,
  turn_started_at TIMESTAMPTZ,
  clock_paused BOOLEAN NOT NULL DEFAULT FALSE,
  paused_at TIMESTAMPTZ,
  last_move_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  draw_offer_by UUID REFERENCES users(id) ON DELETE SET NULL,
  draw_claim TEXT,
  disconnect_deadline TIMESTAMPTZ,
  terms JSONB,
  terms_hash TEXT,
  CHECK (white_id <> black_id)
);
CREATE INDEX games_white_idx ON games (white_id, started_at DESC);
CREATE INDEX games_black_idx ON games (black_id, started_at DESC);
CREATE INDEX games_active_idx ON games (status, started_at DESC);
CREATE UNIQUE INDEX games_one_per_challenge_idx ON games (challenge_id) WHERE challenge_id IS NOT NULL;

CREATE TABLE moves (
  id BIGSERIAL PRIMARY KEY,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE RESTRICT,
  ply INTEGER NOT NULL CHECK (ply > 0),
  san TEXT NOT NULL,
  uci TEXT NOT NULL,
  fen_after TEXT NOT NULL,
  color CHAR(1) NOT NULL CHECK (color IN ('w', 'b')),
  by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  clock_ms BIGINT NOT NULL,
  client_nonce TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (game_id, ply),
  UNIQUE (game_id, by_user_id, client_nonce)
);
CREATE INDEX moves_game_idx ON moves (game_id, ply);

CREATE TABLE matchmaking_tickets (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL,
  time_category TEXT NOT NULL,
  stake_cents BIGINT NOT NULL DEFAULT 0,
  terms JSONB,
  terms_hash TEXT,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'matched', 'cancelled', 'expired')),
  matched_game_id UUID,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX matchmaking_one_active_idx ON matchmaking_tickets (user_id) WHERE status = 'queued';
CREATE INDEX matchmaking_queue_idx ON matchmaking_tickets (status, stake_cents, time_category, rating);

CREATE TABLE wallet_accounts (
  id UUID PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('user', 'platform_cash', 'platform_fee', 'provider_clearing', 'external')),
  owner_id UUID,
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  purpose TEXT NOT NULL DEFAULT 'available' CHECK (purpose IN ('available', 'reserved', 'general')),
  kind TEXT NOT NULL CHECK (kind IN ('asset', 'liability', 'income', 'expense')),
  available_cents BIGINT NOT NULL DEFAULT 0 CHECK (available_cents >= 0 OR owner_type = 'external'),
  reserved_cents BIGINT NOT NULL DEFAULT 0 CHECK (reserved_cents >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_type, owner_id, currency, purpose)
);

CREATE TABLE ledger_transactions (
  id UUID PRIMARY KEY,
  type TEXT NOT NULL,
  reference TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  game_id UUID REFERENCES games(id) ON DELETE RESTRICT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'posted', 'reversed')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  posted_at TIMESTAMPTZ
);
CREATE INDEX ledger_transactions_game_idx ON ledger_transactions (game_id);

CREATE TABLE ledger_entries (
  id BIGSERIAL PRIMARY KEY,
  transaction_id UUID NOT NULL REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
  wallet_account_id UUID NOT NULL REFERENCES wallet_accounts(id) ON DELETE RESTRICT,
  line_no INTEGER NOT NULL CHECK (line_no > 0),
  amount_cents BIGINT NOT NULL CHECK (amount_cents <> 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (transaction_id, line_no)
);
CREATE INDEX ledger_entries_wallet_idx ON ledger_entries (wallet_account_id, id);

CREATE OR REPLACE FUNCTION assert_ledger_entry_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE parent_status TEXT;
BEGIN
  SELECT status INTO parent_status FROM ledger_transactions WHERE id = OLD.transaction_id;
  IF parent_status = 'posted' THEN
    RAISE EXCEPTION 'Posted ledger entries are immutable; use a compensating transaction';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER ledger_entries_immutable
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION assert_ledger_entry_immutable();

CREATE OR REPLACE FUNCTION assert_ledger_transaction_balanced() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE tx_id UUID; total BIGINT; parent_status TEXT;
BEGIN
  tx_id := COALESCE(NEW.transaction_id, OLD.transaction_id);
  SELECT COALESCE(SUM(amount_cents), 0) INTO total FROM ledger_entries WHERE transaction_id = tx_id;
  SELECT status INTO parent_status FROM ledger_transactions WHERE id = tx_id;
  IF parent_status = 'posted' AND total <> 0 THEN
    RAISE EXCEPTION 'Ledger transaction % does not balance: % cents', tx_id, total;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_transactions_balanced
  AFTER INSERT OR UPDATE OR DELETE ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_ledger_transaction_balanced();

CREATE TABLE deposits (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  provider_reference TEXT,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'failed', 'cancelled', 'reversed')),
  sandbox BOOLEAN NOT NULL DEFAULT FALSE,
  ledger_transaction_id UUID REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
  destination TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  initiated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ,
  UNIQUE (provider, provider_reference)
);
CREATE INDEX deposits_user_idx ON deposits (user_id, initiated_at DESC);

CREATE TABLE withdrawals (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  provider_reference TEXT,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
  sandbox BOOLEAN NOT NULL DEFAULT FALSE,
  ledger_transaction_id UUID REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
  destination TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (provider, provider_reference)
);
CREATE INDEX withdrawals_user_idx ON withdrawals (user_id, requested_at DESC);

CREATE TABLE payment_provider_events (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  signature_valid BOOLEAN NOT NULL,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  UNIQUE (provider, event_id)
);

CREATE TABLE settlements (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL UNIQUE REFERENCES games(id) ON DELETE RESTRICT,
  competition_id UUID REFERENCES challenges(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'posted', 'blocked', 'reversed')),
  result TEXT NOT NULL CHECK (result IN ('white', 'black', 'draw', 'void')),
  winner_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  stake_cents BIGINT NOT NULL,
  pot_cents BIGINT NOT NULL,
  fee_cents BIGINT NOT NULL,
  payout_cents BIGINT NOT NULL,
  ledger_transaction_id UUID REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  posted_at TIMESTAMPTZ
);

CREATE TABLE settlement_corrections (
  id UUID PRIMARY KEY,
  settlement_id UUID NOT NULL UNIQUE REFERENCES settlements(id) ON DELETE RESTRICT,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE RESTRICT,
  actor_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL,
  ledger_transaction_id UUID NOT NULL REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE disputes (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE RESTRICT,
  opened_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'under_review', 'resolved', 'rejected')),
  resolution TEXT,
  resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX disputes_status_idx ON disputes (status, created_at DESC);

CREATE TABLE notifications (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  link TEXT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);

CREATE TABLE responsible_play_restrictions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('daily_deposit_limit', 'daily_stake_limit', 'session_limit', 'self_exclusion')),
  value_cents BIGINT,
  value_minutes INTEGER,
  expires_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX responsible_play_user_idx ON responsible_play_restrictions (user_id, active);

CREATE TABLE admin_actions (
  id BIGSERIAL PRIMARY KEY,
  actor_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  outcome TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX admin_actions_created_idx ON admin_actions (created_at DESC);

CREATE TABLE audit_events (
  id BIGSERIAL PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  event TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_created_idx ON audit_events (created_at DESC);

CREATE TABLE platform_config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE fair_play_signals (
  id BIGSERIAL PRIMARY KEY,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  score INTEGER NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE match_reviews (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewing', 'closed')),
  reason TEXT NOT NULL,
  reviewer_id UUID REFERENCES users(id) ON DELETE SET NULL,
  decision TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE puzzles (
  id TEXT PRIMARY KEY,
  fen TEXT NOT NULL,
  solution TEXT[] NOT NULL,
  theme TEXT NOT NULL,
  rating INTEGER NOT NULL,
  source TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE puzzle_attempts (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  puzzle_id TEXT NOT NULL REFERENCES puzzles(id) ON DELETE CASCADE,
  correct BOOLEAN NOT NULL,
  rating_delta INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Deterministic system account IDs. Never removed by migrations.
INSERT INTO wallet_accounts (id, owner_type, owner_id, currency, purpose, kind) VALUES
  ('00000000-0000-4000-8000-000000000001', 'platform_cash', NULL, 'USD', 'general', 'liability'),
  ('00000000-0000-4000-8000-000000000002', 'platform_fee',  NULL, 'USD', 'general', 'income'),
  ('00000000-0000-4000-8000-000000000003', 'external',      NULL, 'USD', 'general', 'asset'),
  ('00000000-0000-4000-8000-000000000004', 'provider_clearing', NULL, 'USD', 'general', 'asset');

INSERT INTO platform_config (key, value) VALUES
  ('commission_bps', '500'),
  ('terms_version', '1'),
  ('max_open_challenges_per_user', '5'),
  ('abandonment_seconds', '90'),
  ('draw_claim_policy', '"claim-after-threefold-or-fifty-move"');

INSERT INTO puzzles (id, fen, solution, theme, rating, source) VALUES
  ('back-rank-a', '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', ARRAY['a1a8'], 'mateIn1', 900, 'original-composed'),
  ('back-rank-c', '6k1/5ppp/8/8/8/8/5PPP/2R3K1 w - - 0 1', ARRAY['c1c8'], 'mateIn1', 950, 'original-composed'),
  ('back-rank-d', '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1', ARRAY['d1d8'], 'mateIn1', 1000, 'original-composed'),
  ('queen-support', '7k/5Q2/6K1/8/8/8/8/8 w - - 0 1', ARRAY['f7g7'], 'mateIn1', 1100, 'original-composed'),
  ('rook-capture', '1r4k1/5ppp/8/8/8/8/5PPP/1R4K1 w - - 0 1', ARRAY['b1b8'], 'mateIn1', 1150, 'original-composed');
