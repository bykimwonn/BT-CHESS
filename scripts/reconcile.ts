import 'dotenv/config';
import { openDatabase } from '../server/db/client.js';
import { runMigrations } from '../server/db/migrate.js';
import { createContext } from '../server/services/context.js';
import { createLogger } from '../server/services/logger.js';

const db = await openDatabase();
const log = createLogger();
try {
  const migrations = await runMigrations(db);
  const ctx = createContext(db, log);
  const [ledger, settlements, payments, engine] = await Promise.all([
    ctx.ledger.reconcile(),
    ctx.settlement.settlePending(),
    ctx.payments.reconcilePending(),
    ctx.engine.health(),
  ]);
  const report = {
    generatedAt: new Date().toISOString(),
    database: db.driver,
    migrations,
    ledger,
    settlements,
    payments,
    engine,
    compliance: ctx.compliance,
    providers: ctx.payments.health(),
    healthy: ledger.discrepancies.length === 0 && ledger.unbalancedTransactions.length === 0 && settlements.failed.length === 0,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.healthy) process.exitCode = 1;
} finally {
  await db.close();
}
