import { useCallback, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatMoney } from '@shared/contracts';
import { api, errorMessage, type ApiOptions } from '../lib/api';
import { useAuth } from '../app/AuthProvider';
import { useToast } from '../app/ToastProvider';
import { PageHeader, EmptyState, ErrorState } from '../components/PageHeader';
import { ProviderHealthCard } from '../components/Competition';
import { Icon } from '../components/Icon';

type Tab = 'overview' | 'users' | 'games' | 'disputes' | 'fairplay' | 'ledger' | 'providers' | 'security' | 'responsible' | 'compliance';
const TABS: Tab[] = ['overview', 'users', 'games', 'disputes', 'fairplay', 'ledger', 'providers', 'security', 'responsible', 'compliance'];

export function AdminPage() {
  const { mfaEnabled } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>('overview');
  const [mfaCode, setMfaCode] = useState('');
  const mfaRef = useRef(mfaCode);
  mfaRef.current = mfaCode;
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [gameId, setGameId] = useState('');
  const [inspection, setInspection] = useState<Record<string, unknown> | null>(null);
  const [decision, setDecision] = useState('reject');
  const [reviewDecision, setReviewDecision] = useState('no action required');
  const [restriction, setRestriction] = useState({ userId: '', type: 'daily_deposit_limit', value: '100', expiresAt: '' });
  const [commission, setCommission] = useState('500');

  const production = import.meta.env.PROD;
  const mfaReady = mfaEnabled ? mfaCode.length === 6 : !production;
  const adminApi = useCallback(async <T,>(path: string, options: ApiOptions = {}): Promise<T> => {
    const headers = new Headers(options.headers);
    if (mfaRef.current) headers.set('X-MFA-Code', mfaRef.current);
    return api<T>(path, { ...options, headers });
  }, []);
  const invalidateAll = () => { void queryClient.invalidateQueries({ queryKey: ['admin'] }); };

  const action = useCallback(async (path: string, body: Record<string, unknown> = {}) => {
    if (!mfaReady) { toast.error('MFA code required', 'Enter the six-digit administrator code before privileged actions.'); return; }
    if (!confirmed || reason.trim().length < 8) { toast.error('Confirmation required', 'Tick the confirmation box and provide a documented reason of at least 8 characters.'); return; }
    setBusy(true);
    try {
      const result = await adminApi<Record<string, unknown>>(path, {
        method: 'POST',
        body: { ...body, confirm: true, reason: String((body as any).reason || reason) },
      });
      toast.success('Action completed', String(result.outcome ?? 'The server recorded the audited action.'));
      invalidateAll();
      return result;
    } catch (error) { toast.error('Action rejected', errorMessage(error)); }
    finally { setBusy(false); }
  }, [adminApi, confirmed, reason, mfaReady, toast]);

  const overview = useQuery({ queryKey: ['admin', 'overview', mfaReady], queryFn: () => adminApi<Record<string, any>>('/admin/overview'), enabled: mfaReady });
  const system = useQuery({ queryKey: ['admin', 'system', mfaReady], queryFn: () => adminApi<Record<string, any>>('/admin/system-health'), enabled: mfaReady && tab === 'overview' });
  const users = useQuery({ queryKey: ['admin', 'users', search, mfaReady], queryFn: () => adminApi<{ items: Array<Record<string, any>> }>(`/admin/users?search=${encodeURIComponent(search)}`), enabled: mfaReady && tab === 'users' });
  const games = useQuery({ queryKey: ['admin', 'games', mfaReady], queryFn: () => adminApi<{ items: Array<Record<string, any>> }>('/admin/games'), enabled: mfaReady && (tab === 'games' || tab === 'fairplay') });
  const disputes = useQuery({ queryKey: ['admin', 'disputes', mfaReady], queryFn: () => adminApi<{ items: Array<Record<string, any>> }>('/admin/disputes'), enabled: mfaReady && tab === 'disputes' });
  const reviews = useQuery({ queryKey: ['admin', 'reviews', mfaReady], queryFn: () => adminApi<{ items: Array<Record<string, any>> }>('/admin/reviews'), enabled: mfaReady && tab === 'fairplay' });
  const ledger = useQuery({ queryKey: ['admin', 'ledger', mfaReady], queryFn: () => adminApi<{ items: Array<Record<string, any>> }>('/admin/ledger?limit=200'), enabled: mfaReady && tab === 'ledger' });
  const reconciliation = useQuery({ queryKey: ['admin', 'reconciliation', mfaReady], queryFn: () => adminApi<Record<string, any>>('/admin/reconciliation'), enabled: mfaReady && tab === 'ledger' });
  const commissionReport = useQuery({ queryKey: ['admin', 'commission', mfaReady], queryFn: () => adminApi<Record<string, any>>('/admin/commission'), enabled: mfaReady && tab === 'ledger' });
  const settlements = useQuery({ queryKey: ['admin', 'settlements', mfaReady], queryFn: () => adminApi<{ items: Array<Record<string, any>> }>('/admin/settlements'), enabled: mfaReady && tab === 'ledger' });
  const deposits = useQuery({ queryKey: ['admin', 'deposits', mfaReady], queryFn: () => adminApi<{ items: Array<Record<string, any>> }>('/admin/deposits'), enabled: mfaReady && tab === 'providers' });
  const withdrawals = useQuery({ queryKey: ['admin', 'withdrawals', mfaReady], queryFn: () => adminApi<{ items: Array<Record<string, any>> }>('/admin/withdrawals'), enabled: mfaReady && tab === 'providers' });
  const providerEvents = useQuery({ queryKey: ['admin', 'provider-events', mfaReady], queryFn: () => adminApi<{ items: Array<Record<string, any>> }>('/admin/provider-events'), enabled: mfaReady && tab === 'providers' });
  const securityEvents = useQuery({ queryKey: ['admin', 'security-events', mfaReady], queryFn: () => adminApi<{ items: Array<Record<string, any>> }>('/admin/security-events'), enabled: mfaReady && tab === 'security' });
  const auditLogs = useQuery({ queryKey: ['admin', 'audit-logs', mfaReady], queryFn: () => adminApi<{ items: Array<Record<string, any>> }>('/admin/audit-logs'), enabled: mfaReady && tab === 'security' });
  const adminActions = useQuery({ queryKey: ['admin', 'actions', mfaReady], queryFn: () => adminApi<{ items: Array<Record<string, any>> }>('/admin/actions'), enabled: mfaReady && tab === 'security' });
  const restrictions = useQuery({ queryKey: ['admin', 'restrictions', mfaReady], queryFn: () => adminApi<{ items: Array<Record<string, any>> }>('/admin/responsible-play'), enabled: mfaReady && tab === 'responsible' });
  const compliance = useQuery({ queryKey: ['admin', 'compliance', mfaReady], queryFn: () => adminApi<Record<string, any>>('/admin/compliance'), enabled: mfaReady && tab === 'compliance' });
  const config = useQuery({ queryKey: ['admin', 'config', mfaReady], queryFn: () => adminApi<{ items: Array<Record<string, any>> }>('/admin/config'), enabled: mfaReady && tab === 'compliance' });
  const jurisdictions = useQuery({ queryKey: ['admin', 'jurisdictions', mfaReady], queryFn: () => adminApi<{ items: Array<Record<string, any>> }>('/admin/jurisdictions'), enabled: mfaReady && tab === 'compliance' });
  const exchangeRates = useQuery({ queryKey: ['admin', 'rates', mfaReady], queryFn: () => adminApi<{ items: Array<Record<string, any>> }>('/admin/currencies/rates'), enabled: mfaReady && tab === 'compliance' });
  const [policy, setPolicy] = useState({ code: 'ZW', label: 'Zimbabwe', freePlayAllowed: true, realMoneyAllowed: false, types: 'free', providers: '', reason: '' });
  const [rate, setRate] = useState({ fromCurrency: 'USD', toCurrency: 'EUR', rate: '0.92', effectiveAt: new Date().toISOString(), source: 'ECB reference', evidenceRef: '' });

  const inspect = async (id: string) => {
    if (!mfaReady) { toast.error('MFA code required'); return; }
    try { setInspection(await adminApi<Record<string, unknown>>(`/admin/games/${id}`)); }
    catch (error) { toast.error('Could not inspect game', errorMessage(error)); }
  };

  return (
    <div className="container">
      <PageHeader eyebrow="Operations" title="Admin dashboard" description="RBAC-protected operations with MFA, explicit confirmation, documented reasons and immutable audit logs. No action silently edits a posted ledger entry."
        actions={<Link className="btn btn-sm" to="/settings#security"><Icon name="lock" size={15} /> MFA settings</Link>} />

      <section className="card" style={{ marginBottom: '1rem' }}>
        <div className="row-wrap">
          {mfaEnabled ? <label className="field" style={{ minWidth: 170 }}><span className="field-label">MFA code (required)</span><input className="input mono" inputMode="numeric" maxLength={6} value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} placeholder="123456" /></label>
            : <div className="alert alert-warning" style={{ flex: 1 }}><strong>MFA not enabled.</strong> {production ? 'Production administrator controls are blocked. Enable MFA in Settings.' : 'Development mode permits controls without MFA; enable it before production.'}</div>}
          <label className="field grow" style={{ minWidth: 220 }}><span className="field-label">Documented reason for high-impact actions</span><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this action necessary?" /></label>
          <label className="checkbox" style={{ marginTop: '1.2rem' }}><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> I confirm this action</label>
        </div>
        {!mfaReady && <div className="alert alert-danger" style={{ marginTop: '.75rem' }}><strong>Privileged data is locked.</strong> Enter a valid six-digit MFA code or enable MFA outside development.</div>}
      </section>

      <div className="tabs" role="tablist" aria-label="Admin sections">{TABS.map((value) => <button key={value} className={`tab ${tab === value ? 'active' : ''}`} role="tab" aria-selected={tab === value} onClick={() => setTab(value)}>{value}</button>)}</div>

      {!mfaReady && <EmptyState title="Administrator data locked">Enter the required MFA code. No privileged data is displayed until authentication succeeds.</EmptyState>}
      {mfaReady && tab === 'overview' && <div className="stack">
        {overview.isLoading && <div className="card"><span className="loading" /> Loading authoritative counts…</div>}
        {overview.error && <ErrorState message={errorMessage(overview.error)} retry={() => void overview.refetch()} />}
        {overview.data && <div className="stat-grid">
          {['users', 'activeGames', 'finishedGames', 'openDisputes', 'pendingSettlements', 'postedSettlements', 'pendingDeposits', 'pendingWithdrawals', 'openChallenges'].map((key) => <div className="card" key={key}><div className="stat-label">{key.replace(/([A-Z])/g, ' $1')}</div><div className="stat-value">{Number(overview.data[key] ?? 0)}</div></div>)}
        </div>}
        <div className="grid-2">
          <section className="card"><h2 className="card-title">Ledger reconciliation</h2><pre className="mono small" style={{ overflowX: 'auto' }}>{JSON.stringify(overview.data?.reconciliation ?? {}, null, 2)}</pre></section>
          <section className="card"><h2 className="card-title">System health</h2><pre className="mono small" style={{ overflowX: 'auto' }}>{JSON.stringify(system.data ?? {}, null, 2)}</pre></section>
        </div>
        <ProviderHealthCard compact />
      </div>}

      {mfaReady && tab === 'users' && <section className="card">
        <div className="filter-bar"><input className="input" placeholder="Search username or email" aria-label="Search users" value={search} onChange={(e) => setSearch(e.target.value)} /><span className="small muted">{users.data?.items.length ?? 0} accounts</span></div>
        {users.error && <ErrorState message={errorMessage(users.error)} retry={() => void users.refetch()} />}
        <div className="table-wrap"><table className="table"><thead><tr><th>User</th><th>Role</th><th>Status</th><th>Rating</th><th>Record</th><th>Verified</th><th>Action</th></tr></thead>
          <tbody>{users.data?.items.map((row) => <tr key={String(row.id)}><td><strong>{String(row.username)}</strong><div className="tiny muted">{String(row.email)}</div></td>
            <td>{String(row.role)}</td><td><span className={`pill ${row.status === 'active' ? 'pill-success' : 'pill-danger'}`}>{String(row.status)}</span></td><td>{Number(row.rating)}</td>
            <td>{Number(row.wins)}/{Number(row.losses)}/{Number(row.draws)}</td><td>{row.email_verified ? 'email' : '—'} · {row.age_verified ? '18+' : '—'}</td>
            <td><button className="btn btn-sm" disabled={busy} onClick={() => void action(`/admin/users/${String(row.id)}/status`, { status: row.status === 'active' ? 'suspended' : 'active' })}>{row.status === 'active' ? 'Suspend' : 'Activate'}</button></td></tr>)}</tbody></table></div>
      </section>}

      {mfaReady && (tab === 'games' || tab === 'fairplay') && <div className="stack">
        <section className="card"><div className="card-header"><h2 className="card-title">Games</h2>
          <div className="row"><input className="input" placeholder="Game UUID to inspect" value={gameId} onChange={(e) => setGameId(e.target.value)} /><button className="btn btn-sm" onClick={() => void inspect(gameId)} disabled={!gameId}>Inspect</button></div></div>
          {games.error && <ErrorState message={errorMessage(games.error)} retry={() => void games.refetch()} />}
          <div className="table-wrap"><table className="table"><thead><tr><th>ID</th><th>Players</th><th>Status</th><th>Result</th><th>Settlement</th><th>Fee</th><th>Inspect</th></tr></thead>
            <tbody>{games.data?.items.map((row) => <tr key={String(row.id)}><td className="mono tiny">{String(row.id).slice(0, 8)}</td><td>{String(row.white)} vs {String(row.black)}</td><td>{String(row.status)}</td><td>{String(row.result ?? '—')}</td><td>{String(row.settlement_status ?? 'none')}</td><td>{row.fee_cents ? formatMoney(Number(row.fee_cents)) : '—'}</td><td><button className="btn btn-sm" onClick={() => void inspect(String(row.id))}>Inspect</button></td></tr>)}</tbody></table></div>
        </section>
        {inspection && <section className="card"><div className="card-header"><h2 className="card-title">Game inspection</h2><button className="btn btn-sm" onClick={() => setInspection(null)}>Close</button></div><pre className="mono small" style={{ overflowX: 'auto', maxHeight: 420 }}>{JSON.stringify(inspection, null, 2)}</pre></section>}
        {tab === 'fairplay' && <section className="card"><div className="card-header"><h2 className="card-title">Match reviews</h2><button className="btn btn-sm btn-primary" disabled={busy || !gameId} onClick={() => void action(`/admin/fair-play/${gameId}/review`)}>Run engine-similarity review</button></div>
          <p className="small muted">A review signal is advisory only. No automatic ban, confiscation or rating penalty is applied.</p>
          {reviews.data?.items.length === 0 && <EmptyState title="No match reviews">Run a review on a persisted game to generate an audited human-review item.</EmptyState>}
          <div className="stack">{reviews.data?.items.map((row) => <div className="alert" key={String(row.id)}><div className="spread"><strong>{String(row.reason)}</strong><span className="pill">{String(row.status)}</span></div>
            <div className="small">Game {String(row.game_id).slice(0, 8)} · decision: {String(row.decision ?? 'pending')}</div>
            {row.status !== 'closed' && <div className="row-wrap" style={{ marginTop: '.5rem' }}><input className="input" placeholder="Decision" value={reviewDecision} onChange={(e) => setReviewDecision(e.target.value)} /><button className="btn btn-sm" disabled={busy} onClick={() => void action(`/admin/reviews/${String(row.id)}/close`, { decision: reviewDecision, notes: reason })}>Close review</button></div>}
          </div>)}</div></section>}
      </div>}

      {mfaReady && tab === 'disputes' && <section className="card"><div className="card-header"><h2 className="card-title">Disputes</h2><span className="pill">Human review required</span></div>
        {disputes.error && <ErrorState message={errorMessage(disputes.error)} retry={() => void disputes.refetch()} />}
        {disputes.data?.items.length === 0 && <EmptyState title="No disputes">No player has opened a dispute.</EmptyState>}
        <div className="stack">{disputes.data?.items.map((row) => <div className="alert" key={String(row.id)}>
          <div className="spread"><strong>{String(row.reason)}</strong><span className="pill">{String(row.status)}</span></div>
          <div className="small">{String(row.detail || 'No additional detail')} · game {String(row.game_id).slice(0, 8)} · settlement {String(row.settlement_status ?? 'none')}</div>
          {['open', 'under_review'].includes(String(row.status)) && <div className="row-wrap" style={{ marginTop: '.6rem' }}>
            <select className="select" value={decision} onChange={(e) => setDecision(e.target.value)} aria-label="Dispute decision"><option value="reject">Reject — settle authoritative result</option><option value="void">Void — refund / audited correction</option><option value="review">Keep under review</option></select>
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void action(`/admin/disputes/${String(row.id)}/resolve`, { decision, notes: reason })}>Resolve dispute</button>
          </div>}
        </div>)}</div>
      </section>}

      {mfaReady && tab === 'ledger' && <div className="stack">
        <div className="grid-3">
          <section className="card"><h2 className="card-title">Commission</h2><pre className="mono small">{JSON.stringify(commissionReport.data ?? {}, null, 2)}</pre></section>
          <section className="card"><h2 className="card-title">Reconciliation</h2><pre className="mono small">{JSON.stringify(reconciliation.data ?? {}, null, 2)}</pre>
            <button className="btn btn-sm" disabled={busy} onClick={() => void action('/admin/settlements/reconcile')}>Reconcile pending settlements</button></section>
          <section className="card"><h2 className="card-title">Settlements</h2><div className="small">{settlements.data?.items.length ?? 0} records</div></section>
        </div>
        <section className="card"><div className="card-header"><h2 className="card-title">Immutable ledger journal</h2><span className="pill">{ledger.data?.items.length ?? 0} lines</span></div>
          <div className="table-wrap" style={{ maxHeight: 500, overflowY: 'auto' }}><table className="table"><thead><tr><th>Date</th><th>Type</th><th>Reference</th><th>Account</th><th>Purpose</th><th className="text-right">Delta</th></tr></thead>
            <tbody>{ledger.data?.items.map((row, index) => <tr key={`${String(row.id)}-${index}`}><td>{new Date(String(row.created_at)).toLocaleString()}</td><td>{String(row.type)}</td><td className="mono tiny">{String(row.reference)}</td><td>{String(row.owner_type)}</td><td>{String(row.purpose)}</td><td className={`text-right mono ${Number(row.amount_cents) >= 0 ? 'positive' : 'negative'}`}>{Number(row.amount_cents) >= 0 ? '+' : ''}{formatMoney(Number(row.amount_cents))}</td></tr>)}</tbody></table></div>
        </section>
      </div>}

      {mfaReady && tab === 'providers' && <div className="split"><div className="stack">
        <section className="card"><h2 className="card-title">Deposits</h2><div className="table-wrap"><table className="table"><thead><tr><th>User</th><th>Provider</th><th>Amount</th><th>Status</th><th>Sandbox</th><th>Reference</th></tr></thead><tbody>{deposits.data?.items.map((row) => <tr key={String(row.id)}><td>{String(row.username)}</td><td>{String(row.provider)}</td><td>{formatMoney(Number(row.amount_cents))}</td><td>{String(row.status)}</td><td>{row.sandbox ? 'yes' : 'no'}</td><td className="mono tiny">{String(row.provider_reference ?? '—')}</td></tr>)}</tbody></table></div></section>
        <section className="card"><h2 className="card-title">Withdrawals</h2><div className="table-wrap"><table className="table"><thead><tr><th>User</th><th>Provider</th><th>Amount</th><th>Status</th><th>Destination</th></tr></thead><tbody>{withdrawals.data?.items.map((row) => <tr key={String(row.id)}><td>{String(row.username)}</td><td>{String(row.provider)}</td><td>{formatMoney(Number(row.amount_cents))}</td><td>{String(row.status)}</td><td>{String(row.destination)}</td></tr>)}</tbody></table></div></section>
        <section className="card"><h2 className="card-title">Provider events</h2><div className="table-wrap" style={{ maxHeight: 300, overflowY: 'auto' }}><table className="table"><thead><tr><th>Received</th><th>Provider</th><th>Signature</th><th>Event</th><th>Processed</th></tr></thead><tbody>{providerEvents.data?.items.map((row) => <tr key={String(row.id)}><td>{new Date(String(row.received_at)).toLocaleString()}</td><td>{String(row.provider)}</td><td>{row.signature_valid ? 'valid' : 'invalid'}</td><td className="mono tiny">{String(row.event_id).slice(0, 30)}</td><td>{row.processed_at ? 'yes' : 'no'}</td></tr>)}</tbody></table></div></section>
      </div><ProviderHealthCard /></div>}

      {mfaReady && tab === 'security' && <div className="stack">
        <section className="card"><h2 className="card-title">Recent admin actions</h2><div className="table-wrap"><table className="table"><thead><tr><th>Date</th><th>Actor</th><th>Action</th><th>Target</th><th>Reason</th><th>Outcome</th></tr></thead><tbody>{adminActions.data?.items.map((row) => <tr key={String(row.id)}><td>{new Date(String(row.created_at)).toLocaleString()}</td><td className="mono tiny">{String(row.actor_id).slice(0, 8)}</td><td>{String(row.action)}</td><td>{String(row.target_id).slice(0, 12)}</td><td>{String(row.reason)}</td><td>{String(row.outcome)}</td></tr>)}</tbody></table></div></section>
        <div className="grid-2"><section className="card"><h2 className="card-title">Security events</h2><div style={{ maxHeight: 350, overflowY: 'auto' }}><pre className="mono tiny">{JSON.stringify(securityEvents.data?.items ?? [], null, 2)}</pre></div></section>
          <section className="card"><h2 className="card-title">Immutable audit events</h2><div style={{ maxHeight: 350, overflowY: 'auto' }}><pre className="mono tiny">{JSON.stringify(auditLogs.data?.items ?? [], null, 2)}</pre></div></section></div>
      </div>}

      {mfaReady && tab === 'responsible' && <div className="split"><section className="card"><h2 className="card-title">Active restrictions</h2>
        {restrictions.data?.items.length === 0 && <EmptyState title="No restrictions">No responsible-play restriction is active.</EmptyState>}
        <div className="stack">{restrictions.data?.items.map((row) => <div className="alert" key={String(row.id)}><strong>{String(row.username)}</strong> · {String(row.type).replaceAll('_', ' ')}<div className="tiny muted">Value {row.value_cents === null ? 'n/a' : formatMoney(Number(row.value_cents))} · active: {String(row.active)}</div></div>)}</div>
      </section><aside className="card"><h2 className="card-title">Set restriction</h2><div className="stack">
        <label className="field"><span className="field-label">User UUID</span><input className="input mono small" value={restriction.userId} onChange={(e) => setRestriction((r) => ({ ...r, userId: e.target.value }))} /></label>
        <label className="field"><span className="field-label">Type</span><select className="select" value={restriction.type} onChange={(e) => setRestriction((r) => ({ ...r, type: e.target.value }))}><option value="daily_deposit_limit">Daily deposit limit</option><option value="daily_stake_limit">Daily stake limit</option><option value="session_limit">Session limit</option><option value="self_exclusion">Self-exclusion</option></select></label>
        <label className="field"><span className="field-label">Value (USD cents)</span><input className="input" type="number" min="0" value={restriction.value} onChange={(e) => setRestriction((r) => ({ ...r, value: e.target.value }))} /></label>
        <label className="field"><span className="field-label">Expires (optional ISO)</span><input className="input" type="datetime-local" value={restriction.expiresAt} onChange={(e) => setRestriction((r) => ({ ...r, expiresAt: e.target.value }))} /></label>
        <button className="btn btn-primary" disabled={busy} onClick={() => void action('/admin/responsible-play', { userId: restriction.userId, type: restriction.type, valueCents: Number(restriction.value), expiresAt: restriction.expiresAt ? new Date(restriction.expiresAt).toISOString() : null })}>Apply restriction</button>
      </div></aside></div>}

      {mfaReady && tab === 'compliance' && <div className="split"><div className="stack">
        <section className="card"><h2 className="card-title">Compliance status</h2><pre className="mono small" style={{ overflowX: 'auto' }}>{JSON.stringify(compliance.data ?? {}, null, 2)}</pre></section>
        <section className="card"><h2 className="card-title">Jurisdiction policies</h2>
          <p className="small soft">Server-enforced. A client country setting cannot override these rules.</p>
          <div className="table-wrap"><table className="table"><thead><tr><th>Code</th><th>Free</th><th>Money</th><th>Types</th><th>Providers</th><th>Reason</th></tr></thead>
            <tbody>{jurisdictions.data?.items.map((row) => <tr key={String(row.code)}><td><strong>{String(row.code)}</strong><div className="tiny muted">{String(row.label)}</div></td><td>{row.freePlayAllowed ? 'yes' : 'no'}</td><td>{row.realMoneyAllowed ? 'yes' : 'no'}</td><td className="mono tiny">{Array.isArray(row.permittedCompetitionTypes) ? row.permittedCompetitionTypes.join(', ') : String(row.permittedCompetitionTypes)}</td><td className="mono tiny">{Array.isArray(row.allowedProviders) ? row.allowedProviders.join(', ') || 'none' : String(row.allowedProviders)}</td><td className="small">{String(row.reason)}</td></tr>)}</tbody></table></div>
        </section>
        <section className="card"><h2 className="card-title">Currency design</h2>
          <p className="small soft">The ledger is USD-cent based. Other currencies get separate wallet accounts and explicit, non-applied conversion quotes.</p>
          <div className="grid-2">
            <div><h3>Exchange rates</h3>{exchangeRates.data?.items.length === 0 && <p className="small muted">No explicit rate recorded.</p>}
              <div className="stack" style={{ gap: '.35rem' }}>{exchangeRates.data?.items.slice(0, 5).map((row) => <div className="alert" key={String(row.id)} style={{ padding: '.5rem' }}><strong>{String(row.from_currency).trim()}/{String(row.to_currency).trim()} {String(row.rate)}</strong><div className="tiny muted">{String(row.source)} · {new Date(String(row.effective_at)).toISOString()}</div></div>)}</div>
            </div>
            <div><h3>Record a rate</h3><div className="stack" style={{ gap: '.4rem' }}>
              <div className="row"><input className="input" value={rate.fromCurrency} maxLength={3} onChange={(e) => setRate((r) => ({ ...r, fromCurrency: e.target.value.toUpperCase() }))} aria-label="From currency" /><input className="input" value={rate.toCurrency} maxLength={3} onChange={(e) => setRate((r) => ({ ...r, toCurrency: e.target.value.toUpperCase() }))} aria-label="To currency" /></div>
              <input className="input" value={rate.rate} onChange={(e) => setRate((r) => ({ ...r, rate: e.target.value }))} aria-label="Exchange rate" />
              <input className="input" value={rate.source} onChange={(e) => setRate((r) => ({ ...r, source: e.target.value }))} aria-label="Rate source" />
              <button className="btn btn-sm" disabled={busy} onClick={() => void action('/admin/currencies/rates', rate)}>Record explicit rate</button>
            </div></div>
          </div>
        </section>
        <section className="card"><h2 className="card-title">Platform configuration</h2><pre className="mono small">{JSON.stringify(config.data?.items ?? [], null, 2)}</pre></section>
      </div><aside className="card"><h2 className="card-title">Commission setting</h2>
        <p className="small soft">Changing commission affects new quotes only. Games already started retain their locked hashed terms.</p>
        <label className="field"><span className="field-label">Basis points (500 = 5%)</span><input className="input" type="number" min="0" max="2500" value={commission} onChange={(e) => setCommission(e.target.value)} /></label>
        <button className="btn btn-primary btn-block" style={{ marginTop: '.75rem' }} disabled={busy} onClick={() => void action('/admin/config/commission', { bps: Number(commission) })}>Update commission</button>
        <div className="alert alert-warning" style={{ marginTop: '.75rem' }}><strong>Legal review required.</strong> A fee change does not enable real money and does not replace regulatory approval.</div>
        <hr className="divider" />
        <h3 className="card-title">Update jurisdiction policy</h3>
        <div className="stack" style={{ gap: '.4rem' }}>
          <div className="row"><input className="input" value={policy.code} maxLength={2} onChange={(e) => setPolicy((p) => ({ ...p, code: e.target.value.toUpperCase() }))} aria-label="Jurisdiction code" /><input className="input" value={policy.label} onChange={(e) => setPolicy((p) => ({ ...p, label: e.target.value }))} aria-label="Jurisdiction label" /></div>
          <label className="checkbox"><input type="checkbox" checked={policy.freePlayAllowed} onChange={(e) => setPolicy((p) => ({ ...p, freePlayAllowed: e.target.checked }))} /> Free play allowed</label>
          <label className="checkbox"><input type="checkbox" checked={policy.realMoneyAllowed} onChange={(e) => setPolicy((p) => ({ ...p, realMoneyAllowed: e.target.checked }))} /> Real money allowed</label>
          <input className="input" value={policy.types} onChange={(e) => setPolicy((p) => ({ ...p, types: e.target.value }))} aria-label="Permitted competition types" placeholder="free,test,real" />
          <input className="input" value={policy.providers} onChange={(e) => setPolicy((p) => ({ ...p, providers: e.target.value }))} aria-label="Approved providers" placeholder="paynow,ecocash,pesepay" />
          <input className="input" value={policy.reason} onChange={(e) => setPolicy((p) => ({ ...p, reason: e.target.value }))} aria-label="Policy reason" placeholder="Documented reason" />
          <button className="btn btn-sm btn-primary" disabled={busy || !confirmed || reason.trim().length < 8} onClick={() => void action('/admin/jurisdictions', {
            ...policy,
            permittedCompetitionTypes: policy.types.split(',').map((v) => v.trim()).filter(Boolean),
            allowedProviders: policy.providers.split(',').map((v) => v.trim()).filter(Boolean),
            ageVerificationRequired: true, identityVerificationRequired: true,
          })}>Save server policy</button>
        </div>
      </aside></div>}
    </div>
  );
}
