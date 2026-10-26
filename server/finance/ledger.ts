import { badRequest, conflict } from '../services/errors.js';
import { sha256, uuid } from '../services/ids.js';
import type { Database, Queryable, Row } from '../db/client.js';
import { LEDGER_BASE_CURRENCY, type WalletView } from '../../shared/contracts.js';

export const SYSTEM_ACCOUNTS = {
  platformCash: '00000000-0000-4000-8000-000000000001',
  platformFee: '00000000-0000-4000-8000-000000000002',
  external: '00000000-0000-4000-8000-000000000003',
  providerClearing: '00000000-0000-4000-8000-000000000004',
} as const;

export type SystemAccountRole = keyof typeof SYSTEM_ACCOUNTS;

export interface UserAccounts { availableId: string; reservedId: string }
export interface JournalEntry { accountId: string; amountCents: number }
export interface PostTransactionInput {
  type: string;
  reference: string;
  idempotencyKey: string;
  description: string;
  entries: JournalEntry[];
  currency?: string;
  gameId?: string | null;
  createdBy?: string | null;
  metadata?: Record<string, unknown>;
}
export interface PostTransactionResult { id: string; duplicate: boolean; posted: boolean }

const SYSTEM_ACCOUNT_META: Record<SystemAccountRole, { ownerType: string; kind: string }> = {
  platformCash: { ownerType: 'platform_cash', kind: 'liability' },
  platformFee: { ownerType: 'platform_fee', kind: 'income' },
  external: { ownerType: 'external', kind: 'asset' },
  providerClearing: { ownerType: 'provider_clearing', kind: 'asset' },
};

