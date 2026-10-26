import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatMoney, type PlatformStatus, type ProviderHealth, type WalletView } from '@shared/contracts';
import { api, apiUrl, errorMessage } from '../lib/api';
import { useToast } from '../app/ToastProvider';
import { PageHeader, EmptyState, ErrorState } from '../components/PageHeader';
import { ProviderHealthCard } from '../components/Competition';
import { Modal } from '../components/Modal';
import { Icon } from '../components/Icon';

interface LedgerRow { id: string; reference: string; type: string; description: string; status: string; created_at: string; amount_cents: number; metadata?: Record<string, unknown> }
interface PaymentOperation { id: string; provider: string; provider_reference: string | null; amount_cents: number; status: string; sandbox: boolean; instructions?: string; redirectUrl?: string | null; createdAt?: string; initiated_at?: string; requested_at?: string; kind?: 'deposits' | 'withdrawals' }

export function WalletPage() {
  const [params] = useSearchParams();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState({ type: '', status: '', from: '', to: '', min: '', max: '' });
  const [deposit, setDeposit] = useState({ provider: 'paynow', amount: '100', phone: '' });
  const [withdrawal, setWithdrawal] = useState({ provider: 'ecocash', amount: '100', destination: '' });
  const [testAmount, setTestAmount] = useState('500');
  const [busy, setBusy] = useState(false);
  const [activeOperation, setActiveOperation] = useState<PaymentOperation | null>(null);
  const [receipt, setReceipt] = useState<{ transaction: LedgerRow; entries: Array<{ line_no: number; amount_cents: number; owner_type: string; purpose: string }> } | null>(null);

  const status = useQuery({ queryKey: ['platform-status'], queryFn: () => api<PlatformStatus>('/status'), staleTime: 60_000 });
  const wallet = useQuery({ queryKey: ['wallet'], queryFn: () => api<WalletView>('/wallet'), refetchInterval: 30_000 });
  const providers = useQuery({ queryKey: ['provider-health'], queryFn: () => api<{ providers: ProviderHealth[] }>('/payments/providers'), staleTime: 60_000 });
  const query = useMemo(() => {
    const p = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value) {
      if (key === 'min') p.set('minCents', String(Math.round(Number(value) * 100)));
      else if (key === 'max') p.set('maxCents', String(Math.round(Number(value) * 100)));
      else p.set(key, value);
    }
    return p.toString();
  }, [filters]);
  const transactions = useQuery({ queryKey: ['wallet-transactions', query], queryFn: () => api<{ items: LedgerRow[] }>(`/wallet/transactions?${query}`) });
  const deposits = useQuery({ queryKey: ['wallet-deposits'], queryFn: () => api<{ items: PaymentOperation[] }>('/wallet/deposits') });
  const withdrawals = useQuery({ queryKey: ['wallet-withdrawals'], queryFn: () => api<{ items: PaymentOperation[] }>('/wallet/withdrawals') });
  const configuredProviders = providers.data?.providers.filter((p) => p.configured) ?? [];

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['wallet'] });
    void queryClient.invalidateQueries({ queryKey: ['wallet-transactions'] });
    void queryClient.invalidateQueries({ queryKey: ['wallet-deposits'] });
    void queryClient.invalidateQueries({ queryKey: ['wallet-withdrawals'] });
  };

  const startDeposit = async () => {
    setBusy(true);
    try {
      const result = await api<PaymentOperation>('/wallet/deposit', { method: 'POST', body: {
        provider: deposit.provider, amountCents: Math.round(Number(deposit.amount) * 100), phone: deposit.phone || undefined,
        returnUrl: `${window.location.origin}/wallet?payment=return`,
      } });
      setActiveOperation({ ...result, kind: 'deposits' });
      toast.info('Payment initiated', 'Your balance changes only after the provider confirms the payment to the server.');
      invalidate();
    } catch (error) { toast.error('Deposit could not start', errorMessage(error)); }
    finally { setBusy(false); }
  };

  const startWithdrawal = async () => {
    setBusy(true);
    try {
      const result = await api<PaymentOperation>('/wallet/withdraw', { method: 'POST', body: {
        provider: withdrawal.provider, amountCents: Math.round(Number(withdrawal.amount) * 100), destination: withdrawal.destination,
      } });
      setActiveOperation({ ...result, kind: 'withdrawals' });
      toast.info('Withdrawal submitted', 'Funds remain reserved until the provider confirms completion.');
      invalidate();
    } catch (error) { toast.error('Withdrawal could not start', errorMessage(error)); }
    finally { setBusy(false); }
  };

  const grantTestCredits = async () => {
    setBusy(true);
    try {
      await api('/wallet/test-credits', { method: 'POST', body: { amountCents: Number(testAmount) } });
      toast.success('Test credits added', 'These credits have no cash value and cannot be withdrawn.');
      invalidate();
    } catch (error) { toast.error('Could not add test credits', errorMessage(error)); }
    finally { setBusy(false); }
  };

  const confirmOperation = async (kind: 'deposits' | 'withdrawals', id: string) => {
    try {
      const result = await api<{ status: string; reason?: string }>(`/wallet/${kind}/${id}/confirm`, { method: 'POST', body: {} });
      toast.info(`Provider status: ${result.status}`, result.reason ?? 'The authoritative provider lookup has been completed.');
      invalidate();
    } catch (error) { toast.error('Verification failed', errorMessage(error)); }
  };

  const openReceipt = async (id: string) => {
    try { setReceipt(await api<typeof receipt>(`/wallet/receipt/${id}`)); }
    catch (error) { toast.error('Receipt unavailable', errorMessage(error)); }
  };

  return (
    <div className="container">
      <PageHeader eyebrow="Wallet" title="Your balance &amp; transactions" description="All balances, reservations and transaction rows come from the authoritative double-entry ledger. Pending provider operations are never treated as completed payments."
        actions={<a className="btn btn-sm" href={apiUrl(`/wallet/statement.csv?${query}`)}><Icon name="download" size={15} /> Download CSV</a>} />

      {params.get('payment') === 'return' && <div className="alert alert-warning" style={{ marginBottom: '1rem' }}><strong>Browser return is not proof of payment.</strong> Only a server-to-server provider status check can confirm or credit a deposit. Use “Verify status” on the pending operation.</div>}
      {!status.data?.realMoneyEnabled && <div className="alert" style={{ marginBottom: '1rem' }}><strong>Real money is disabled.</strong> {status.data?.realMoneyBlockers.join(' ') || 'Waiting for platform status.'} Free chess remains independently usable.</div>}

      <div className="grid-4" style={{ marginBottom: '1.5rem' }}>
        <div className="card"><div className="stat-label">Available</div><div className="stat-value">{formatMoney(wallet.data?.availableCents ?? 0)}</div><div className="stat-foot">USD cents, source: ledger</div></div>
        <div className="card"><div className="stat-label">Reserved</div><div className="stat-value">{formatMoney(wallet.data?.reservedCents ?? 0)}</div><div className="stat-foot">Stakes and pending withdrawals</div></div>
        <div className="card"><div className="stat-label">Total</div><div className="stat-value">{formatMoney(wallet.data?.totalCents ?? 0)}</div><div className="stat-foot">Available + reserved</div></div>
        <div className="card"><div className="stat-label">Pending</div><div className="stat-value" style={{ fontSize: '1.25rem' }}>{formatMoney(wallet.data?.pendingDepositsCents ?? 0)} in<br />{formatMoney(wallet.data?.pendingWithdrawalsCents ?? 0)} out</div><div className="stat-foot">Not included in available</div></div>
      </div>

      <div className="split">
        <div className="stack">
          <section className="card">
            <div className="card-header"><h2 className="card-title">Transaction history</h2><span className="pill">{transactions.data?.items.length ?? 0} rows</span></div>
            <div className="filter-bar">
              <select className="select" aria-label="Transaction type" value={filters.type} onChange={(e) => setFilters((f) => ({ ...f, type: e.target.value }))}>
                <option value="">All types</option><option value="deposit_credit">Deposits</option><option value="test_deposit_credit">Sandbox credits</option><option value="test_credit_grant">Test grants</option><option value="stake_reservation">Stake reservations</option><option value="competition_settlement">Settlements</option><option value="settlement_correction">Corrections</option><option value="withdrawal_hold">Withdrawal holds</option><option value="withdrawal_complete">Completed withdrawals</option>
              </select>
              <select className="select" aria-label="Transaction status" value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}>
                <option value="">Any status</option><option value="posted">Posted</option><option value="pending">Pending</option>
              </select>
              <input className="input" type="date" aria-label="From date" value={filters.from} onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} />
              <input className="input" type="date" aria-label="To date" value={filters.to} onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))} />
              <input className="input" type="number" min="0" step="0.01" placeholder="Min $" aria-label="Minimum amount" value={filters.min} onChange={(e) => setFilters((f) => ({ ...f, min: e.target.value }))} />
              <input className="input" type="number" min="0" step="0.01" placeholder="Max $" aria-label="Maximum amount" value={filters.max} onChange={(e) => setFilters((f) => ({ ...f, max: e.target.value }))} />
            </div>
            {transactions.isLoading && <div className="empty-state"><span className="loading" /> Loading ledger transactions…</div>}
            {transactions.error && <ErrorState message={errorMessage(transactions.error)} retry={() => void transactions.refetch()} />}
            {transactions.data?.items.length === 0 && <EmptyState title="No transactions match these filters">Deposits, reservations, settlements and withdrawals appear here only after a posted ledger journal.</EmptyState>}
            {!!transactions.data?.items.length && <div className="table-wrap">
              <table className="table"><thead><tr><th>Date</th><th>Reference</th><th>Type</th><th>Status</th><th className="text-right">Amount</th><th>Receipt</th></tr></thead>
                <tbody>{transactions.data.items.map((row) => <tr key={row.id}>
                  <td>{new Date(row.created_at).toLocaleString()}</td><td className="mono tiny">{String(row.reference).slice(0, 22)}</td>
                  <td>{String(row.type).replaceAll('_', ' ')}</td><td><span className={`pill ${row.status === 'posted' ? 'pill-success' : 'pill-accent'}`}>{row.status}</span></td>
                  <td className={`text-right mono ${Number(row.amount_cents) >= 0 ? 'positive' : 'negative'}`}>{Number(row.amount_cents) >= 0 ? '+' : ''}{formatMoney(Number(row.amount_cents))}</td>
                  <td><button className="btn btn-sm btn-ghost" onClick={() => void openReceipt(row.id)} aria-label={`View receipt ${row.reference}`}><Icon name="copy" size={14} /></button></td>
                </tr>)}</tbody></table>
            </div>}
          </section>

          <section className="card">
            <div className="card-header"><h2 className="card-title">Pending operations</h2></div>
            <div className="grid-2">
              <div>
                <h3>Deposits</h3>
                {deposits.data?.items.length === 0 && <p className="small muted">No deposit attempts yet.</p>}
                {deposits.data?.items.slice(0, 6).map((item) => <div className="alert" key={item.id} style={{ marginBottom: '.5rem' }}>
                  <div className="spread"><strong>{formatMoney(Number(item.amount_cents))}</strong><span className="pill">{item.status}</span></div>
                  <div className="tiny muted">{item.provider} · {item.sandbox ? 'SANDBOX — test credit only' : 'Provider verification required'}</div>
                  {['pending'].includes(item.status) && <button className="btn btn-sm" style={{ marginTop: '.4rem' }} onClick={() => void confirmOperation('deposits', item.id)}>Verify status</button>}
                </div>)}
              </div>
              <div>
                <h3>Withdrawals</h3>
                {withdrawals.data?.items.length === 0 && <p className="small muted">No withdrawal requests yet.</p>}
                {withdrawals.data?.items.slice(0, 6).map((item) => <div className="alert" key={item.id} style={{ marginBottom: '.5rem' }}>
                  <div className="spread"><strong>{formatMoney(Number(item.amount_cents))}</strong><span className="pill">{item.status}</span></div>
                  <div className="tiny muted">{item.provider} · reserved until provider confirmation</div>
                  {['pending', 'processing'].includes(item.status) && <button className="btn btn-sm" style={{ marginTop: '.4rem' }} onClick={() => void confirmOperation('withdrawals', item.id)}>Verify status</button>}
                </div>)}
              </div>
            </div>
          </section>
        </div>

        <div className="sidebar">
          <section className="card">
            <div className="card-header"><h2 className="card-title">Deposit</h2></div>
            <div className="stack">
              <label className="field"><span className="field-label">Provider</span>
                <select className="select" value={deposit.provider} onChange={(e) => setDeposit((d) => ({ ...d, provider: e.target.value }))}>
                  {configuredProviders.length === 0 && <option value="">No configured provider</option>}
                  {configuredProviders.map((p) => <option key={p.id} value={p.id}>{p.name} {p.sandbox ? '(sandbox)' : ''}</option>)}
                </select></label>
              <label className="field"><span className="field-label">Amount (USD)</span><input className="input" type="number" min="0.50" step="0.50" value={deposit.amount} onChange={(e) => setDeposit((d) => ({ ...d, amount: e.target.value }))} /></label>
              <label className="field"><span className="field-label">Mobile number (optional)</span><input className="input" placeholder="263770000000" value={deposit.phone} onChange={(e) => setDeposit((d) => ({ ...d, phone: e.target.value }))} /><span className="field-hint">Never enter a mobile-money PIN here.</span></label>
              <button className="btn btn-primary btn-block" onClick={() => void startDeposit()} disabled={busy || !configuredProviders.length || !status.data?.realMoneyEnabled && status.data?.mode !== 'test'}>
                {busy ? <span className="loading" /> : <Icon name="download" size={16} />} Start deposit
              </button>
              {!status.data?.realMoneyEnabled && status.data?.mode !== 'test' && <div className="tiny muted">Provider deposits are disabled in free-chess mode.</div>}
            </div>
          </section>

          <section className="card">
            <div className="card-header"><h2 className="card-title">Withdraw</h2></div>
            <div className="stack">
              <label className="field"><span className="field-label">Payout provider</span>
                <select className="select" value={withdrawal.provider} onChange={(e) => setWithdrawal((w) => ({ ...w, provider: e.target.value }))}>
                  {configuredProviders.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select></label>
              <label className="field"><span className="field-label">Amount (USD)</span><input className="input" type="number" min="1" step="0.50" value={withdrawal.amount} onChange={(e) => setWithdrawal((w) => ({ ...w, amount: e.target.value }))} /></label>
              <label className="field"><span className="field-label">Destination</span><input className="input" placeholder="263770000000" value={withdrawal.destination} onChange={(e) => setWithdrawal((w) => ({ ...w, destination: e.target.value }))} /></label>
              <button className="btn btn-block" onClick={() => void startWithdrawal()} disabled={busy || !status.data?.realMoneyEnabled}>Request withdrawal</button>
              {!status.data?.realMoneyEnabled && <div className="tiny muted">Withdrawals are disabled unless authorised real-money mode is active. Test credits are never withdrawable.</div>}
            </div>
          </section>

          {status.data?.mode === 'test' && status.data.testFundsEnabled && (
            <section className="card">
              <div className="card-header"><h2 className="card-title">Internal test credits</h2><span className="pill pill-accent">No cash value</span></div>
              <div className="row"><input className="input" type="number" min="50" max="10000" step="50" value={testAmount} onChange={(e) => setTestAmount(e.target.value)} aria-label="Test credit cents" />
                <button className="btn btn-sm" onClick={() => void grantTestCredits()} disabled={busy}>Add cents</button></div>
              <p className="tiny muted" style={{ marginBottom: 0 }}>Amount is in USD cents. Credits are ledger entries explicitly labelled as internal test value.</p>
            </section>
          )}
          <ProviderHealthCard compact />
        </div>
      </div>

      <Modal open={!!activeOperation} onClose={() => setActiveOperation(null)} title="Provider instructions" footer={<button className="btn btn-primary" onClick={() => setActiveOperation(null)}>Done</button>}>
        {activeOperation && <div className="stack">
          <div className="alert alert-warning"><strong>Status: {activeOperation.status}.</strong> A browser redirect or provider message is never proof of payment.</div>
          <p>{activeOperation.instructions ?? 'Follow the provider instructions. The server will verify the final status.'}</p>
          {activeOperation.redirectUrl && <a className="btn btn-primary" href={activeOperation.redirectUrl} target="_blank" rel="noreferrer">Open provider checkout <Icon name="external" size={15} /></a>}
          <div className="tiny muted mono" style={{ overflowWrap: 'anywhere' }}>Reference: {activeOperation.id} · Provider reference: {activeOperation.provider_reference ?? 'pending'}</div>
          <button className="btn btn-sm" onClick={() => void confirmOperation(activeOperation.kind ?? 'deposits', activeOperation.id)}>Verify status now</button>
        </div>}
      </Modal>

      <Modal open={!!receipt} onClose={() => setReceipt(null)} title="Ledger receipt" footer={<button className="btn" onClick={() => setReceipt(null)}>Close</button>}>
        {receipt && <div className="stack">
          <div className="alert"><strong>{receipt.transaction.reference}</strong><div className="small">{receipt.transaction.description}</div></div>
          <table className="table"><thead><tr><th>Line</th><th>Account</th><th>Purpose</th><th className="text-right">Delta</th></tr></thead>
            <tbody>{receipt.entries.map((entry) => <tr key={entry.line_no}><td>{entry.line_no}</td><td>{entry.owner_type}</td><td>{entry.purpose}</td><td className={`text-right mono ${entry.amount_cents >= 0 ? 'positive' : 'negative'}`}>{entry.amount_cents >= 0 ? '+' : ''}{formatMoney(entry.amount_cents)}</td></tr>)}</tbody></table>
          <p className="tiny muted" style={{ marginBottom: 0 }}>Posted entries are immutable. Corrections are separate compensating journals.</p>
        </div>}
      </Modal>
    </div>
  );
}
