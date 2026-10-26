import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { env } from '../config/env.js';

export type Row = Record<string, unknown>;

export interface Queryable {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
}

export interface Database extends Queryable {
  driver: 'postgres' | 'pglite';
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const normalise = (result: { rows?: unknown[]; rowCount?: number | null }): { rows: Row[]; rowCount: number } => ({
  rows: (result.rows ?? []) as Row[],
  rowCount: result.rowCount ?? result.rows?.length ?? 0,
});

class PgDatabase implements Database {
  readonly driver = 'postgres' as const;
  constructor(private readonly pool: pg.Pool) {}

  async query<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<{ rows: T[]; rowCount: number }> {
    return normalise(await this.pool.query(sql, params)) as { rows: T[]; rowCount: number };
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const tx: Queryable = {
      query: async <R extends Row = Row>(sql: string, params: unknown[] = []) =>
        normalise(await client.query(sql, params)) as { rows: R[]; rowCount: number },
    };
    try {
      await client.query('BEGIN');
      const value = await fn(tx);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> { await this.pool.end(); }
}

class PGliteDatabase implements Database {
  readonly driver = 'pglite' as const;
  private constructor(private readonly db: PGlite) {}

  static async open(dataDir: string): Promise<PGliteDatabase> {
    fs.mkdirSync(path.dirname(dataDir), { recursive: true });
    const db = new PGlite(dataDir);
    await db.waitReady;
    return new PGliteDatabase(db);
  }

  async query<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<{ rows: T[]; rowCount: number }> {
    return normalise(await this.db.query(sql, params)) as { rows: T[]; rowCount: number };
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const wrapped: Queryable = {
        query: async <R extends Row = Row>(sql: string, params: unknown[] = []) =>
          normalise(await tx.query(sql, params)) as { rows: R[]; rowCount: number },
      };
      return fn(wrapped);
    });
  }

  async close(): Promise<void> { await this.db.close(); }
}

let instance: Database | null = null;

export async function openDatabase(options: { databaseUrl?: string; driver?: 'postgres' | 'pglite'; pgliteDir?: string } = {}): Promise<Database> {
  const driver = options.driver ?? (options.databaseUrl ? 'postgres' : env.dbDriver);
  if (driver === 'postgres') {
    const url = options.databaseUrl ?? env.databaseUrl;
    if (!url) throw new Error('DATABASE_URL is required for the postgres driver');
    const pool = new pg.Pool({
      connectionString: url,
      max: Number(process.env.DB_POOL_SIZE ?? 12),
      ssl: /sslmode=require/.test(url) ? { rejectUnauthorized: true } : undefined,
    });
    return new PgDatabase(pool);
  }
  return PGliteDatabase.open(options.pgliteDir ?? env.pgliteDir);
}

/** Shared process-wide connection. Tests create their own isolated databases. */
export async function getDatabase(): Promise<Database> {
  if (!instance) instance = await openDatabase();
  return instance;
}

export async function closeDatabase(): Promise<void> {
  if (instance) await instance.close();
  instance = null;
}
