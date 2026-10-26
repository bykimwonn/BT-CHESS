import type { CompetitionTerms, PlatformStatus, ProviderHealth } from '@shared/contracts';
import { formatMoney } from '@shared/contracts';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Icon } from './Icon';

export interface CompetitionQuote {
  terms: CompetitionTerms | null;
  termsHash: string | null;
  feeBps: number;
  mode: 'free' | 'test' | 'real';
  label: string;
  disclosures: string[];
  allowed: boolean;
  blockers: string[];
}

export function QuoteDisclosure({ quote, showAccept = false, accepted, onAccept }: {
  quote: CompetitionQuote; showAccept?: boolean; accepted?: boolean; onAccept?: (value: boolean) => void;
}) {
  const terms = quote.terms;
  return (
    <div className="quote-box">
      <div className="spread"><strong>{quote.label}</strong><span className="pill">{quote.feeBps / 100}% fee</span></div>
      {terms ? (
        <>
          <div className="quote-row"><span>Each player stakes</span><strong>{formatMoney(terms.stakeCents)}</strong></div>
          <div className="quote-row"><span>Total pot</span><strong>{formatMoney(terms.potCents)}</strong></div>
          <div className="quote-row"><span>Commission ({(terms.feeBps / 100).toFixed(2)}%)</span><strong>{formatMoney(terms.feeCents)}</strong></div>
          <div className="quote-row"><span>Winner receives</span><strong className="accent">{formatMoney(terms.payoutCents)}</strong></div>
          <div className="quote-row"><span>Draw / void</span><strong>Full refund, no fee</strong></div>
        </>
      ) : <p className="small muted">Free game — no stake, pot, fee or payout.</p>}
      <ul className="small soft" style={{ paddingLeft: '1.2rem', margin: '.75rem 0 0' }}>
        {quote.disclosures.map((line) => <li key={line}>{line}</li>)}
      </ul>
      {!quote.allowed && (
        <div className="alert alert-warning" style={{ marginTop: '.75rem' }}>
          <strong>Not available.</strong> {quote.blockers.join(' ')}
        </div>
      )}
      {showAccept && quote.terms && (
        <label className="checkbox" style={{ marginTop: '.75rem' }}>
          <input type="checkbox" checked={!!accepted} onChange={(e) => onAccept?.(e.target.checked)} />
          <span>I have read and accept these exact competition terms, including commission, draw, void, disconnect and dispute rules.</span>
        </label>
      )}
      {quote.termsHash && <div className="tiny muted mono" style={{ marginTop: '.5rem', overflowWrap: 'anywhere' }}>Terms hash: {quote.termsHash}</div>}
    </div>
  );
}

export function CompetitionRules() {
  return (
    <section className="card" id="competition-rules">
      <div className="card-header"><h2 className="card-title">Competition rules</h2><span className="pill">Authoritative</span></div>
      <div className="grid-2">
        <div>
          <h3>Before the game</h3>
          <ul className="small soft">
            <li>Both players must accept an identical, hashed terms disclosure and fee quote.</li>
            <li>Both stakes are reserved atomically. Insufficient available funds cannot enter a competition.</li>
            <li>Custom game terms are rejected if the server quote changed after acceptance.</li>
          </ul>
          <h3>During the game</h3>
          <ul className="small soft">
            <li>The server owns the board, clocks, move order, ratings and result.</li>
            <li>Every move includes a unique client nonce and the expected state version; stale or duplicate messages are rejected.</li>
            <li>Reconnection restores the persisted game. After 90 seconds of one-sided disconnection, the connected player may win under the published abandonment rule; if neither returns, the game is voided.</li>
          </ul>
        </div>
        <div>
          <h3>Results and money</h3>
          <ul className="small soft">
            <li>A decisive result pays the winner the pot minus the configured commission. The default illustrative fee is 5%.</li>
            <li>Draws and voids refund both stakes with no commission.</li>
            <li>Commission is recorded in a separate ledger account. Posted entries are immutable; corrections use audited compensating entries.</li>
            <li>An open dispute or match review blocks settlement until a human administrator resolves it.</li>
          </ul>
          <h3>Player protections</h3>
          <ul className="small soft">
            <li>18+ age verification, email verification and responsible-play limits are required for real-money play.</li>
            <li>No automatic ban or confiscation is imposed solely because moves resemble engine suggestions.</li>
            <li>Self-exclusion, daily deposit/stake limits and cooling-off controls are available.</li>
          </ul>
        </div>
      </div>
    </section>
  );
}

export function ProviderHealthCard({ compact = false }: { compact?: boolean }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['provider-health'],
    queryFn: () => api<{ providers: ProviderHealth[]; docs: Array<{ id: string; name: string; docsUrl: string }> }>('/payments/providers'),
    staleTime: 60_000,
  });
  const status = useQuery({ queryKey: ['platform-status'], queryFn: () => api<PlatformStatus>('/status'), staleTime: 60_000 });
  if (isLoading) return <div className="card"><span className="loading" /> Checking provider configuration…</div>;
  if (error) return <div className="alert alert-danger"><strong>Provider status unavailable.</strong> No payment capability is assumed.</div>;
  return (
    <section className="card" aria-labelledby="providers-title">
      <div className="card-header">
        <div><h2 className="card-title" id="providers-title"><Icon name="shield" size={18} /> Provider status</h2>
          <p className="card-subtitle">Configuration and approval are verified by the server. Sandbox is never production.</p></div>
        <span className={`pill ${status.data?.realMoneyEnabled ? 'pill-danger' : 'pill-teal'}`}>{status.data?.realMoneyEnabled ? 'Real mode' : 'Real money off'}</span>
      </div>
      <div className="stack">
        {data?.providers.map((provider) => {
          const docs = data.docs.find((d) => d.id === provider.id);
          return (
            <div className="alert" key={provider.id}>
              <div className="spread"><strong>{provider.name}</strong><span className={`pill ${provider.configured ? 'pill-success' : 'pill-danger'}`}>{provider.configured ? 'Configured' : 'Not configured'}</span></div>
              <div className="small">{provider.reason}</div>
              {!compact && <div className="tiny muted">Environment: {provider.sandbox ? 'Sandbox' : 'Production'} · Capabilities: {provider.capabilities.length ? provider.capabilities.join(', ') : 'none verified'}</div>}
              {docs && <a className="tiny" href={docs.docsUrl} target="_blank" rel="noreferrer">Official documentation <Icon name="external" size={12} /></a>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
