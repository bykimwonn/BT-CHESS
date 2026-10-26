import type { Database, Queryable, Row } from '../db/client.js';
import { adminAction } from './audit.js';
import { badRequest } from './errors.js';

export class ConfigService {
  constructor(private readonly db: Database) {}

  async all(): Promise<Row[]> {
    const result = await this.db.query<Row>('SELECT key, value, version, updated_at FROM platform_config ORDER BY key');
    return result.rows;
  }

  async commissionBps(): Promise<number> {
    const result = await this.db.query<Row>("SELECT value FROM platform_config WHERE key = 'commission_bps'");
    const value = Number(result.rows[0]?.value ?? 500);
    if (!Number.isInteger(value) || value < 0 || value > 2500) throw new Error('commission_bps configuration is invalid');
    return value;
  }

  async setCommissionBps(actorId: string, bps: number, reason: string): Promise<number> {
    if (!Number.isInteger(bps) || bps < 0 || bps > 2500) throw badRequest('Commission must be 0–2500 basis points');
    if (reason.trim().length < 8) throw badRequest('A documented reason is required');
    return this.db.transaction(async (tx: Queryable) => {
      await tx.query(
        `UPDATE platform_config SET value = $1::jsonb, version = version + 1,
           updated_by = $2, updated_at = now() WHERE key = 'commission_bps'`,
        [JSON.stringify(bps), actorId],
      );
      await adminAction(tx, {
        actorId, action: 'config.commission', targetType: 'platform_config',
        targetId: 'commission_bps', reason, outcome: `set to ${bps} bps`,
        metadata: { bps },
      });
      return bps;
    });
  }
}
