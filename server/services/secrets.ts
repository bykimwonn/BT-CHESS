import crypto from 'node:crypto';
import { env } from '../config/env.js';

let ephemeral: string | null = null;

/** Session-token pepper. Production requires a stable configured secret. */
export function sessionSecret(): string {
  if (env.sessionSecret) return env.sessionSecret;
  if (env.isProduction) throw new Error('SESSION_SECRET is required in production');
  if (!ephemeral) ephemeral = crypto.randomBytes(48).toString('hex');
  return ephemeral;
}
