import crypto from 'node:crypto';
import { safeEqualText } from '../services/ids.js';

/** Paynow's documented SHA-512 hash: raw values in message order + integration key. */
export function paynowHash(values: Iterable<[string, string]>, integrationKey: string): string {
  let message = '';
  for (const [key, value] of values) {
    if (key.toLowerCase() === 'hash') continue;
    message += value;
  }
  return crypto.createHash('sha512').update(message + integrationKey, 'utf8').digest('hex').toUpperCase();
}

export interface PaynowFields {
  entries: [string, string][];
  get(name: string): string | undefined;
  lower(): Record<string, string>;
}

/** Parse a URL-encoded Paynow status/initiate message, preserving field order. */
export function parsePaynowFields(raw: string): PaynowFields {
  const entries: [string, string][] = [];
  for (const pair of raw.split('&')) {
    if (!pair) continue;
    const index = pair.indexOf('=');
    const key = decodeURIComponent((index < 0 ? pair : pair.slice(0, index)).replace(/\+/g, ' '));
    const value = decodeURIComponent((index < 0 ? '' : pair.slice(index + 1)).replace(/\+/g, ' '));
    entries.push([key, value]);
  }
  return {
    entries,
    get(name: string) {
      const found = entries.find(([key]) => key.toLowerCase() === name.toLowerCase());
      return found?.[1];
    },
    lower() {
      return Object.fromEntries(entries.map(([key, value]) => [key.toLowerCase(), value]));
    },
  };
}

export function verifyPaynowHash(raw: string, integrationKey: string): { valid: boolean; fields: PaynowFields } {
  const fields = parsePaynowFields(raw);
  const supplied = fields.get('hash');
  if (!supplied) return { valid: false, fields };
  return { valid: safeEqualText(paynowHash(fields.entries, integrationKey), supplied.toUpperCase()), fields };
}

export function centsToPaynowAmount(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error('Invalid amount');
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}
