import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ALLOWED_STAKES_CENTS, formatMoney, quoteTerms,
  type ChallengeView, type PlatformStatus,
} from '@shared/contracts';
import { api } from '../lib/api';
import { PageHeader, EmptyState } from '../components/PageHeader';
import { CompetitionRules, ProviderHealthCard, QuoteDisclosure, type CompetitionQuote } from '../components/Competition';
import { Icon } from '../components/Icon';

const ACTIVATION_STEPS = [
  'Obtain a written legal opinion for the exact competition format in each target jurisdiction.',
  'Verify the current Zimbabwe gaming statute, regulator rules and any remote/skill-game licence requirements.',
  'Obtain operator licensing/permissions and record the issued licence reference.',
  'Obtain written payment-provider approval for the specific merchant, product and wagering/competition use case.',
  'Integrate an approved 18+ identity provider; never rely on self-declared age.',
  'Implement AML/KYC, sanctions screening, tax treatment, responsible-play and dispute procedures with named officers.',
  'Have a human compliance officer sign and independently store the HMAC activation manifest.',
  'Run sandbox reconciliation, signed webhook, refund, chargeback and ledger-recovery tests before enabling production keys.',
];

export function CompetitionsPage() {
  const [stake, setStake] = useState(100);
  const status = useQuery({ queryKey: ['platform-status'], queryFn: () => api<PlatformStatus>('/status'), staleTime: 60_000 });
  const challenges = useQuery({
    queryKey: ['competition-challenges'],
    queryFn: () => api<{ items: ChallengeView[] }>('/challenges?limit=50&sort=stake'),
    refetchInterval: 20_000,
  });
  const feeBps = status.data?.feeBps ?? 500;
  const quote = useQuery({
    queryKey: ['competition-fee-preview', stake, feeBps],
    queryFn: () => api<{ quote: ReturnType<typeof quoteTerms>; explanation: string }>('/competitions/fee-preview', { method: 'POST', body: { stakeCents: stake, feeBps } }),
  });
  const illustrative = useMemo(() => [50, 100, 500].map((value) => quoteTerms(value, feeBps)), [feeBps]);
  const paidChallenges = challenges.data?.items.filter((item) => item.stakeCents > 0) ?? [];
  const displayQuote: CompetitionQuote | null = status.data ? {
    terms: quote.data?.quote ?? quoteTerms(stake, feeBps),
    termsHash: null, feeBps,
    mode: status.data.mode,
    label: status.data.mode === 'test' ? 'Internal test credit example' : status.data.realMoneyEnabled ? 'Authorised USD example' : 'Illustrative only — not available',
    disclosures: [
      'This is a mathematical illustration of the server’s integer-cent formula, not an active wallet balance.',
      'A draw or void refunds each stake with no commission.',
      'Real money remains disabled until every legal, provider and age-verification prerequisite is verified.',
    ],
    allowed: status.data.realMoneyEnabled || status.data.mode === 'test',
    blockers: status.data.realMoneyBlockers,
  } : null;

  return (
    <div className="container">
      <PageHeader eyebrow="Competitions" title="Competition centre" description="Transparent entry conditions, exact fee math and server-enforced settlement. Paid competitions are separate from free chess and are disabled until independently verified authorisation exists."
        actions={<Link className="btn btn-primary" to="/play"><Icon name="play" size={17} /> Browse live lobby</Link>} />

      <div className="grid-3" style={{ marginBottom: '1.5rem' }}>
        <div className="card">
          <div className="stat-label">Platform mode</div>
          <div className="stat-value">{status.data?.mode === 'test' ? 'Internal test' : status.data?.realMoneyEnabled ? 'Authorised real money' : 'Free chess'}</div>
          <div className="small soft">{status.data?.legalNotice}</div>
        </div>
        <div className="card">
          <div className="stat-label">Configured commission</div>
          <div className="stat-value">{(feeBps / 100).toFixed(2)}%</div>
          <div className="small soft">Illustrative default 5% of the pot. Administrators may change it only with a documented reason and audit log.</div>
        </div>
        <div className="card">
          <div className="stat-label">Real-money status</div>
          <div className="stat-value" style={{ color: status.data?.realMoneyEnabled ? 'var(--danger)' : 'var(--success)' }}>{status.data?.realMoneyEnabled ? 'Enabled' : 'Disabled'}</div>
          <div className="small soft">A configuration flag alone cannot enable it; a signed compliance manifest is also required.</div>
        </div>
      </div>

      <div className="split" style={{ marginBottom: '1.5rem' }}>
        <div className="stack">
          <section className="card" id="fee-calculator">
            <div className="card-header"><div><h2 className="card-title">Fee &amp; prize calculator</h2><p className="card-subtitle">Integer USD-cent arithmetic. No floating-point balances.</p></div><span className="pill">{(feeBps / 100).toFixed(2)}% fee</span></div>
            <div className="stake-grid">
              {ALLOWED_STAKES_CENTS.slice(0, 8).map((amount) => <button className="stake-option" key={amount} aria-pressed={stake === amount} onClick={() => setStake(amount)}>{formatMoney(amount)}</button>)}
            </div>
            <div style={{ marginTop: '1rem' }}>{displayQuote && <QuoteDisclosure quote={displayQuote} />}</div>
            <div className="table-wrap" style={{ marginTop: '1rem' }}>
              <table className="table">
                <thead><tr><th>Each stake</th><th>Pot</th><th>Fee</th><th>Winner</th><th>Draw refund</th></tr></thead>
                <tbody>{illustrative.map((row) => <tr key={row.stakeCents}>
                  <td>{formatMoney(row.stakeCents)}</td><td>{formatMoney(row.potCents)}</td><td>{formatMoney(row.feeCents)}</td>
                  <td><strong>{formatMoney(row.payoutCents)}</strong></td><td>{formatMoney(row.stakeCents)} each, no fee</td>
                </tr>)}</tbody>
              </table>
            </div>
          </section>

          <section className="card">
            <div className="card-header"><h2 className="card-title">Live paid challenges</h2><span className="pill">{paidChallenges.length} from real accounts</span></div>
            {paidChallenges.length === 0 ? <EmptyState title="No paid challenges are open">No prize pool is displayed because no authenticated player has created one. Free chess remains available.</EmptyState> : (
              <div className="stack">{paidChallenges.map((item) => (
                <div className="alert" key={item.id}>
                  <div className="spread"><strong>{item.creator.username}</strong><span>{formatMoney(item.stakeCents)} stake</span></div>
                  <div className="small">{item.timeControl.category} · rating {item.ratingMin}–{item.ratingMax} · expires {new Date(item.expiresAt).toLocaleString()}</div>
                  <Link className="tiny" to={`/challenge/${item.id}`}>View terms</Link>
                </div>
              ))}</div>
            )}
          </section>
        </div>

        <div className="sidebar">
          <section className="card">
            <div className="card-header"><h2 className="card-title"><Icon name="shield" size={18} /> Activation blockers</h2></div>
            {status.data?.realMoneyEnabled ? <div className="alert alert-danger"><strong>Authorised mode.</strong> Verify the active licence and provider approval references before each competition cycle.</div> : (
              <>
                <div className="alert alert-warning"><strong>Real money is disabled.</strong> {status.data?.realMoneyBlockers.join(' ')}</div>
                <ol className="small soft" style={{ paddingLeft: '1.2rem' }}>{ACTIVATION_STEPS.map((step) => <li key={step}>{step}</li>)}</ol>
              </>
            )}
            <Link className="btn btn-sm" to="/legal#compliance">Read compliance policy</Link>
          </section>
          <ProviderHealthCard />
        </div>
      </div>

      <CompetitionRules />

      <section className="card" style={{ marginTop: '1.5rem' }}>
        <div className="card-header"><h2 className="card-title">Responsible play &amp; eligibility</h2></div>
        <div className="grid-3">
          <div><h3>18+ only</h3><p className="small soft">Real-money play requires an approved identity/age provider. A self-declared birth date is not treated as verification.</p></div>
          <div><h3>Limits and exclusion</h3><p className="small soft">Daily deposit and stake limits, session limits and self-exclusion are enforced on the server. <Link to="/settings#responsible">Manage controls</Link>.</p></div>
          <div><h3>Human review</h3><p className="small soft">Engine similarity may create a review signal, but no automatic ban or confiscation follows from it alone. <Link to="/help#disputes">Dispute process</Link>.</p></div>
        </div>
      </section>
    </div>
  );
}
