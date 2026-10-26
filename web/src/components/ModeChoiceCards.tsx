import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { EligibilityView, PlatformStatus } from '@shared/contracts';
import { countryName } from '@shared/countries';
import { api } from '../lib/api';
import { useAuth } from '../app/AuthProvider';
import { Icon } from './Icon';

export function ModeChoiceCards({ compact = false }: { compact?: boolean }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const status = useQuery({ queryKey: ['platform-status'], queryFn: () => api<PlatformStatus>('/status'), staleTime: 60_000 });
  const eligibility = useQuery({ queryKey: ['eligibility'], queryFn: () => api<EligibilityView>('/eligibility'), staleTime: 60_000 });

  const moneyAllowed = !!status.data?.realMoneyEnabled && !!eligibility.data?.moneyMatches.allowed;
  const jurisdiction = eligibility.data?.verifiedEligibilityJurisdiction
    ? countryName(eligibility.data.verifiedEligibilityJurisdiction)
    : eligibility.data?.countryOfResidence && eligibility.data.countryOfResidence !== 'ZZ'
      ? `${countryName(eligibility.data.countryOfResidence)} (unverified for money play)`
      : 'No verified jurisdiction';
  const blockers = eligibility.data?.moneyMatches.blockers ?? [];
  const platformBlockers = status.data?.realMoneyBlockers ?? [];

  return (
    <section className={`mode-choice-grid ${compact ? 'mode-choice-compact' : ''}`} aria-label="Choose how to play" data-testid="mode-choice-cards">
      <article className="card mode-card mode-free">
        <div className="mode-card-head">
          <span className="feature-icon"><Icon name="board" size={22} /></span>
          <span className="pill pill-teal">Always available</span>
        </div>
        <h2>Play Free</h2>
        <p className="soft">International chess with no deposit, entry fee, stake or payment method.</p>
        <ul className="small soft">
          <li><Icon name="check" size={14} /> Challenge friends and random opponents worldwide.</li>
          <li><Icon name="check" size={14} /> Casual, rated, tournaments and all time controls.</li>
          <li><Icon name="check" size={14} /> Play immediately — payment services are never required.</li>
        </ul>
        <button className="btn btn-primary btn-block" onClick={() => navigate('/play?mode=free')} data-testid="play-free-button">
          <Icon name="play" size={17} /> Play free chess
        </button>
      </article>

      <article className="card mode-card mode-money">
        <div className="mode-card-head">
          <span className="feature-icon"><Icon name="trophy" size={22} /></span>
          <span className={`pill ${moneyAllowed ? 'pill-success' : 'pill-danger'}`}>{moneyAllowed ? 'Eligible' : 'Unavailable'}</span>
        </div>
        <h2>Play for Money</h2>
        <p className="soft">Optional, voluntary USD-cent matches. Both players must accept identical hashed terms.</p>
        <ul className="small soft">
          <li><Icon name="check" size={14} /> Stakes from USD $0.50 per player, only where lawful.</li>
          <li><Icon name="check" size={14} /> Pot, fee and exact winner payout before confirmation.</li>
          <li><Icon name="check" size={14} /> Atomic reservation and exactly-once audited settlement.</li>
        </ul>
        <div className="alert alert-warning" style={{ padding: '.65rem .8rem' }}>
          <strong>Eligibility:</strong> {user ? jurisdiction : 'Sign in to check your verified jurisdiction.'}
          <div className="tiny muted">A selected country or IP address never overrides a server policy.</div>
          {!moneyAllowed && (blockers.length > 0 || platformBlockers.length > 0) && (
            <details style={{ marginTop: '.4rem' }}>
              <summary className="tiny">Why unavailable</summary>
              <ul className="tiny" style={{ margin: '.35rem 0 0', paddingLeft: '1.1rem' }}>
                {[...new Set([...platformBlockers, ...blockers])].slice(0, 5).map((blocker) => <li key={blocker}>{blocker}</li>)}
              </ul>
            </details>
          )}
        </div>
        <button className="btn btn-block" disabled={!moneyAllowed} onClick={() => navigate('/competitions#fee-calculator')} data-testid="play-money-button">
          <Icon name={moneyAllowed ? 'trophy' : 'lock'} size={17} /> {moneyAllowed ? 'Choose a stake' : 'Money matches disabled'}
        </button>
        {status.data?.mode === 'test' && (
          <div className="tiny muted" style={{ marginTop: '.5rem' }}>
            Internal test mode uses clearly labelled non-withdrawable credits. It is not real money.
          </div>
        )}
      </article>
    </section>
  );
}
