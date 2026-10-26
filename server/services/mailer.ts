import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env.js';
import type { AppLogger } from './logger.js';

export class Mailer {
  private transporter: Transporter | null;

  constructor(private readonly log: AppLogger) {
    this.transporter = env.smtpUrl ? nodemailer.createTransport(env.smtpUrl) : null;
  }

  get configured(): boolean { return !!this.transporter; }

  async send(to: string, subject: string, text: string): Promise<{ delivered: boolean; reason?: string }> {
    if (!this.transporter) {
      // Never pretend an email was delivered. In development the caller can
      // surface the one-time token through a protected local dev endpoint.
      this.log.warn({ subject }, 'SMTP_URL is not configured; security email was not delivered');
      return { delivered: false, reason: 'SMTP_URL is not configured' };
    }
    await this.transporter.sendMail({ from: env.emailFrom, to, subject, text });
    return { delivered: true };
  }
}
