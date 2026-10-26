/**
 * Security email templates. Every message ships a plain-text part and an HTML
 * part. No tracking pixels, no remote assets: a security email should not leak
 * that it was opened, and it must render in a locked-down mail client.
 */

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function layout(options: {
  title: string;
  intro: string;
  actionLabel?: string;
  actionUrl?: string;
  fallbackUrl?: string;
  after: string;
  footer: string;
}): string {
  const button = options.actionLabel && options.actionUrl
    ? `<p style="margin:24px 0"><a href="${escapeHtml(options.actionUrl)}" style="background:#0f766e;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">${escapeHtml(options.actionLabel)}</a></p>`
    : '';
  const fallback = options.fallbackUrl
    ? `<p style="font-size:12px;color:#5b6472;margin:0 0 8px">If the button does not work, copy this link into your browser:</p>
       <p style="font-size:12px;word-break:break-all;margin:0 0 16px"><a href="${escapeHtml(options.fallbackUrl)}" style="color:#0f766e">${escapeHtml(options.fallbackUrl)}</a></p>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(options.title)}</title></head>
<body style="margin:0;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;padding:32px;border:1px solid #e5e7eb">
        <tr><td>
          <p style="margin:0 0 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#0f766e;font-weight:700">Rookstone Arena</p>
          <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3">${escapeHtml(options.title)}</h1>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.6">${escapeHtml(options.intro)}</p>
          ${button}
          ${fallback}
          <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#374151">${escapeHtml(options.after)}</p>
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
          <p style="margin:0;font-size:12px;line-height:1.6;color:#6b7280">${escapeHtml(options.footer)}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

const SECURITY_FOOTER = 'Rookstone Arena will never ask for your password, a one-time code or a mobile-money PIN by email.';

export function verificationEmail(link: string, expiresHours = 48): EmailContent {
  return {
    subject: 'Verify your Rookstone Arena email',
    text: [
      'Confirm the email address on your Rookstone Arena account.',
      '',
      `Open this link to verify your email (valid for ${expiresHours} hours):`,
      link,
      '',
      'If you did not create this account, ignore this message. The address stays unverified without this link.',
      '',
      SECURITY_FOOTER,
    ].join('\n'),
    html: layout({
      title: 'Verify your email address',
      intro: `Confirm the email address on your Rookstone Arena account. This link is valid for ${expiresHours} hours and can be used once.`,
      actionLabel: 'Verify email',
      actionUrl: link,
      fallbackUrl: link,
      after: 'If you did not create this account, ignore this message. The address stays unverified without this link.',
      footer: SECURITY_FOOTER,
    }),
  };
}

export function passwordResetEmail(link: string, expiresMinutes = 60): EmailContent {
  return {
    subject: 'Reset your Rookstone Arena password',
    text: [
      'A password reset was requested for your Rookstone Arena account.',
      '',
      `Open this link to choose a new password (valid for ${expiresMinutes} minutes, single use):`,
      link,
      '',
      'If you did not request this, do not open the link. Your current password still works and all other sessions were not changed.',
      '',
      SECURITY_FOOTER,
    ].join('\n'),
    html: layout({
      title: 'Choose a new password',
      intro: `A password reset was requested for your Rookstone Arena account. This link is valid for ${expiresMinutes} minutes and can be used once.`,
      actionLabel: 'Reset password',
      actionUrl: link,
      fallbackUrl: link,
      after: 'If you did not request this, do not open the link. Your current password still works and all other sessions were not changed.',
      footer: SECURITY_FOOTER,
    }),
  };
}

export function newSignInEmail(when: string, ipHint?: string): EmailContent {
  const where = ipHint ? ` from network ${ipHint}` : '';
  return {
    subject: 'New sign-in to Rookstone Arena',
    text: [
      `A new device or network signed in to your Rookstone Arena account${where} at ${when}.`,
      '',
      'If this was you, no action is needed.',
      'If this was not you, reset your password immediately and revoke all sessions from Settings.',
      '',
      SECURITY_FOOTER,
    ].join('\n'),
    html: layout({
      title: 'New sign-in to your account',
      intro: `A new device or network signed in to your Rookstone Arena account${where} at ${when}.`,
      after: 'If this was you, no action is needed. If this was not you, reset your password immediately and revoke all sessions from Settings.',
      footer: SECURITY_FOOTER,
    }),
  };
}

export function testEmail(sentAt: string, environment: string): EmailContent {
  return {
    subject: 'Rookstone Arena email delivery test',
    text: [
      'This is a delivery test from Rookstone Arena.',
      '',
      `Sent at ${sentAt} (${environment}).`,
      'If you received this message, SMTP delivery and sender authentication work for this deployment.',
      '',
      'No account action is required.',
    ].join('\n'),
    html: layout({
      title: 'Email delivery is working',
      intro: `This is a delivery test from Rookstone Arena, sent at ${sentAt} (${environment}).`,
      after: 'If you received this message, SMTP delivery and sender authentication work for this deployment. No account action is required.',
      footer: 'This message was requested by a platform administrator.',
    }),
  };
}
