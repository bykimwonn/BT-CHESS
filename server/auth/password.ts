import { hash, verify } from '@node-rs/argon2';

// OWASP-recommended Argon2id parameters; tune upward after load testing.
const OPTIONS = {
  // @node-rs/argon2 defaults to Argon2id; verified by the $argon2id$ hash prefix.
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

export async function hashPassword(password: string): Promise<string> {
  // @node-rs/argon2 generates a cryptographically secure random salt by default.
  return hash(password, OPTIONS);
}

export async function verifyPassword(hashValue: string, password: string): Promise<boolean> {
  try { return await verify(hashValue, password, OPTIONS); } catch { return false; }
}
