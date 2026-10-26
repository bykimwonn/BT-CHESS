import type { CorsOptions } from 'cors';
import { env } from '../config/env.js';

/**
 * Production requires explicitly configured origins. Development additionally
 * accepts Arena's HTTPS preview proxy host so a Vite preview can reach the API.
 */
export function isAllowedOrigin(origin?: string | null): boolean {
  if (!origin) return true;
  const explicit = [env.publicOrigin, ...env.corsOrigins];
  if (explicit.includes(origin)) return true;
  if (!env.isProduction && /^https:\/\/[a-z0-9-]+\.e2b\.app$/i.test(origin)) return true;
  return false;
}

export const corsOptions: CorsOptions = {
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) callback(null, true);
    else callback(new Error('Origin is not allowed'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'X-MFA-Code', 'Authorization'],
};

export function socketOriginCallback(origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void): void {
  if (origin && isAllowedOrigin(origin)) callback(null, true);
  else callback(new Error('Origin is not allowed'));
}
