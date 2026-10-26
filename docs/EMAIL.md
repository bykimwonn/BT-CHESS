# Email delivery (verification and password reset)

Rookstone Arena sends three security messages:

| Message | Trigger | Lifespan |
| --- | --- | --- |
| Verify your email | Registration, or Settings → resend | 48 hours, single use |
| Reset your password | Forgot password | 60 minutes, single use |
| New sign-in | First sign-in from a new network/device | Informational |

Email is **not optional in production**. Without a working SMTP transport, a player who forgets their password cannot recover the account, and accounts stay unverified. The server never reports an undelivered message as sent: the API returns `{ delivered: false, reason }` and the admin panel shows the SMTP error.

## Supported configurations

Pick one. The first one that is present wins.

### 1. Gmail or Google Workspace (recommended starting point)

```bash
EMAIL_PROVIDER=gmail
SMTP_USER=your.address@gmail.com
SMTP_PASS=abcd efgh ijkl mnop      # 16-character Google App Password
EMAIL_FROM="Rookstone Arena <your.address@gmail.com>"
```

`SMTP_HOST` defaults to `smtp.gmail.com`, `SMTP_PORT` to `465` and `SMTP_SECURE` to `true` when the provider is `gmail`.

**A normal Gmail password will not work.** Google requires an App Password:

1. Open <https://myaccount.google.com/security> and enable **2-Step Verification**.
2. Open <https://myaccount.google.com/apppasswords>.
3. Create an app password (name it "Rookstone Arena") and copy the 16 characters.
4. Paste it as `SMTP_PASS`, spaces allowed. Revoke the password in the same screen if it leaks.
5. Accounts enrolled in **Advanced Protection** cannot create App Passwords. Use Google Workspace SMTP relay or a transactional provider instead.

Gmail constraints worth knowing before go-live:

- The `From` address must be the authenticated account or a verified alias. Gmail silently rewrites anything else, so `EMAIL_FROM` must match `SMTP_USER`. The preflight fails when they differ.
- Changing the Google account password revokes app passwords. Rotate `SMTP_PASS` at the same time.
- Google publishes daily sending limits (roughly 500 recipients/day on free Gmail and about 2,000 on Workspace). That is fine for verification mail and password resets for a small player base, not for marketing or for a launch spike.
- Standard Gmail cannot send as `no-reply@yourdomain.co.zw`. To use your own domain, use Google Workspace with the domain verified, or a transactional provider.

### 2. Any other SMTP server

```bash
EMAIL_PROVIDER=smtp
SMTP_HOST=smtp.yourprovider.com
SMTP_PORT=587
SMTP_SECURE=false          # 587 uses STARTTLS; 465 uses implicit TLS
SMTP_REQUIRE_TLS=true      # optional, forces STARTTLS
SMTP_USER=postmaster@yourdomain.co.zw
SMTP_PASS=<password or API key>
EMAIL_FROM="Rookstone Arena <no-reply@yourdomain.co.zw>"
EMAIL_REPLY_TO=support@yourdomain.co.zw   # optional
```

### 3. A full connection string

```bash
SMTP_URL=smtps://USER:PASSWORD@smtp.example.com:465
EMAIL_FROM="Rookstone Arena <no-reply@example.com>"
```

`SMTP_URL` is kept for hosts that inject a single DSN. URL-encode characters such as `@`, `:` and `#` in the password.

## Verifying it actually works

From the server or your laptop, with the same environment variables:

```bash
npm run email:test -- you@gmail.com
```

The command prints the resolved transport, opens a real SMTP session (`verify()`), sends a message and exits non-zero on any failure. It refuses to claim success when SMTP is not configured.

From the admin panel: **Providers → Email delivery → Send test email**. That path requires MFA, a documented reason and confirmation, and it is written to the audit log (including failures). Rate limited to 10 requests per 15 minutes per instance.

`npm run preflight -- --smtp` runs the same handshake alongside every other go-live check without sending a message.

## Common failures

| Symptom | Cause | Fix |
| --- | --- | --- |
| `EAUTH` / `535-5.7.8` | Normal Gmail password, or 2FA not enabled | Create an App Password and enable 2-Step Verification |
| `EAUTH` after changing the Google password | App passwords revoked | Issue a new App Password |
| `Username and Password not accepted` | Spaces/typos, or the account uses Advanced Protection | Re-create the App Password; use Workspace relay or another provider |
| `ETIMEDOUT` / `ESOCKET` on 465 or 587 | Hosting blocks outbound SMTP | Ask the host to allow outbound SMTP, or use an API provider over HTTPS |
| `ENOTFOUND` | Wrong host, or DNS blocked | Check `SMTP_HOST` |
| Message accepted but lands in spam | Gmail sending on behalf of another domain, or no SPF/DKIM | Use the same domain as the authenticated account and publish SPF/DKIM |
| `EMAIL_FROM is not a valid email address` | Bare name or typo | Use `Name <address@domain>` or a bare address |
| `Gmail rewrites the From address…` | `EMAIL_FROM` differs from `SMTP_USER` | Make them identical or use a verified alias |

## Operational notes

- `EMAIL_FROM` must not stay at `no-reply@example.invalid`; preflight fails on placeholder domains.
- Every security message includes a plain-text part and an HTML part, contains no tracking pixels and no remote assets.
- The reset/verification links are built from `PUBLIC_ORIGIN`. If that is wrong, the mail is delivered but the link is unusable, which is why preflight checks the origin.
- In development, without SMTP, the API returns the one-time token in the response so the flow can still be tested. That never happens in production.
- Passwords are never logged. The mailer logs only the subject, host, port and message id.
