import crypto from 'node:crypto';

export const uuid = (): string => crypto.randomUUID();
export const randomToken = (bytes = 32): string => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');
export const hmacHex = (key: string, value: string | Buffer): string =>
  crypto.createHmac('sha256', key).update(value).digest('hex');

export function safeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b) || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export function safeEqualText(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
