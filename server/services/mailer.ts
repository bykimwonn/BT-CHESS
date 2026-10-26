import nodemailer, { type Transporter } from 'nodemailer';
import { env, type EmailSettings } from '../config/env.js';
import type { EmailContent } from './email-templates.js';
import type { AppLogger } from './logger.js';

export interface MailDelivery {
  delivered: boolean;
  reason?: string;
  messageId?: string;
}

export interface MailStatus {
  configured: boolean;
  provider: EmailSettings['provider'];
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  from: string;
  replyTo: string | null;
  problems: string[];
  lastError: string | null;
  lastSuccessAt: string | null;
}

interface AddressParts {
  name: string | null;
  address: string;
}

/** Parse `Name <a@b.c>` or a bare address without throwing on odd input. */
export function parseAddress(value: string): AddressParts {
  const trimmed = value.trim();
  const angled = /^(.*?)<([^<>]+)>$/.exec(trimmed);
  if (angled) {
    const name = angled[1].trim().replace(/^"|"$/g, '').trim();
    return { name: name || null, address: angled[2].trim() };
  }
  return { name: null, address: trimmed };
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Configuration problems that will stop real delivery. Kept as data so the
 * admin panel and the preflight script can show the same explanation.
 */
export function emailProblems(settings: EmailSettings): string[] {
  if (settings.provider === 'none') {
    return ['Email delivery is disabled (EMAIL_PROVIDER=none); set EMAIL_PROVIDER=gmail or EMAIL_PROVIDER=smtp with credentials'];
  }
  const problems: string[] = [];
  const sender = parseAddress(settings.from);
  if (settings.smtpUrl) {
    if (!/^smtps?:\/\//i.test(settings.smtpUrl)) problems.push('SMTP_URL must start with smtp:// or smtps://');
  } else {
    if (!settings.host) problems.push('SMTP_HOST or EMAIL_PROVIDER=gmail is required');
    if (!settings.user) problems.push('SMTP_USER is required');
    if (!settings.pass) {
      problems.push(settings.provider === 'gmail'
        ? 'SMTP_PASS (the 16-character Google App Password) is required'
        : 'SMTP_PASS is required');
    }
  }
  if (!EMAIL_SHAPE.test(sender.address)) problems.push('EMAIL_FROM is not a valid email address');
  if (/@example\.(invalid|com)$/i.test(sender.address)) {
    problems.push('EMAIL_FROM still uses a placeholder domain; set the address you control');
  }
  if (settings.replyTo && !EMAIL_SHAPE.test(parseAddress(settings.replyTo).address)) {
    problems.push('EMAIL_REPLY_TO is not a valid email address');
  }
  if (settings.provider === 'gmail') {
    const normalized = settings.pass.replace(/\s+/g, '');
    if (settings.pass && normalized.length !== 16) {
      problems.push('Gmail rejects normal account passwords: create a 16-character App Password (Google Account → Security → 2-Step Verification → App passwords)');
    }
    if (settings.host && settings.host.toLowerCase() !== 'smtp.gmail.com') {
      problems.push(`EMAIL_PROVIDER=gmail expects smtp.gmail.com, but SMTP_HOST is ${settings.host}`);
    }
    if (settings.user && sender.address.toLowerCase() !== settings.user.toLowerCase()) {
      problems.push('Gmail rewrites the From address to the authenticated account; set EMAIL_FROM to the same address as SMTP_USER or a verified alias');
    }
  }
  return problems;
}

export function maskEmail(value: string): string {
  const { address } = parseAddress(value);
  const [name, domain] = address.split('@');
  return domain ? `${name.slice(0, 2)}${'•'.repeat(Math.max(2, Math.min(name.length - 2, 6)))}@${domain}` : address;
}

/** Turn a nodemailer error into an explanation an operator can act on. */
export function explainSmtpError(error: unknown, settings: EmailSettings): string {
  const err = error as { code?: string; responseCode?: number; message?: string } | null;
  const code = String(err?.code ?? '').toUpperCase();
  const responseCode = Number(err?.responseCode ?? 0);
  const detail = String(err?.message ?? 'Unknown SMTP failure').split('\n')[0].slice(0, 200);
  if (code === 'EAUTH' || responseCode === 535 || responseCode === 534) {
    return settings.provider === 'gmail'
      ? 'Gmail rejected the sign-in (EAUTH). Use a 16-character App Password from a Google account with 2-Step Verification enabled, not the normal password. If the account uses Advanced Protection, an App Password is not available; use SMTP_URL with a different provider.'
      : `The SMTP server rejected the credentials (${detail}). Check SMTP_USER and SMTP_PASS.`;
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `SMTP host ${settings.host || '(from SMTP_URL)'} could not be resolved. Check the host name and the deployment's DNS.`;
  }
  if (['ETIMEDOUT', 'ESOCKET', 'ECONNECTION', 'ECONNREFUSED', 'EHOSTUNREACH'].includes(code)) {
    return `Could not reach ${settings.host || 'the SMTP host'}:${settings.port || 465}. Many hosts block outbound SMTP ports; try 465 (implicit TLS) or 587 (STARTTLS) and confirm the network allows outbound SMTP.`;
  }
  if (code === 'EENVELOPE') {
    return `The server rejected the sender or recipient address: ${detail}. EMAIL_FROM must be an address the SMTP account is allowed to send as.`;
  }
  if (code === 'EMESSAGE') {
    return `The message was rejected: ${detail}`;
  }
  return `SMTP delivery failed: ${detail}`;
}

export class Mailer {
  private transporter: Transporter | null;
  private lastError: string | null = null;
  private lastSuccessAt: string | null = null;

  constructor(
    private readonly log: AppLogger,
    private readonly settings: EmailSettings = env.email,
  ) {
    this.transporter = this.settings.provider === 'none' ? null : this.buildTransport();
  }

  private buildTransport(): Transporter {
    if (this.settings.smtpUrl) {
      return nodemailer.createTransport({
        url: this.settings.smtpUrl,
        pool: true,
        maxConnections: 2,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
      });
    }
    return nodemailer.createTransport({
      host: this.settings.host,
      port: this.settings.port,
      secure: this.settings.secure,
      requireTLS: this.settings.requireTls,
      auth: { user: this.settings.user, pass: this.settings.pass },
      pool: true,
      maxConnections: 2,
      maxMessages: 50,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      tls: { minVersion: 'TLSv1.2' },
    });
  }

  get configured(): boolean {
    return !!this.transporter && emailProblems(this.settings).length === 0;
  }

  status(): MailStatus {
    return {
      configured: this.configured,
      provider: this.settings.provider,
      host: this.settings.host,
      port: this.settings.port,
      secure: this.settings.secure,
      user: this.settings.user ? maskEmail(this.settings.user) : null,
      from: this.settings.from,
      replyTo: this.settings.replyTo || null,
      problems: emailProblems(this.settings),
      lastError: this.lastError,
      lastSuccessAt: this.lastSuccessAt,
    };
  }

  /** Open a real SMTP connection and authenticate without sending a message. */
  async verify(): Promise<{ ok: boolean; reason?: string }> {
    if (!this.transporter) {
      return { ok: false, reason: 'SMTP is not configured (set EMAIL_PROVIDER=gmail plus SMTP_USER and SMTP_PASS)' };
    }
    const problems = emailProblems(this.settings);
    if (problems.length) return { ok: false, reason: problems.join('; ') };
    try {
      await this.transporter.verify();
      this.lastError = null;
      this.log.info({ host: this.settings.host, port: this.settings.port }, 'SMTP connection verified');
      return { ok: true };
    } catch (error) {
      const reason = explainSmtpError(error, this.settings);
      this.lastError = reason;
      this.log.error({ err: (error as Error).message, code: (error as { code?: string }).code }, 'SMTP verification failed');
      return { ok: false, reason };
    }
  }

  async sendContent(to: string, content: EmailContent): Promise<MailDelivery> {
    return this.send(to, content.subject, content.text, content.html);
  }

  /**
   * Never throws for a delivery failure: callers such as registration must not
   * roll back because a mailbox is unreachable. The failure is reported to the
   * caller and logged, and the server never claims an email was delivered.
   */
  async send(to: string, subject: string, text: string, html?: string): Promise<MailDelivery> {
    if (!this.transporter) {
      const reason = 'SMTP is not configured; email was not delivered';
      this.lastError = reason;
      this.log.warn({ subject }, 'email not delivered: SMTP is not configured');
      return { delivered: false, reason };
    }
    const problems = emailProblems(this.settings);
    if (problems.length) {
      const reason = problems.join('; ');
      this.lastError = reason;
      this.log.warn({ subject, problems }, 'email not delivered: SMTP configuration is invalid');
      return { delivered: false, reason };
    }
    if (!EMAIL_SHAPE.test(parseAddress(to).address)) {
      return { delivered: false, reason: 'Recipient address is not a valid email address' };
    }
    try {
      const info = await this.transporter.sendMail({
        from: this.settings.from,
        to,
        replyTo: this.settings.replyTo || undefined,
        subject,
        text,
        html,
        headers: { 'X-Auto-Response-Suppress': 'All', 'Auto-Submitted': 'auto-generated' },
      });
      this.lastError = null;
      this.lastSuccessAt = new Date().toISOString();
      this.log.info({ subject, messageId: info.messageId }, 'email delivered to SMTP server');
      return { delivered: true, messageId: info.messageId };
    } catch (error) {
      const reason = explainSmtpError(error, this.settings);
      this.lastError = reason;
      this.log.error({ err: (error as Error).message, code: (error as { code?: string }).code, subject }, 'email delivery failed');
      return { delivered: false, reason };
    }
  }
}