function deterministicUuid(seed: string): string {
  const hex = sha256(`rookstone:${seed}`).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export class LedgerService {
  constructor(private readonly db: Database) {}

  /** Returns (or creates) currency-specific system accounts. USD uses fixed IDs. */
  async systemAccountId(tx: Queryable, currency: string, role: SystemAccountRole): Promise<string> {
    const code = String(currency || LEDGER_BASE_CURRENCY).toUpperCase();
    if (code === LEDGER_BASE_CURRENCY) return SYSTEM_ACCOUNTS[role];
    const meta = SYSTEM_ACCOUNT_META[role];
    const ownerId = deterministicUuid(`owner:${code}:${role}`);
    const id = deterministicUuid(`account:${code}:${role}`);
    await tx.query(
      `INSERT INTO wallet_accounts
        (id, owner_type, owner_id, currency, purpose, kind)
       VALUES ($1,$2,$3,$4,'general',$5)
       ON CONFLICT (owner_type, owner_id, currency, purpose) DO NOTHING`,
      [id, meta.ownerType, ownerId, code, meta.kind],
    );
    return id;
  }

  async ensureUserAccounts(tx: Queryable, userId: string, currency = LEDGER_BASE_CURRENCY): Promise<UserAccounts> {
    const code = String(currency || LEDGER_BASE_CURRENCY).toUpperCase();
    for (const purpose of ['available', 'reserved']) {
      await tx.query(
        `INSERT INTO wallet_accounts (id, owner_type, owner_id, currency, purpose, kind)
         VALUES ($1, 'user', $2, $3, $4, 'liability')
         ON CONFLICT (owner_type, owner_id, currency, purpose) DO NOTHING`,
        [uuid(), userId, code, purpose],
      );
    }
    const rows = await tx.query<Row>(
      `SELECT id, purpose FROM wallet_accounts
       WHERE owner_type = 'user' AND owner_id = $1 AND currency = $2`,
      [userId, code],
    );
    const available = rows.rows.find((r) => r.purpose === 'available');
    const reserved = rows.rows.find((r) => r.purpose === 'reserved');
    if (!available || !reserved) throw new Error(`User ${code} wallet accounts could not be created`);
    return { availableId: String(available.id), reservedId: String(reserved.id) };
  }

  async userAccounts(userId: string, currency = LEDGER_BASE_CURRENCY): Promise<UserAccounts | null> {
    const code = String(currency || LEDGER_BASE_CURRENCY).toUpperCase();
    const rows = await this.db.query<Row>(
      `SELECT id, purpose FROM wallet_accounts
       WHERE owner_type = 'user' AND owner_id = $1 AND currency = $2`,
      [userId, code],
    );
    const available = rows.rows.find((r) => r.purpose === 'available');
    const reserved = rows.rows.find((r) => r.purpose === 'reserved');
    return available && reserved
      ? { availableId: String(available.id), reservedId: String(reserved.id) }
      : null;
  }

  /**
   * Post a balanced journal. amount_cents is the signed change in that
   * account's cached balance. Every account in the journal must have the same
   * currency; the database trigger verifies this again.
   */
  async postTransaction(input: PostTransactionInput, tx: Queryable = this.db): Promise<PostTransactionResult> {
    if (tx === this.db) return this.db.transaction((inner) => this.postTransaction(input, inner));
    const currency = String(input.currency ?? LEDGER_BASE_CURRENCY).toUpperCase();
    if (input.entries.length < 2) throw badRequest('A journal requires at least two entries');
    const total = input.entries.reduce((sum, e) => {
      if (!Number.isSafeInteger(e.amountCents) || e.amountCents === 0) {
        throw badRequest('Journal amounts must be non-zero integer cents');
      }
      return sum + e.amountCents;
    }, 0);
    if (total !== 0) throw badRequest('Journal is not balanced');

    const ids = [...new Set(input.entries.map((e) => e.accountId))].sort();
    const locked = new Map<string, { available_cents: number; reserved_cents: number; purpose: string; owner_type: string; currency: string }>();
    for (const id of ids) {
      const result = await tx.query<Row>(
        'SELECT id, available_cents, reserved_cents, purpose, owner_type, currency FROM wallet_accounts WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (!result.rows.length) throw conflict(`Wallet account ${id} does not exist`);
      const row = result.rows[0];
      const accountCurrency = String(row.currency).trim();
      if (accountCurrency !== currency) {
        throw badRequest(`Currency mismatch: journal is ${currency}, account ${id} is ${accountCurrency}`);
      }
      locked.set(id, {
        available_cents: Number(row.available_cents),
        reserved_cents: Number(row.reserved_cents),
        purpose: String(row.purpose),
        owner_type: String(row.owner_type),
        currency: accountCurrency,
      });
    }

    const deltas = new Map<string, number>();
    for (const entry of input.entries) deltas.set(entry.accountId, (deltas.get(entry.accountId) ?? 0) + entry.amountCents);
    for (const [id, delta] of deltas) {
      const account = locked.get(id)!;
      const nextAvailable = account.purpose === 'reserved' ? account.available_cents : account.available_cents + delta;
      const nextReserved = account.purpose === 'reserved' ? account.reserved_cents + delta : account.reserved_cents;
      const mayGoNegative = account.owner_type === 'external';
      if (!mayGoNegative && (nextAvailable < 0 || nextReserved < 0)) throw conflict('Insufficient available or reserved funds');
    }

    const transactionId = uuid();
    const inserted = await tx.query<Row>(
      `INSERT INTO ledger_transactions
        (id, type, reference, idempotency_key, description, game_id, created_by, status, metadata, currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8::jsonb,$9)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [transactionId, input.type, input.reference, input.idempotencyKey, input.description,
        input.gameId ?? null, input.createdBy ?? null, JSON.stringify(input.metadata ?? {}), currency],
    );
    if (!inserted.rows.length) {
      const existing = await tx.query<Row>('SELECT id, status FROM ledger_transactions WHERE idempotency_key = $1', [input.idempotencyKey]);
      return { id: String(existing.rows[0].id), duplicate: true, posted: existing.rows[0].status === 'posted' };
    }

    for (let i = 0; i < input.entries.length; i++) {
      await tx.query(
        `INSERT INTO ledger_entries (transaction_id, wallet_account_id, line_no, amount_cents, currency)
         VALUES ($1,$2,$3,$4,$5)`,
        [transactionId, input.entries[i].accountId, i + 1, input.entries[i].amountCents, currency],
      );
    }
    await tx.query(
      `UPDATE ledger_transactions SET status = 'posted', posted_at = now() WHERE id = $1`,
      [transactionId],
    );
    for (const [id, delta] of deltas) {
      const account = locked.get(id)!;
      if (account.purpose === 'reserved') {
        await tx.query('UPDATE wallet_accounts SET reserved_cents = reserved_cents + $1, updated_at = now() WHERE id = $2', [delta, id]);
      } else {
        await tx.query('UPDATE wallet_accounts SET available_cents = available_cents + $1, updated_at = now() WHERE id = $2', [delta, id]);
      }
    }
    return { id: transactionId, duplicate: false, posted: true };
  }

  async walletView(userId: string, currency = LEDGER_BASE_CURRENCY): Promise<WalletView> {
    const code = String(currency || LEDGER_BASE_CURRENCY).toUpperCase();
    const balances = await this.db.query<Row>(`
      SELECT purpose, available_cents, reserved_cents FROM wallet_accounts
      WHERE owner_type = 'user' AND owner_id = $1 AND currency = $2`, [userId, code]);
    const available = balances.rows.find((r) => r.purpose === 'available');
    const reserved = balances.rows.find((r) => r.purpose === 'reserved');
    const pending = await this.db.query<Row>(`
      SELECT
        (SELECT COALESCE(SUM(amount_cents), 0) FROM deposits
          WHERE user_id = $1 AND status = 'pending' AND currency = $2) AS pending_deposits,
        (SELECT COALESCE(SUM(amount_cents), 0) FROM withdrawals
          WHERE user_id = $1 AND status IN ('pending', 'processing') AND currency = $2) AS pending_withdrawals`, [userId, code]);
    const availableCents = Number(available?.available_cents ?? 0);
    const reservedCents = Number(reserved?.reserved_cents ?? 0);
    return {
      availableCents, reservedCents,
      totalCents: availableCents + reservedCents,
      currency: code,
      pendingDepositsCents: Number(pending.rows[0]?.pending_deposits ?? 0),
      pendingWithdrawalsCents: Number(pending.rows[0]?.pending_withdrawals ?? 0),
      source: 'ledger',
    };
  }

  async transactions(userId: string, options: { limit?: number; offset?: number; type?: string; status?: string; from?: string; to?: string; currency?: string } = {}): Promise<Row[]> {
    const params: unknown[] = [userId, String(options.currency ?? LEDGER_BASE_CURRENCY).toUpperCase()];
    const clauses: string[] = [`wa.owner_type = 'user'`, `wa.owner_id = $1`, `wa.currency = $2`, `lt.currency = $2`];
    if (options.type) { params.push(options.type); clauses.push(`lt.type = $${params.length}`); }
    if (options.status) { params.push(options.status); clauses.push(`lt.status = $${params.length}`); }
    if (options.from) { params.push(options.from); clauses.push(`lt.created_at >= $${params.length}::timestamptz`); }
    if (options.to) { params.push(options.to); clauses.push(`lt.created_at <= $${params.length}::timestamptz`); }
    params.push(Math.min(options.limit ?? 50, 200), Math.max(options.offset ?? 0, 0));
    const result = await this.db.query<Row>(`
      SELECT lt.id, lt.currency, lt.type, lt.reference, lt.description, lt.status, lt.created_at, lt.posted_at,
             SUM(le.amount_cents) AS amount_cents, lt.metadata
      FROM ledger_entries le
      JOIN ledger_transactions lt ON lt.id = le.transaction_id
      JOIN wallet_accounts wa ON wa.id = le.wallet_account_id
      WHERE ${clauses.join(' AND ')}
      GROUP BY lt.id
      ORDER BY lt.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return result.rows;
  }

  async reconcile(): Promise<{ checkedAccounts: number; currencies: string[]; discrepancies: unknown[]; unbalancedTransactions: unknown[] }> {
    const accounts = await this.db.query<Row>(`
      SELECT w.id, w.owner_type, w.purpose, w.currency, w.available_cents, w.reserved_cents,
             COALESCE(SUM(le.amount_cents) FILTER (WHERE lt.status = 'posted'), 0) AS ledger_cents
      FROM wallet_accounts w
      LEFT JOIN ledger_entries le ON le.wallet_account_id = w.id
      LEFT JOIN ledger_transactions lt ON lt.id = le.transaction_id
      GROUP BY w.id`);
    const discrepancies = accounts.rows.filter((row) => {
      const expected = row.purpose === 'reserved' ? Number(row.reserved_cents) : Number(row.available_cents);
      return expected !== Number(row.ledger_cents);
    });
    const currencyRows = await this.db.query<Row>('SELECT DISTINCT currency FROM wallet_accounts ORDER BY currency');
    const unbalanced = await this.db.query<Row>(`
      SELECT lt.id, lt.currency, lt.reference, SUM(le.amount_cents) AS total
      FROM ledger_transactions lt JOIN ledger_entries le ON le.transaction_id = lt.id
      WHERE lt.status = 'posted'
      GROUP BY lt.id HAVING SUM(le.amount_cents) <> 0`);
    return {
      checkedAccounts: accounts.rows.length,
      currencies: currencyRows.rows.map((r) => String(r.currency).trim()),
      discrepancies,
      unbalancedTransactions: unbalanced.rows,
    };
  }
}
