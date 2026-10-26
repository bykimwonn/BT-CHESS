import crypto from 'node:crypto';

/** PesePay documented AES-256-CBC envelope: key = 32-char key, IV = first 16 chars. */
export class PesePayCrypto {
  constructor(private readonly key: string) {
    if (Buffer.byteLength(key, 'utf8') !== 32) throw new Error('PESEPAY encryption key must be exactly 32 bytes');
  }

  encrypt(data: unknown): string {
    const iv = Buffer.from(this.key.slice(0, 16), 'utf8');
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(this.key, 'utf8'), iv);
    return Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]).toString('base64');
  }

  decrypt<T = Record<string, unknown>>(payload: string): T {
    const iv = Buffer.from(this.key.slice(0, 16), 'utf8');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(this.key, 'utf8'), iv);
    const plain = Buffer.concat([decipher.update(Buffer.from(payload, 'base64')), decipher.final()]).toString('utf8');
    return JSON.parse(plain) as T;
  }
}
