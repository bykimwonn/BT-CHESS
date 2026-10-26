import type { Queryable } from '../db/client.js';
import { uuid } from './ids.js';

export async function audit(
  tx: Queryable,
  event: string,
  entity: string,
  entityId: string | null,
  payload: Record<string, unknown> = {},
  actor: { type: 'user' | 'system' | 'provider' | 'admin'; id: string | null } = { type: 'system', id: null },
): Promise<void> {
  await tx.query(
    `INSERT INTO audit_events (actor_type, actor_id, event, entity, entity_id, payload)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [actor.type, actor.id, event, entity, entityId, JSON.stringify(payload)],
  );
}

export async function adminAction(
  tx: Queryable,
  input: { actorId: string; action: string; targetType: string; targetId: string; reason: string; outcome: string; metadata?: Record<string, unknown> },
): Promise<void> {
  await tx.query(
    `INSERT INTO admin_actions (actor_id, action, target_type, target_id, reason, outcome, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [input.actorId, input.action, input.targetType, input.targetId, input.reason, input.outcome, JSON.stringify(input.metadata ?? {})],
  );
  await audit(tx, `admin.${input.action}`, input.targetType, input.targetId, {
    reason: input.reason, outcome: input.outcome, ...(input.metadata ?? {}),
  }, { type: 'admin', id: input.actorId });
}

export async function notify(
  tx: Queryable,
  userId: string,
  input: { type: string; title: string; body: string; link?: string | null },
): Promise<string> {
  const id = uuid();
  await tx.query(
    `INSERT INTO notifications (id, user_id, type, title, body, link) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, userId, input.type, input.title, input.body, input.link ?? null],
  );
  return id;
}
