import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { EligibilityView, PlatformStatus } from '@shared/contracts';
import { browserTimeZone, countryOptions, formatLocalDateTime, isValidTimeZone } from '@shared/countries';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../app/AuthProvider';
import { useToast } from '../app/ToastProvider';
import { BOARD_THEMES, PIECE_THEMES, usePreferences } from '../app/ThemeProvider';
import { PageHeader } from '../components/PageHeader';
import { ProviderHealthCard } from '../components/Competition';
import { ConfirmDialog } from '../components/Modal';
import { Icon } from '../components/Icon';

type Tab = 'account' | 'security' | 'preferences' | 'international' | 'responsible' | 'compliance';

export function SettingsPage() {
  const { user, logout, refresh, setMfaEnabled, mfaEnabled } = useAuth();
  const prefs = usePreferences();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>('account');
  const [profile, setProfile] = useState({ displayName: user?.displayName ?? '', bio: '', avatarUrl: '', birthYear: '' });
  const [password, setPassword] = useState({ current: '', next: '', confirm: '' });
  const [mfa, setMfa] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [mfaDisableCode, setMfaDisableCode] = useState('');
  const [mfaDisablePassword, setMfaDisablePassword] = useState('');
  const [limits, setLimits] = useState({ deposit: '', stake: '' });
  const [confirmExclude, setConfirmExclude] = useState(false);
  const [excludeReason, setExcludeReason] = useState('');
  const [international, setInternational] = useState({
    country: 'ZZ', countryShared: false, timezone: browserTimeZone(), timezoneShared: false, accountCurrency: 'USD',
  });
  const [busy, setBusy] = useState(false);

  const status = useQuery({ queryKey: ['platform-status'], queryFn: () => api<PlatformStatus>('/status'), staleTime: 60_000 });
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => api<{ items: Array<Record<string, unknown>> }>('/auth/sessions'), enabled: tab === 'security' });
  const restrictions = useQuery({ queryKey: ['restrictions'], queryFn: () => api<{ items: Array<Record<string, unknown>> }>('/responsible-play/restrictions'), enabled: tab === 'responsible' });
  const eligibility = useQuery({ queryKey: ['me-international'], queryFn: () => api<EligibilityView>('/me/international'), enabled: tab === 'international' });
  const me = useQuery({
    queryKey: ['me'],
    enabled: Boolean(user),
    queryFn: () => api<{ display_name?: string; bio?: string; avatar_url?: string | null; birth_year?: number | null }>('/me'),
  });

  useEffect(() => {
    if (!me.data) return;
    setProfile({
      displayName: me.data.display_name ?? '',
      bio: me.data.bio ?? '',
      avatarUrl: me.data.avatar_url ?? '',
      birthYear: me.data.birth_year ? String(me.data.birth_year) : '',
    });
  }, [me.data]);

  useEffect(() => {
    if (!eligibility.data) return;
    setInternational({
      country: eligibility.data.countryOfResidence,
      countryShared: eligibility.data.countryShared,
      timezone: eligibility.data.timezone || browserTimeZone(),
      timezoneShared: eligibility.data.timezoneShared,
      accountCurrency: eligibility.data.accountCurrency,
    });
  }, [eligibility.data]);

  const saveInternational = async () => {
    if (!isValidTimeZone(international.timezone)) { toast.error('Invalid timezone'); return; }
    if (international.country === 'ZZ' && international.countryShared) { toast.error('Choose a country before sharing it'); return; }
    setBusy(true);
    try {
      await api('/me/international', { method: 'PATCH', body: international });
      await refresh();
      void queryClient.invalidateQueries({ queryKey: ['me-international'] });
      void queryClient.invalidateQueries({ queryKey: ['eligibility'] });
      toast.success('International preferences saved');
    } catch (error) { toast.error('Could not save preferences', errorMessage(error)); }
    finally { setBusy(false); }
  };

  const saveProfile = async () => {
    setBusy(true);
    try {
      await api('/me', {
        method: 'PATCH',
        body: {
          displayName: profile.displayName,
          bio: profile.bio,
          avatarUrl: profile.avatarUrl.trim() ? profile.avatarUrl.trim() : null,
          birthYear: profile.birthYear.trim() ? Number(profile.birthYear) : null,
        },
      });
      await refresh();
      toast.success('Profile updated');
    } catch (error) { toast.error('Could not update profile', errorMessage(error)); }
    finally { setBusy(false); }
  };

  const sendVerificationEmail = async () => {
    setBusy(true);
    try {
      const result = await api<{ delivered: boolean; reason?: string }>('/auth/email-verification/send', {
        method: 'POST', body: {},
      });
      if (result.delivered) {
        toast.success('Verification email accepted', 'The SMTP server accepted the message. Check the inbox and spam folder.');
      } else {
        toast.error('Verification email not delivered', result.reason ?? 'The SMTP server did not accept the message.');
      }
    } catch (error) { toast.error('Email unavailable', errorMessage(error)); }
    finally { setBusy(false); }
  };

  const changePassword = async () => {
    if (password.next !== password.confirm) { toast.error('Passwords do not match'); return; }
    setBusy(true);
    try {
      await api('/auth/change-password', { method: 'POST', body: { currentPassword: password.current, newPassword: password.next } });
      toast.success('Password changed', 'All sessions were revoked. Sign in again.');
      await logout();
      navigate('/auth');
    } catch (error) { toast.error('Could not change password', errorMessage(error)); }
    finally { setBusy(false); }
  };

  const setupMfa = async () => {
    try { setMfa(await api<{ secret: string; otpauthUrl: string }>('/auth/mfa/setup', { method: 'POST', body: {} })); }
    catch (error) { toast.error('MFA setup failed', errorMessage(error)); }
  };
  const enableMfa = async () => {
    try {
      await api('/auth/mfa/verify', { method: 'POST', body: { code: mfaCode } });
      setMfaEnabled(true); setMfa(null); setMfaCode('');
      toast.success('MFA enabled', 'Administrator actions will now require a code in production.');
    } catch (error) { toast.error('Could not enable MFA', errorMessage(error)); }
  };
  const disableMfa = async () => {
    try {
      await api('/auth/mfa/disable', { method: 'POST', body: { code: mfaDisableCode, password: mfaDisablePassword } });
      setMfaEnabled(false); setMfaDisableCode(''); setMfaDisablePassword('');
      toast.info('MFA disabled');
    } catch (error) { toast.error('Could not disable MFA', errorMessage(error)); }
  };

  const saveLimits = async () => {
    setBusy(true);
    try {
      await api('/responsible-play/limits', { method: 'POST', body: {
        confirm: true,
        dailyDepositCents: limits.deposit === '' ? null : Math.round(Number(limits.deposit) * 100),
        dailyStakeCents: limits.stake === '' ? null : Math.round(Number(limits.stake) * 100),
      } });
      void queryClient.invalidateQueries({ queryKey: ['restrictions'] });
      toast.success('Limits updated', 'Server-enforced limits are effective immediately.');
    } catch (error) { toast.error('Could not update limits', errorMessage(error)); }
    finally { setBusy(false); }
  };

  const selfExclude = async () => {
    setBusy(true);
    try {
      await api('/responsible-play/self-exclude', { method: 'POST', body: { confirm: true, reason: excludeReason } });
      toast.info('Self-exclusion active', 'Your sessions have been revoked.');
      await logout();
      navigate('/');
    } catch (error) { toast.error('Could not activate self-exclusion', errorMessage(error)); }
    finally { setBusy(false); setConfirmExclude(false); }
  };

  return (
    <div className="container">
      <PageHeader eyebrow="Account" title="Settings" description="Manage your profile, security, board preferences, responsible-play controls and compliance information." />
      <div className="tabs" role="tablist" aria-label="Settings sections">
        {(['account', 'security', 'preferences', 'international', 'responsible', 'compliance'] as Tab[]).map((value) => (
          <button key={value} className={`tab ${tab === value ? 'active' : ''}`} role="tab" aria-selected={tab === value} onClick={() => setTab(value)}>{value}</button>
        ))}
      </div>

      {tab === 'account' && <div className="split">
        <section className="card"><div className="card-header"><h2 className="card-title">Profile</h2></div>
          <div className="stack">
            <label className="field"><span className="field-label">Display name</span><input className="input" value={profile.displayName} onChange={(e) => setProfile((p) => ({ ...p, displayName: e.target.value }))} maxLength={48} /></label>
            <label className="field"><span className="field-label">Bio</span><textarea className="textarea" value={profile.bio} onChange={(e) => setProfile((p) => ({ ...p, bio: e.target.value }))} maxLength={500} /></label>
            <label className="field"><span className="field-label">Avatar URL (optional)</span><input className="input" type="url" value={profile.avatarUrl} onChange={(e) => setProfile((p) => ({ ...p, avatarUrl: e.target.value }))} placeholder="https://…" /></label>
            <label className="field"><span className="field-label">Year of birth (optional)</span>
              <input className="input" inputMode="numeric" maxLength={4} value={profile.birthYear} placeholder="1998"
                onChange={(e) => setProfile((p) => ({ ...p, birthYear: e.target.value.replace(/\D/g, '').slice(0, 4) }))} />
              <span className="field-hint">Used only for FIDE's junior coefficient (K = 40 under 2300 until the end of the year of your 18th birthday). Never shown publicly.</span></label>
            <button className="btn btn-primary" onClick={() => void saveProfile()} disabled={busy}>Save profile</button>
          </div>
        </section>
        <aside className="card"><h2 className="card-title">Verification</h2>
          <div className="stack" style={{ gap: '.5rem' }}>
            <div className="alert"><strong>Email:</strong> {user?.emailVerified ? 'verified' : 'not verified'}</div>
            <div className="alert"><strong>18+ age check:</strong> {user?.ageVerified ? 'verified by provider' : 'not verified'}</div>
            <button className="btn btn-sm" disabled={busy} onClick={() => void sendVerificationEmail()}>Send verification email</button>
            <p className="tiny muted" style={{ marginBottom: 0 }}>Real-money competitions require provider-verified 18+ status. A self-declared birth date is not sufficient.</p>
          </div>
        </aside>
      </div>}

      {tab === 'security' && <div className="split">
        <div className="stack">
          <section className="card"><div className="card-header"><h2 className="card-title">Change password</h2></div>
            <div className="stack">
              <label className="field"><span className="field-label">Current password</span><input className="input" type="password" value={password.current} onChange={(e) => setPassword((p) => ({ ...p, current: e.target.value }))} /></label>
              <label className="field"><span className="field-label">New password</span><input className="input" type="password" value={password.next} onChange={(e) => setPassword((p) => ({ ...p, next: e.target.value }))} /></label>
              <label className="field"><span className="field-label">Confirm new password</span><input className="input" type="password" value={password.confirm} onChange={(e) => setPassword((p) => ({ ...p, confirm: e.target.value }))} /></label>
              <button className="btn btn-primary" onClick={() => void changePassword()} disabled={busy}>Update password</button>
              <p className="tiny muted" style={{ margin: 0 }}>Changing a password revokes all active sessions.</p>
            </div>
          </section>
          <section className="card"><div className="card-header"><h2 className="card-title">Active sessions</h2>
            <button className="btn btn-sm" onClick={() => void api('/auth/revoke-sessions', { method: 'POST', body: {} }).then(() => sessions.refetch())}>Revoke others</button></div>
            {sessions.data?.items.length === 0 && <p className="small muted">No sessions found.</p>}
            <div className="stack" style={{ gap: '.5rem' }}>{sessions.data?.items.map((session) => <div className="alert" key={String(session.id)}>
              <div className="spread"><strong>{String(session.user_agent || 'Unknown browser').slice(0, 60)}</strong><span className="tiny muted">{new Date(String(session.created_at)).toLocaleString()}</span></div>
              <button className="btn btn-sm" onClick={() => void api(`/auth/sessions/${String(session.id)}`, { method: 'DELETE' }).then(() => sessions.refetch())}>Revoke</button>
            </div>)}</div>
          </section>
        </div>
        <aside className="card"><div className="card-header"><h2 className="card-title">Multi-factor authentication</h2><span className={`pill ${mfaEnabled ? 'pill-success' : 'pill-danger'}`}>{mfaEnabled ? 'Enabled' : 'Disabled'}</span></div>
          {!mfaEnabled && !mfa && <div className="stack"><p className="small soft">Add a TOTP authenticator. Production administrators must enable MFA before using privileged controls.</p><button className="btn btn-primary" onClick={() => void setupMfa()}>Set up MFA</button></div>}
          {mfa && <div className="stack"><div className="alert alert-warning"><strong>Save this secret securely.</strong> It is shown once and stored encrypted on the server.</div>
            <label className="field"><span className="field-label">Base32 secret</span><input className="input mono small" readOnly value={mfa.secret} /></label>
            <label className="field"><span className="field-label">otpauth URI</span><textarea className="textarea pgn-box mono" readOnly value={mfa.otpauthUrl} /></label>
            <label className="field"><span className="field-label">Six-digit code</span><input className="input mono" inputMode="numeric" maxLength={6} value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} /></label>
            <button className="btn btn-primary" onClick={() => void enableMfa()} disabled={mfaCode.length !== 6}>Verify and enable</button></div>}
          {mfaEnabled && <div className="stack"><p className="small soft">MFA is verified at sign-in and for privileged administrator actions.</p>
            <label className="field"><span className="field-label">Current MFA code</span><input className="input mono" inputMode="numeric" maxLength={6} value={mfaDisableCode} onChange={(e) => setMfaDisableCode(e.target.value)} /></label>
            <label className="field"><span className="field-label">Password</span><input className="input" type="password" value={mfaDisablePassword} onChange={(e) => setMfaDisablePassword(e.target.value)} /></label>
            <button className="btn btn-danger" onClick={() => void disableMfa()} disabled={mfaDisableCode.length !== 6 || !mfaDisablePassword}>Disable MFA</button></div>}
        </aside>
      </div>}

      {tab === 'preferences' && <div className="split">
        <section className="card"><h2 className="card-title">Appearance</h2><div className="stack">
          <div className="row-wrap"><button className="btn" aria-pressed={prefs.theme === 'dark'} onClick={() => prefs.setTheme('dark')}><Icon name="moon" size={16} /> Dark</button>
            <button className="btn" aria-pressed={prefs.theme === 'light'} onClick={() => prefs.setTheme('light')}><Icon name="sun" size={16} /> Light</button></div>
          <label className="field"><span className="field-label">Board theme</span><select className="select" value={prefs.boardTheme} onChange={(e) => prefs.set('boardTheme', e.target.value as typeof prefs.boardTheme)}>{BOARD_THEMES.map((theme) => <option key={theme.id} value={theme.id}>{theme.label}</option>)}</select></label>
          <label className="field"><span className="field-label">Piece theme</span><select className="select" value={prefs.pieceTheme} onChange={(e) => prefs.set('pieceTheme', e.target.value as typeof prefs.pieceTheme)}>{PIECE_THEMES.map((theme) => <option key={theme.id} value={theme.id}>{theme.label}</option>)}</select></label>
          <Link className="btn btn-sm" to="/boards"><Icon name="board" size={16} /> Open the board studio — see every board and piece set</Link>

        </div></section>
        <aside className="card"><h2 className="card-title">Board behaviour</h2><div className="stack" style={{ gap: '.7rem' }}>
          <label className="checkbox"><input type="checkbox" checked={prefs.showCoordinates} onChange={(e) => prefs.set('showCoordinates', e.target.checked)} /> Show coordinates</label>
          <label className="checkbox"><input type="checkbox" checked={prefs.showLegalMoves} onChange={(e) => prefs.set('showLegalMoves', e.target.checked)} /> Highlight legal moves</label>
          <label className="checkbox"><input type="checkbox" checked={prefs.animations && !prefs.reducedMotion} disabled={prefs.reducedMotion} onChange={(e) => prefs.set('animations', e.target.checked)} /> Piece animations {prefs.reducedMotion && <span className="tiny muted">(disabled by reduced motion)</span>}</label>
          <label className="checkbox"><input type="checkbox" checked={prefs.sound} onChange={(e) => prefs.set('sound', e.target.checked)} /> Move sound preference (stored only)</label>
          <p className="tiny muted" style={{ marginBottom: 0 }}>Preferences are stored locally in this browser. The server remains authoritative for game state.</p>
        </div></aside>
      </div>}

      {tab === 'international' && <div className="split" id="international">
        <section className="card">
          <div className="card-header"><h2 className="card-title">Country, timezone &amp; currency</h2><span className="pill">Voluntary</span></div>
          <div className="stack">
            <label className="field"><span className="field-label">Country of residence</span>
              <select className="select" value={international.country} onChange={(e) => setInternational((v) => ({ ...v, country: e.target.value, countryShared: e.target.value === 'ZZ' ? false : v.countryShared }))}>
                {countryOptions().map((option) => <option key={option.code} value={option.code}>{option.flag} {option.label}</option>)}
              </select>
              <span className="field-hint">This is never used alone to approve real-money play.</span></label>
            <label className="checkbox"><input type="checkbox" checked={international.countryShared} disabled={international.country === 'ZZ'} onChange={(e) => setInternational((v) => ({ ...v, countryShared: e.target.checked }))} /> Show my country flag publicly</label>
            <label className="field"><span className="field-label">IANA timezone</span>
              <input className="input" value={international.timezone} onChange={(e) => setInternational((v) => ({ ...v, timezone: e.target.value }))} placeholder={browserTimeZone()} />
              <span className="field-hint">Current local time: {formatLocalDateTime(new Date(), international.timezone)}</span></label>
            <label className="checkbox"><input type="checkbox" checked={international.timezoneShared} onChange={(e) => setInternational((v) => ({ ...v, timezoneShared: e.target.checked }))} /> Share my timezone with opponents</label>
            <label className="field"><span className="field-label">Account currency</span>
              <select className="select" value={international.accountCurrency} onChange={(e) => setInternational((v) => ({ ...v, accountCurrency: e.target.value }))}>
                <option value="USD">USD — US dollar</option>
              </select>
              <span className="field-hint">Display preference only. The financial ledger is denominated in USD cents; no silent conversion occurs.</span></label>
            <button className="btn btn-primary" onClick={() => void saveInternational()} disabled={busy}>Save international preferences</button>
          </div>
        </section>
        <aside className="card">
          <h2 className="card-title">Eligibility status</h2>
          {eligibility.isLoading && <span className="loading" />}
          {eligibility.data && <div className="stack">
            <div className={`alert ${eligibility.data.freePlay.allowed ? 'alert-success' : 'alert-danger'}`}><strong>Free play:</strong> {eligibility.data.freePlay.allowed ? 'available internationally' : eligibility.data.freePlay.reason}</div>
            <div className={`alert ${eligibility.data.moneyMatches.allowed ? 'alert-success' : 'alert-warning'}`}><strong>Money matches:</strong> {eligibility.data.moneyMatches.allowed ? 'eligible when platform mode is authorised' : 'restricted'}</div>
            <div className="small soft">Policy: {eligibility.data.policy.label} ({eligibility.data.policyCode})</div>
            <div className="small soft">Verified jurisdiction: {eligibility.data.verifiedEligibilityJurisdiction ?? 'not verified'}</div>
            <div className="small soft">Permitted types: {eligibility.data.moneyMatches.permittedTypes.join(', ') || 'none'}</div>
            <div className="small soft">Approved providers: {eligibility.data.moneyMatches.allowedProviders.join(', ') || 'none'}</div>
            {!eligibility.data.moneyMatches.allowed && <ul className="tiny muted">{eligibility.data.moneyMatches.blockers.slice(0, 6).map((b) => <li key={b}>{b}</li>)}</ul>}
          </div>}
        </aside>
      </div>}

      {tab === 'responsible' && <div className="split" id="responsible">
        <div className="stack">
          <section className="card"><div className="card-header"><h2 className="card-title">Server-enforced limits</h2></div>
            <div className="grid-2">
              <label className="field"><span className="field-label">Daily deposit limit (USD)</span><input className="input" type="number" min="0" step="1" value={limits.deposit} onChange={(e) => setLimits((l) => ({ ...l, deposit: e.target.value }))} placeholder="No limit" /></label>
              <label className="field"><span className="field-label">Daily stake limit (USD)</span><input className="input" type="number" min="0" step="1" value={limits.stake} onChange={(e) => setLimits((l) => ({ ...l, stake: e.target.value }))} placeholder="No limit" /></label>
            </div>
            <button className="btn btn-primary" style={{ marginTop: '.75rem' }} onClick={() => void saveLimits()} disabled={busy}>Save limits</button>
            <p className="tiny muted" style={{ marginBottom: 0, marginTop: '.6rem' }}>Leave a field empty to remove that limit. Lowering a limit is immediate; increasing one should be reviewed after a cooling-off period in a licensed deployment.</p>
          </section>
          <section className="card"><div className="card-header"><h2 className="card-title">Active restrictions</h2></div>
            {restrictions.data?.items.length === 0 && <p className="small muted">No active restrictions.</p>}
            {restrictions.data?.items.map((item) => <div className="alert" key={String(item.id)}>
              <strong>{String(item.type).replaceAll('_', ' ')}</strong><div className="tiny muted">Value: {item.value_cents === null ? 'n/a' : `$${(Number(item.value_cents) / 100).toFixed(2)}`} · Expires: {item.expires_at ? new Date(String(item.expires_at)).toLocaleDateString() : 'no expiry'}</div>
            </div>)}
          </section>
        </div>
        <aside className="card"><h2 className="card-title">Self-exclusion</h2>
          <p className="small soft">Activating self-exclusion suspends your account, revokes all sessions and blocks competitions for a 180-day cooling-off period. This action is not reversible from the browser.</p>
          <label className="field"><span className="field-label">Reason (private, audited)</span><textarea className="textarea" value={excludeReason} onChange={(e) => setExcludeReason(e.target.value)} minLength={8} /></label>
          <button className="btn btn-danger btn-block" style={{ marginTop: '.75rem' }} onClick={() => setConfirmExclude(true)} disabled={excludeReason.trim().length < 8}>Activate self-exclusion</button>
        </aside>
      </div>}

      {tab === 'compliance' && <div className="split">
        <section className="card"><h2 className="card-title">Platform compliance status</h2>
          <div className="stack" style={{ gap: '.6rem' }}>
            <div className={`alert ${status.data?.realMoneyEnabled ? 'alert-danger' : 'alert-success'}`}><strong>{status.data?.realMoneyEnabled ? 'Authorised real-money mode' : 'Real money disabled'}</strong><div className="small">{status.data?.legalNotice}</div></div>
            <div className="stat-grid"><div className="stat"><div className="stat-label">Mode</div><div className="stat-value" style={{ fontSize: '1.2rem' }}>{status.data?.mode ?? '—'}</div></div>
              <div className="stat"><div className="stat-label">Fee</div><div className="stat-value" style={{ fontSize: '1.2rem' }}>{status.data ? `${status.data.feeBps / 100}%` : '—'}</div></div>
              <div className="stat"><div className="stat-label">Engine</div><div className="stat-value" style={{ fontSize: '1.2rem' }}>{status.data?.engine.available ? 'Available' : 'Unavailable'}</div></div></div>
            {!!status.data?.realMoneyBlockers.length && <div className="alert alert-warning"><strong>Activation prerequisites:</strong><ul className="small" style={{ margin: '.4rem 0 0' }}>{status.data.realMoneyBlockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></div>}
          </div>
        </section>
        <ProviderHealthCard compact />
      </div>}

      <ConfirmDialog open={confirmExclude} onClose={() => setConfirmExclude(false)} onConfirm={selfExclude}
        title="Activate self-exclusion?" message="Your account will be suspended and all sessions revoked for 180 days. Contact an administrator after the cooling-off period." confirmLabel="Self-exclude" danger />
    </div>
  );
}
