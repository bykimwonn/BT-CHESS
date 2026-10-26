import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatMoney } from '@shared/contracts';
import { api, errorMessage } from '../lib/api';
import { useToast } from '../app/ToastProvider';
import { PageHeader, EmptyState, ErrorState } from '../components/PageHeader';
import { Icon } from '../components/Icon';

interface Agent {
  id: string; username: string; name: string; code: string; status: string; location: string | null;
  cashHeldCents: number; voucherLimitCents: number; dailyDepositLimitCents: number; dailyPayoutLimitCents: number;
  todayDepositCents: number; todayPayoutCents: number; openVouchers: number;
}
interface Voucher {
  id: string; kind: 'deposit' | 'payout'; status: string; amountCents: number; currency: string;
  agentCode: string; playerUsername: string | null; reference: string | null; sandbox: boolean;
  issuedAt: string; expiresAt: string; codeLast4: string;
}

/**
 * Teller console for the cash-agent rail: issue a cash-in code after taking
 * cash, or pay out a cash-out code after checking the player's ID. The console
 * never shows a player's balance history or credentials, only what the teller
 * needs for the counter transaction.
 */
export function AgentPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState({ amount: '10', playerUsername: '', reference: '' });
  const [issued, setIssued] = useState<{ code: string; amountCents: number } | null>(null);
  const [settle, setSettle] = useState({ code: '', reference: '' });

  const dashboard = useQuery({
    queryKey: ['cash-agent'],
    queryFn: () => api<{ agent: Agent; vouchers: Voucher[]; mode: 'free' | 'test' | 'real'; payoutsEnabled: boolean }>('/cash/agent'),
    refetchInterval: 20_000,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['cash-agent'] });
    void queryClient.invalidateQueries({ queryKey: ['wallet'] });
  };

  const issueVoucher = async () => {
    setBusy(true);
    try {
      const result = await api<{ code: string; voucher: Voucher }>('/cash/agent/vouchers', {
        method: 'POST',
        body: {
          amountCents: Math.round(Number(issue.amount) * 100),
          playerUsername: issue.playerUsername.trim() || undefined,
          reference: issue.reference.trim() || undefined,
        },
      });
      setIssued({ code: result.code, amountCents: result.voucher.amountCents });
      setIssue((value) => ({ ...value, reference: '' }));
      toast.success('Cash-in code issued', 'Hand the printed code to the player only after the cash is in the till.');
      refresh();
    } catch (error) { toast.error('Could not issue a voucher', errorMessage(error)); }
    finally { setBusy(false); }
  };

  const settlePayout = async () => {
    setBusy(true);
    try {
      const result = await api<Voucher>('/cash/agent/payouts/settle', {
        method: 'POST',
        body: { code: settle.code, reference: settle.reference.trim() || undefined },
      });
      toast.success('Cash paid out', `${formatMoney(result.amountCents)} paid to ${result.playerUsername ?? 'the player'}. Keep the receipt.`);
      setSettle({ code: '', reference: '' });
      refresh();
    } catch (error) { toast.error('Payout not completed', errorMessage(error)); }
    finally { setBusy(false); }
  };

  const cancelVoucher = async (id: string) => {
    const reason = window.prompt('Reason for cancelling this voucher (at least 8 characters):') ?? '';
    if (reason.trim().length < 8) return;
    setBusy(true);
    try {
      await api(`/cash/agent/vouchers/${id}/cancel`, { method: 'POST', body: { reason } });
      toast.info('Voucher cancelled', 'The code can no longer be redeemed.');
      refresh();
    } catch (error) { toast.error('Could not cancel the voucher', errorMessage(error)); }
    finally { setBusy(false); }
  };

  const agent = dashboard.data?.agent;

  return (
    <div className="container">
      <PageHeader eyebrow="Cash agent" title="Teller console" description="Take cash, issue a code; pay cash against a resident code. Every movement is a balanced ledger journal, so the float and the platform wallet can never disagree." />

      {dashboard.isLoading && <div className="card"><span className="loading" /> Loading agent…</div>}
      {dashboard.error && <ErrorState message={errorMessage(dashboard.error)} retry={() => void dashboard.refetch()} />}

      {agent && (
        <>
          {dashboard.data?.mode !== 'real' && (
            <div className="alert" style={{ marginBottom: '1rem' }}>
              <strong>{dashboard.data?.mode === 'test' ? 'Test counter.' : 'Counter closed for cash out.'}</strong>{' '}
              {dashboard.data?.mode === 'test'
                ? 'Codes issued here credit clearly labelled test credits with no cash value, and cash payouts are unavailable.'
                : 'Cash vouchers are refused until test or authorised real-money mode is active.'}
            </div>
          )}
          <div className="grid-4" style={{ marginBottom: '1.5rem' }}>
            <div className="card"><div className="stat-label">Agent</div><div className="stat-value" style={{ fontSize: '1.5rem' }}>{agent.code}</div><div className="stat-foot">{agent.name}{agent.location ? ` · ${agent.location}` : ''}</div></div>
            <div className="card"><div className="stat-label">Cash on hand</div><div className="stat-value">{formatMoney(agent.cashHeldCents)}</div><div className="stat-foot">Unremitted custody balance</div></div>
            <div className="card"><div className="stat-label">Today in / out</div><div className="stat-value" style={{ fontSize: '1.15rem' }}>{formatMoney(agent.todayDepositCents)} in<br />{formatMoney(agent.todayPayoutCents)} out</div><div className="stat-foot">Daily limits {formatMoney(agent.dailyDepositLimitCents)} / {formatMoney(agent.dailyPayoutLimitCents)}</div></div>
            <div className="card"><div className="stat-label">Open codes</div><div className="stat-value">{agent.openVouchers}</div><div className="stat-foot">Voucher limit {formatMoney(agent.voucherLimitCents)}</div></div>
          </div>

          <div className="split">
            <div className="stack">
              <section className="card">
                <div className="card-header"><h2 className="card-title"><Icon name="download" size={18} /> Take cash, issue a code</h2></div>
                <div className="stack">
                  <label className="field"><span className="field-label">Cash received (USD)</span>
                    <input className="input" type="number" min="1" step="1" value={issue.amount} onChange={(e) => setIssue((v) => ({ ...v, amount: e.target.value }))} /></label>
                  <label className="field"><span className="field-label">Player username (recommended)</span>
                    <input className="input" value={issue.playerUsername} onChange={(e) => setIssue((v) => ({ ...v, playerUsername: e.target.value }))} placeholder="locks the code to one account" />
                    <span className="field-hint">Leave empty only if the player cannot give a username; an open code can be redeemed by anyone who sees it.</span></label>
                  <label className="field"><span className="field-label">Teller receipt / reference</span>
                    <input className="input" value={issue.reference} onChange={(e) => setIssue((v) => ({ ...v, reference: e.target.value }))} placeholder="optional" /></label>
                  <button className="btn btn-primary btn-block" onClick={() => void issueVoucher()} disabled={busy || Number(issue.amount) < 1}>Issue cash-in code</button>
                  {issued && <div className="alert" role="status"><strong>Give this code to the player</strong>
                    <div className="mono" style={{ fontSize: '1.6rem', letterSpacing: '.14em' }}>{issued.code}</div>
                    <div className="small">{formatMoney(issued.amountCents)} — valid for 60 minutes. The player enters it in their wallet to receive the balance.</div></div>}
                </div>
              </section>

              <section className="card">
                <div className="card-header"><h2 className="card-title"><Icon name="arrowLeft" size={18} /> Pay cash against a code</h2></div>
                <div className="stack">
                  {!dashboard.data?.payoutsEnabled ? (
                    <div className="alert alert-warning small">
                      <strong>Cash payouts are unavailable.</strong>{' '}
                      {dashboard.data?.mode === 'test'
                        ? 'This counter is in internal test mode; test credits can never be withdrawn as cash.'
                        : 'Authorised real-money mode is not active. Take cash in only.'}
                    </div>
                  ) : (
                    <>
                      <p className="tiny muted" style={{ marginBottom: 0 }}>Check the player's national ID against the account before paying. You are responsible for the cash once you confirm.</p>
                      <label className="field"><span className="field-label">Player's cash-out code</span>
                        <input className="input mono" value={settle.code} onChange={(e) => setSettle((v) => ({ ...v, code: e.target.value.toUpperCase() }))} placeholder="XXXX-XXXX" /></label>
                      <label className="field"><span className="field-label">Payout receipt</span>
                        <input className="input" value={settle.reference} onChange={(e) => setSettle((v) => ({ ...v, reference: e.target.value }))} placeholder="optional" /></label>
                      <button className="btn btn-block" onClick={() => void settlePayout()} disabled={busy || settle.code.trim().length < 4}>Confirm cash paid</button>
                      {agent.cashHeldCents <= 0 && <div className="alert alert-warning small"><strong>No cash on hand.</strong> You can only pay out cash that you have taken in or been given as float. Ask the operator to record a float transfer.</div>}
                    </>
                  )}
                </div>
              </section>
            </div>

            <div className="stack">
              <section className="card">
                <div className="card-header"><h2 className="card-title">Recent codes</h2><span className="pill">{dashboard.data?.vouchers.length ?? 0}</span></div>
                {(dashboard.data?.vouchers.length ?? 0) === 0
                  ? <EmptyState title="No vouchers yet">Codes you issue or pay appear here with a hashed reference; the full code is only ever printed once.</EmptyState>
                  : <div className="table-wrap"><table className="table">
                    <thead><tr><th>Issued</th><th>Type</th><th>Amount</th><th>Status</th><th>Player</th><th /></tr></thead>
                    <tbody>{dashboard.data?.vouchers.map((voucher) => (
                      <tr key={voucher.id}>
                        <td className="tiny">{new Date(voucher.issuedAt).toLocaleString()}<div className="mono tiny muted">••••{voucher.codeLast4}</div></td>
                        <td>{voucher.kind === 'deposit' ? 'Cash in' : 'Cash out'}{voucher.sandbox ? <span className="pill pill-accent"> test</span> : null}</td>
                        <td>{formatMoney(voucher.amountCents)}</td>
                        <td><span className={`pill ${voucher.status === 'redeemed' || voucher.status === 'paid' ? 'pill-success' : voucher.status === 'issued' ? 'pill-accent' : 'pill-danger'}`}>{voucher.status}</span></td>
                        <td className="small">{voucher.playerUsername ?? 'any'}</td>
                        <td>{voucher.status === 'issued' && <button className="btn btn-sm" onClick={() => void cancelVoucher(voucher.id)} disabled={busy}>Cancel</button>}</td>
                      </tr>
                    ))}</tbody>
                  </table></div>}
              </section>
              <section className="card">
                <h2 className="card-title">Counter rules</h2>
                <ul className="small" style={{ paddingLeft: '1.1rem' }}>
                  <li>Only accept cash in the currency shown on the console.</li>
                  <li>Issue a code only after the cash is in the till; never issue on a promise.</li>
                  <li>Never ask for a password, one-time code or mobile-money PIN.</li>
                  <li>Pay out only against a code and a matching national ID.</li>
                  <li>Remit cash to the operator daily; unremitted cash is visible on this page.</li>
                </ul>
              </section>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
