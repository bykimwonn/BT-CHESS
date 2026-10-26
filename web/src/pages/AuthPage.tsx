import { useMemo, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, errorMessage } from '../lib/api';
import { useAuth } from '../app/AuthProvider';
import { useToast } from '../app/ToastProvider';
import { Icon } from '../components/Icon';
import { browserTimeZone, countryOptions } from '@shared/countries';

type Mode = 'login' | 'register' | 'forgot' | 'reset' | 'verify';

function passwordScore(password: string): number {
  return [password.length >= 10, /[a-z]/.test(password), /[A-Z]/.test(password), /\d/.test(password), /[^A-Za-z0-9]/.test(password)]
    .filter(Boolean).length;
}

export function AuthPage() {
  const [params] = useSearchParams();
  const location = useLocation();
  const routeMode: Mode | null = location.pathname === '/verify-email' ? 'verify'
    : location.pathname === '/reset-password' ? 'reset' : null;
  const initial = routeMode ?? (params.get('mode') as Mode | null) ?? (params.get('token') ? 'reset' : 'login');
  const token = params.get('token') ?? '';
  const next = params.get('next') ?? '/play';
  const [mode, setMode] = useState<Mode>(['login', 'register', 'forgot', 'reset', 'verify'].includes(initial) ? initial : 'login');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [mfaRequired, setMfaRequired] = useState(false);
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [country, setCountry] = useState('ZZ');
  const [countryShared, setCountryShared] = useState(false);
  const [timezoneShared, setTimezoneShared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [devToken, setDevToken] = useState<string | null>(null);
  const { login, register } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const score = useMemo(() => passwordScore(password), [password]);

  const switchMode = (value: Mode) => { setMode(value); setNotice(null); setDevToken(null); setMfaRequired(false); };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setNotice(null); setDevToken(null);
    try {
      if (mode === 'login') {
        await login(email, password, mfaCode || undefined);
        toast.success('Welcome back', 'Your secure session is active.');
        navigate(next, { replace: true });
      } else if (mode === 'register') {
        if (password !== confirmPassword) throw new Error('Passwords do not match');
        if (!acceptTerms) throw new Error('Please accept the terms and privacy notice');
        const result = await register({
          username, email, password, displayName: displayName || username,
          country, countryShared: countryShared && country !== 'ZZ',
          timezone: browserTimeZone(), timezoneShared,
          accountCurrency: 'USD',
        });
        toast.success('Account created', result.emailVerified ? 'Your email is verified.' : 'Verify your email from Settings when SMTP is configured.');
        navigate(next, { replace: true });
      } else if (mode === 'forgot') {
        const result = await api<{ delivered: boolean; devResetToken?: string; reason?: string }>('/auth/forgot', { method: 'POST', body: { email } });
        setNotice(result.delivered
          ? 'If an account exists for that address, a password reset link has been sent.'
          : `Password reset email cannot be delivered: ${result.reason ?? 'SMTP is not configured'}.`);
        if (result.devResetToken) setDevToken(result.devResetToken);
      } else if (mode === 'reset') {
        await api('/auth/reset', { method: 'POST', body: { token, password } });
        setNotice('Password updated. Sign in with your new password; other sessions were revoked.');
        setPassword(''); setConfirmPassword('');
        switchMode('login');
      } else if (mode === 'verify') {
        await api('/auth/verify-email', { method: 'POST', body: { token } });
        setNotice('Email verified. You can close this page or continue to Play.');
      }
    } catch (error) {
      if (error instanceof ApiError && error.code === 'mfa_required') {
        setMfaRequired(true);
        setNotice('Enter the six-digit code from your authenticator app.');
      } else {
        toast.error('Could not continue', errorMessage(error));
      }
    } finally { setBusy(false); }
  };

  return (
    <div className="container auth-layout">
      <div className="stack" style={{ gap: '1.25rem' }}>
        <span className="eyebrow">Secure account access</span>
        <h1 style={{ fontSize: 'clamp(2.4rem, 5vw, 4rem)' }}>Play with <span className="accent">confidence.</span></h1>
        <p className="hero-lead">Argon2id password hashing, rotating sessions, CSRF protection, optional TOTP MFA and audited security events protect every account.</p>
        <div className="grid-2">
          <div className="alert"><strong><Icon name="lock" size={16} /> Password reset</strong><p className="small" style={{ margin: '.35rem 0 0' }}>One-time, expiring, single-use tokens. All other sessions are revoked after a reset.</p></div>
          <div className="alert"><strong><Icon name="shield" size={16} /> Privileged actions</strong><p className="small" style={{ margin: '.35rem 0 0' }}>Production administrators must enable MFA and confirm high-impact actions.</p></div>
        </div>
        <p className="small muted">By continuing you agree to the <Link to="/legal#terms">Terms</Link> and <Link to="/legal#privacy">Privacy notice</Link>. Real-money competitions are disabled unless the platform displays independently verified authorisation.</p>
      </div>

      <div className="card auth-card">
        <div className="tabs" role="tablist" aria-label="Account access options">
          {(['login', 'register'] as const).map((item) => (
            <button key={item} className={`tab ${mode === item ? 'active' : ''}`} role="tab" aria-selected={mode === item} onClick={() => switchMode(item)}>
              {item === 'login' ? 'Sign in' : 'Create account'}
            </button>
          ))}
        </div>
        <h2 style={{ fontSize: '1.6rem' }}>{mode === 'login' ? 'Welcome back' : mode === 'register' ? 'Join Rookstone Arena' : mode === 'forgot' ? 'Reset your password' : mode === 'reset' ? 'Choose a new password' : 'Verify your email'}</h2>

        <form className="stack" onSubmit={(e) => void submit(e)}>
          {(mode === 'login' || mode === 'register' || mode === 'forgot') && (
            <label className="field">
              <span className="field-label">Email address</span>
              <input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            </label>
          )}
          {mode === 'register' && (
            <>
              <label className="field"><span className="field-label">Username</span>
                <input className="input" required minLength={3} maxLength={24} pattern="[a-zA-Z][a-zA-Z0-9_]+" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="QueensGambit" />
                <span className="field-hint">3–24 letters, numbers or underscores; must start with a letter.</span>
              </label>
              <label className="field"><span className="field-label">Display name (optional)</span>
                <input className="input" maxLength={48} value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="How others see you" />
              </label>
              <label className="field"><span className="field-label">Country of residence (optional)</span>
                <select className="select" value={country} onChange={(e) => { setCountry(e.target.value); if (e.target.value === 'ZZ') setCountryShared(false); }}>
                  {countryOptions().map((option) => <option key={option.code} value={option.code}>{option.flag} {option.label}</option>)}
                </select>
                <span className="field-hint">Used only for voluntary display and free-play policy. Never used alone to approve real money.</span>
              </label>
              <label className="checkbox"><input type="checkbox" checked={countryShared} disabled={country === 'ZZ'} onChange={(e) => setCountryShared(e.target.checked)} />
                <span>Show my country flag on my profile and tournament standings.</span></label>
              <label className="checkbox"><input type="checkbox" checked={timezoneShared} onChange={(e) => setTimezoneShared(e.target.checked)} />
                <span>Share my local timezone with opponents so they can see game times in my timezone.</span></label>
            </>
          )}
          {(mode === 'login' || mode === 'register' || mode === 'reset') && (
            <label className="field">
              <span className="field-label">{mode === 'reset' ? 'New password' : 'Password'}</span>
              <input className="input" type="password" required minLength={mode === 'login' ? 1 : 10} autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 10 characters" />
              {mode !== 'login' && <>
                <div className="password-meter" aria-label={`Password strength ${score} of 5`}>{[1, 2, 3, 4, 5].map((n) => <span key={n} className={score >= n ? 'filled' : ''} />)}</div>
                <span className="field-hint">Use 10+ characters with uppercase, lowercase and a number.</span>
              </>}
            </label>
          )}
          {mode === 'register' && (
            <label className="field"><span className="field-label">Confirm password</span>
              <input className="input" type="password" required value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
            </label>
          )}
          {mfaRequired && mode === 'login' && (
            <label className="field"><span className="field-label">Authenticator code</span>
              <input className="input mono" inputMode="numeric" pattern="\\d{6}" maxLength={6} required value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} placeholder="123456" />
              <span className="field-hint">Enter the current six-digit TOTP code.</span>
            </label>
          )}
          {mode === 'register' && (
            <label className="checkbox"><input type="checkbox" aria-label="Accept terms" checked={acceptTerms} onChange={(e) => setAcceptTerms(e.target.checked)} required />
              <span>I accept the terms, privacy notice and responsible-play policy. I confirm I am old enough to use this service in my jurisdiction.</span></label>
          )}
          {notice && <div className="alert alert-success">{notice}</div>}
          {devToken && (
            <div className="alert alert-warning">
              <strong>Local development token.</strong> SMTP is not configured, so no email was sent. This token is shown only in development:
              <div className="mono small" style={{ overflowWrap: 'anywhere' }}>{devToken}</div>
              <Link to={`/auth?mode=reset&token=${encodeURIComponent(devToken)}`}>Use this reset token</Link>
            </div>
          )}
          <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
            {busy ? <span className="loading" /> : null}
            {mode === 'login' ? 'Sign in' : mode === 'register' ? 'Create account' : mode === 'forgot' ? 'Send reset link' : mode === 'reset' ? 'Update password' : 'Verify email'}
          </button>
        </form>

        <div className="stack" style={{ marginTop: '1rem', gap: '.5rem' }}>
          {mode === 'login' && <>
            <button className="btn btn-ghost btn-sm" onClick={() => switchMode('forgot')}>Forgot your password?</button>
            <span className="small muted">No account? <button className="btn btn-ghost btn-sm" onClick={() => switchMode('register')}>Create one</button></span>
          </>}
          {mode === 'register' && <span className="small muted">Already registered? <button className="btn btn-ghost btn-sm" onClick={() => switchMode('login')}>Sign in</button></span>}
          {mode !== 'login' && mode !== 'register' && <button className="btn btn-sm" onClick={() => switchMode('login')}>Back to sign in</button>}
        </div>
      </div>
    </div>
  );
}
