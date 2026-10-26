-- International modes, jurisdiction policies, currency isolation and tournaments.
-- Forward-only migration: migration 001 remains immutable.

-- ---------------------------------------------------------------- users
ALTER TABLE users ADD COLUMN IF NOT EXISTS country_shared BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS eligibility_jurisdiction CHAR(2);
ALTER TABLE users ADD COLUMN IF NOT EXISTS eligibility_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS eligibility_provider_ref TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS location_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS identity_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_currency CHAR(3) NOT NULL DEFAULT 'USD';
ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC';
ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone_shared BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ALTER COLUMN country SET DEFAULT 'ZZ';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_account_currency_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_account_currency_check CHECK (account_currency IN ('USD'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_country_sharing_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_country_sharing_check CHECK (country <> 'ZZ' OR country_shared = FALSE);
  END IF;
END $$;

-- ------------------------------------------------------- ledger currencies
ALTER TABLE ledger_transactions ADD COLUMN IF NOT EXISTS currency CHAR(3) NOT NULL DEFAULT 'USD';
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS currency CHAR(3) NOT NULL DEFAULT 'USD';
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS currency CHAR(3) NOT NULL DEFAULT 'USD';

CREATE OR REPLACE FUNCTION assert_ledger_currency_match() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE tx_currency CHAR(3); account_currency CHAR(3);
BEGIN
  SELECT currency INTO tx_currency FROM ledger_transactions WHERE id = NEW.transaction_id;
  SELECT currency INTO account_currency FROM wallet_accounts WHERE id = NEW.wallet_account_id;
  IF tx_currency IS DISTINCT FROM NEW.currency OR account_currency IS DISTINCT FROM NEW.currency THEN
    RAISE EXCEPTION 'Ledger entry currency % does not match transaction % or account %',
      NEW.currency, tx_currency, account_currency;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ledger_entries_currency_match ON ledger_entries;
CREATE TRIGGER ledger_entries_currency_match
  BEFORE INSERT OR UPDATE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION assert_ledger_currency_match();

-- Currency-specific system accounts are created on demand by LedgerService.
-- Existing USD system accounts remain the canonical USD accounts.
CREATE TABLE IF NOT EXISTS currency_exchange_rates (
  id UUID PRIMARY KEY,
  from_currency CHAR(3) NOT NULL,
  to_currency CHAR(3) NOT NULL,
  rate NUMERIC(30,12) NOT NULL CHECK (rate > 0),
  effective_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL,
  evidence_ref TEXT NOT NULL DEFAULT '',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (from_currency, to_currency, effective_at, source),
  CHECK (from_currency <> to_currency)
);
CREATE INDEX IF NOT EXISTS currency_exchange_rates_lookup_idx
  ON currency_exchange_rates (from_currency, to_currency, effective_at DESC);

-- Conversion quotes are explicit records only. They never mutate a wallet.
CREATE TABLE IF NOT EXISTS currency_conversion_quotes (
  id UUID PRIMARY KEY,
  from_currency CHAR(3) NOT NULL,
  to_currency CHAR(3) NOT NULL,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  rate_exchange_id UUID NOT NULL REFERENCES currency_exchange_rates(id) ON DELETE RESTRICT,
  rate NUMERIC(30,12) NOT NULL,
  converted_cents BIGINT NOT NULL CHECK (converted_cents > 0),
  source TEXT NOT NULL,
  applied BOOLEAN NOT NULL DEFAULT FALSE,
  applied_ledger_transaction_id UUID REFERENCES ledger_transactions(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS currency_conversion_quotes_lookup_idx
  ON currency_conversion_quotes (from_currency, to_currency, created_at DESC);

-- -------------------------------------------------- jurisdiction policies
CREATE TABLE IF NOT EXISTS jurisdiction_policies (
  code TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  free_play_allowed BOOLEAN NOT NULL DEFAULT TRUE,
  real_money_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  age_verification_required BOOLEAN NOT NULL DEFAULT TRUE,
  identity_verification_required BOOLEAN NOT NULL DEFAULT TRUE,
  permitted_competition_types TEXT[] NOT NULL DEFAULT ARRAY['free'],
  allowed_providers TEXT[] NOT NULL DEFAULT '{}',
  deposit_limit_cents BIGINT,
  withdrawal_limit_cents BIGINT,
  reason TEXT NOT NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version INTEGER NOT NULL DEFAULT 1,
  CHECK (code = '*' OR code ~ '^[A-Z]{2}$'),
  CHECK (NOT real_money_allowed OR age_verification_required)
);
INSERT INTO jurisdiction_policies
  (code, label, free_play_allowed, real_money_allowed, age_verification_required,
   identity_verification_required, permitted_competition_types, allowed_providers,
   deposit_limit_cents, withdrawal_limit_cents, reason)
VALUES
  ('*', 'Global default', TRUE, FALSE, TRUE, TRUE, ARRAY['free'], '{}'::TEXT[],
   NULL, NULL, 'Free chess is globally available by default; real-money competitions require explicit jurisdiction approval.'),
  ('ZZ', 'Undisclosed / unknown', TRUE, FALSE, TRUE, TRUE, ARRAY['free','test'], ARRAY['paynow','ecocash','pesepay'],
   NULL, NULL, 'Country is voluntarily withheld. Free chess and isolated internal test credits only; no real money.'),
  ('ZW', 'Zimbabwe', TRUE, FALSE, TRUE, TRUE, ARRAY['free'], '{}'::TEXT[],
   NULL, NULL, 'Free chess available. Real-money entry and withdrawals remain disabled until legal, provider, age and AML approvals are verified.'),
  ('US', 'United States', TRUE, FALSE, TRUE, TRUE, ARRAY['free'], '{}'::TEXT[],
   NULL, NULL, 'Free chess available. Money competitions require federal and state review plus provider approval.'),
  ('GB', 'United Kingdom', TRUE, FALSE, TRUE, TRUE, ARRAY['free'], '{}'::TEXT[],
   NULL, NULL, 'Free chess available. Money competitions require UK Gambling Commission and provider approval.')
ON CONFLICT (code) DO NOTHING;

-- ------------------------------------------------------------- tournaments
CREATE TABLE IF NOT EXISTS tournaments (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 3 AND 80),
  mode TEXT NOT NULL DEFAULT 'free' CHECK (mode IN ('free','test','real')),
  status TEXT NOT NULL DEFAULT 'registration' CHECK (status IN ('registration','active','finished')),
  time_control JSONB NOT NULL,
  max_players INTEGER NOT NULL DEFAULT 32 CHECK (max_players BETWEEN 2 AND 128),
  current_round INTEGER NOT NULL DEFAULT 0 CHECK (current_round >= 0),
  rated BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  starts_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tournaments_status_idx ON tournaments (status, created_at DESC);

CREATE TABLE IF NOT EXISTS tournament_entries (
  id UUID PRIMARY KEY,
  tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  points INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','withdrawn')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tournament_id, user_id)
);
CREATE INDEX IF NOT EXISTS tournament_entries_tournament_idx ON tournament_entries (tournament_id, points DESC);

CREATE TABLE IF NOT EXISTS tournament_pairings (
  id UUID PRIMARY KEY,
  tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  round_no INTEGER NOT NULL CHECK (round_no > 0),
  board_no INTEGER NOT NULL CHECK (board_no > 0),
  white_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  black_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  game_id UUID UNIQUE,
  result TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tournament_id, round_no, board_no),
  CHECK (white_id <> black_id)
);
CREATE INDEX IF NOT EXISTS tournament_pairings_tournament_idx ON tournament_pairings (tournament_id, round_no, board_no);

ALTER TABLE games ADD COLUMN IF NOT EXISTS tournament_id UUID REFERENCES tournaments(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS games_tournament_idx ON games (tournament_id) WHERE tournament_id IS NOT NULL;

INSERT INTO platform_config (key, value) VALUES
  ('ledger_base_currency', '"USD"'),
  ('global_free_play_enabled', 'true')
ON CONFLICT (key) DO NOTHING;
