-- Cash-agent voucher rail.
--
-- Modelled on the way licensed Zimbabwean operators take money without a
-- payment gateway: a teller accepts cash, issues a short code, and the player
-- redeems that code against their online balance. Withdrawals run the same
-- direction in reverse. The platform never has to wait for a provider to
-- approve the use case, but every movement is still double-entry and audited.
--
-- Accounting convention in this ledger: a user wallet balance is a liability
-- (positive). The account on the other side of the journal carries the negative
-- balance. Cash held by an agent is therefore a *negative* balance on that
-- agent's float account, and the cash they hold equals -balance.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('player', 'admin', 'agent'));

ALTER TABLE wallet_accounts DROP CONSTRAINT IF EXISTS wallet_accounts_owner_type_check;
ALTER TABLE wallet_accounts ADD CONSTRAINT wallet_accounts_owner_type_check
  CHECK (owner_type IN ('user', 'platform_cash', 'platform_fee', 'provider_clearing', 'external', 'cash_agent', 'platform_bank'));

-- Agent float and platform bank accounts hold custody, not player liability, so
-- their balance is allowed to be negative like the external counter-account.
-- 001 named the inline balance check automatically; drop both possible names
-- so the relaxation applies to fresh and upgraded databases alike.
ALTER TABLE wallet_accounts DROP CONSTRAINT IF EXISTS wallet_accounts_available_cents_check;
ALTER TABLE wallet_accounts DROP CONSTRAINT IF EXISTS wallet_accounts_check;
ALTER TABLE wallet_accounts ADD CONSTRAINT wallet_accounts_available_cents_check
  CHECK (available_cents >= 0 OR owner_type IN ('external', 'cash_agent', 'platform_bank'));

INSERT INTO wallet_accounts (id, owner_type, owner_id, currency, purpose, kind) VALUES
  ('00000000-0000-4000-8000-000000000005', 'platform_bank', NULL, 'USD', 'general', 'asset')
ON CONFLICT (owner_type, owner_id, currency, purpose) DO NOTHING;

CREATE TABLE cash_agents (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  code TEXT NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{3,12}$'),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  float_account_id UUID NOT NULL REFERENCES wallet_accounts(id) ON DELETE RESTRICT,
  voucher_limit_cents BIGINT NOT NULL DEFAULT 100000 CHECK (voucher_limit_cents > 0),
  daily_deposit_limit_cents BIGINT NOT NULL DEFAULT 500000 CHECK (daily_deposit_limit_cents > 0),
  daily_payout_limit_cents BIGINT NOT NULL DEFAULT 500000 CHECK (daily_payout_limit_cents > 0),
  location TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX cash_agents_status_idx ON cash_agents (status);

CREATE TABLE cash_vouchers (
  id UUID PRIMARY KEY,
  -- Only a hash is stored: a voucher code is bearer cash, so a database dump
  -- must not be enough to redeem it.
  code_hash TEXT NOT NULL UNIQUE,
  code_last4 TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('deposit', 'payout')),
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'redeemed', 'paid', 'cancelled', 'expired')),
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  agent_id UUID NOT NULL REFERENCES cash_agents(id) ON DELETE RESTRICT,
  player_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  purpose TEXT NOT NULL DEFAULT 'wallet_deposit' CHECK (purpose IN ('wallet_deposit')),
  reference TEXT,
  sandbox BOOLEAN NOT NULL DEFAULT FALSE,
  issued_by UUID REFERENCES users(id) ON DELETE SET NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  settled_at TIMESTAMPTZ,
  settled_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ledger_transaction_id UUID REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
  withdrawal_id UUID REFERENCES withdrawals(id) ON DELETE RESTRICT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX cash_vouchers_agent_idx ON cash_vouchers (agent_id, issued_at DESC);
CREATE INDEX cash_vouchers_player_idx ON cash_vouchers (player_id, issued_at DESC);
CREATE INDEX cash_vouchers_status_idx ON cash_vouchers (status, expires_at);
