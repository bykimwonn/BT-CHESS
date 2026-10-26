import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { env } from '../config/env.js';
import { openDatabase, type Database, type Queryable } from './client.js';

/** Split SQL at top-level semicolons, honouring strings, dollar quotes and comments. */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  let i = 0;
  let dollarTag: string | null = null;
  let inSingle = false;
  let inDouble = false;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        current += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
        continue;
      }
      current += ch; i++; continue;
    }
    if (inSingle) {
      current += ch;
      if (ch === "'" && next === "'") { current += next; i += 2; continue; }
      if (ch === "'") inSingle = false;
      i++; continue;
    }
    if (inDouble) {
      current += ch;
      if (ch === '"' && next === '"') { current += next; i += 2; continue; }
      if (ch === '"') inDouble = false;
      i++; continue;
    }
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      current += sql.slice(i, stop); i = stop; continue;
    }
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      i = stop; continue;
    }
    const tag = /^\$[a-zA-Z_0-9]*\$/.exec(sql.slice(i));
    if (tag) {
      dollarTag = tag[0]; current += tag[0]; i += tag[0].length; continue;
    }
    if (ch === "'") { inSingle = true; current += ch; i++; continue; }
    if (ch === '"') { inDouble = true; current += ch; i++; continue; }
    if (ch === ';') { if (current.trim()) out.push(current.trim()); current = ''; i++; continue; }
    current += ch; i++;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

export interface MigrationResult { applied: string[]; skipped: string[]; driver: string }

export async function runMigrations(db: Database, directory?: string): Promise<MigrationResult> {
  const dir = directory ?? path.join(env.root, 'server', 'db', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d+_[\w-]+\.sql$/.test(f)).sort();
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const checksum = crypto.createHash('sha256').update(sql).digest('hex');
    const existing = await db.query<{ checksum: string }>('SELECT checksum FROM schema_migrations WHERE version = $1', [version]);
    if (existing.rows.length) {
      if (existing.rows[0].checksum !== checksum) {
        throw new Error(`Migration ${version} checksum changed; never edit an applied migration`);
      }
      skipped.push(version);
      continue;
    }
    await db.transaction(async (tx: Queryable) => {
      // Serialises migration runners across processes.
      await tx.query('SELECT pg_advisory_xact_lock(727001)');
      for (const statement of splitStatements(sql)) await tx.query(statement);
      await tx.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2) ON CONFLICT DO NOTHING', [version, checksum]);
    });
    applied.push(version);
  }
  return { applied, skipped, driver: db.driver };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const db = await openDatabase();
  try {
    const result = await runMigrations(db);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await db.close();
  }
}
