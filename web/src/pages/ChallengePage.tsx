import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { formatCents, type ChallengeView } from '@shared/contracts';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../app/AuthProvider';
import { useToast } from '../app/ToastProvider';
import { PageHeader, ErrorState } from '../components/PageHeader';
import { QuoteDisclosure, type CompetitionQuote } from '../components/Competition';
import { Icon } from '../components/Icon';

export function ChallengePage() {
  const { idOrToken = '' } = useParams();
  const isToken = idOrToken.length > 30;
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);

  const challenge = useQuery({
    queryKey: ['challenge', idOrToken],
    queryFn: () => api<ChallengeView>(isToken ? `/invites/${encodeURIComponent(idOrToken)}` : `/challenges/${idOrToken}`),
    retry: false,
  });
  const quote = useQuery({
    queryKey: ['challenge-quote', idOrToken, challenge.data?.stakeCents],
    queryFn: () => api<CompetitionQuote>('/competitions/quote', { method: 'POST', body: {
      context: 'challenge', kind: challenge!.data!.kind,
      opponentUsername: challenge!.data!.opponent?.username,
      timeControl: challenge!.data!.timeControl,
      stakeCents: challenge!.data!.stakeCents,
      ratingRange: Math.max(challenge!.data!.ratingMax - challenge!.data!.creator.rating, challenge!.data!.creator.rating - challenge!.data!.ratingMin),
    } }),
    enabled: !!challenge.data && challenge.data.stakeCents > 0,
  });

  const accept = async () => {
    if (!challenge.data) return;
    if (!user) { navigate(`/auth?next=${encodeURIComponent(`/challenge/${idOrToken}`)}`); return; }
    if (challenge.data.stakeCents > 0 && (!accepted || !quote.data?.termsHash)) {
      toast.error('Accept the exact terms', 'Review and accept the hashed competition terms before entering.');
      return;
    }
    setBusy(true);
    try {
      const result = await api<{ gameId: string }>(`/challenges/${challenge.data.id}/accept`, {
        method: 'POST',
        body: { acceptedTermsHash: quote.data?.termsHash ?? undefined, inviteToken: isToken ? idOrToken : undefined },
      });
      navigate(`/game/${result.gameId}`);
    } catch (error) { toast.error('Could not accept challenge', errorMessage(error)); }
    finally { setBusy(false); }
  };

  return (
    <div className="container-narrow">
      <PageHeader eyebrow="Challenge" title={isToken ? 'Private invitation' : 'Challenge details'} description="The server verifies this invitation, your session, rating range, competition terms and available funds before a game can start." />
      {challenge.isLoading && <div className="card"><span className="loading" /> Verifying invitation…</div>}
      {challenge.error && <ErrorState message={errorMessage(challenge.error)} retry={() => void challenge.refetch()} />}
      {challenge.data && <div className="stack">
        <section className="card">
          <div className="spread" style={{ flexWrap: 'wrap' }}>
            <div>
              <span className="pill pill-accent">{challenge.data.kind} challenge</span>
              <h2 style={{ marginTop: '.75rem' }}>{challenge.data.creator.username} is waiting</h2>
              <p className="soft">Rating {challenge.data.creator.rating} · {challenge.data.timeControl.category} · {Math.round(challenge.data.timeControl.baseMs / 60000)} min + {challenge.data.timeControl.incrementMs / 1000}s</p>
            </div>
            <div className="stat"><div className="stat-label">Stake per player</div><div className="stat-value">{challenge.data.stakeCents === 0 ? 'Free' : formatCents(challenge.data.stakeCents)}</div></div>
          </div>
          <div className="row-wrap" style={{ marginTop: '1rem' }}>
            <span className="pill">Rating {challenge.data.ratingMin}–{challenge.data.ratingMax}</span>
            <span className="pill">Expires {new Date(challenge.data.expiresAt).toLocaleString()}</span>
            {challenge.data.opponent && <span className="pill">For {challenge.data.opponent.username}</span>}
          </div>
        </section>

        {challenge.data.stakeCents > 0 && quote.data && <QuoteDisclosure quote={quote.data} showAccept={!!user} accepted={accepted} onAccept={setAccepted} />}
        {challenge.data.stakeCents > 0 && quote.isLoading && <div className="card"><span className="loading" /> Fetching exact server quote…</div>}
        {challenge.data.stakeCents === 0 && <div className="alert alert-success"><strong>Free chess.</strong> No funds are reserved and no commission is charged.</div>}

        <div className="card">
          {!user && <div className="alert alert-warning"><strong>Sign in required.</strong> You need an authenticated account to accept a challenge. <Link to={`/auth?next=${encodeURIComponent(`/challenge/${idOrToken}`)}`}>Sign in or create an account</Link>.</div>}
          {user && challenge.data.creator.id === user.id && <div className="alert">This is your own challenge. Share the invitation or wait for another real player to accept it.</div>}
          <button className="btn btn-primary btn-block" onClick={() => void accept()} disabled={busy || (!!user && challenge.data.creator.id === user.id)}>
            {busy ? <span className="loading" /> : <Icon name="play" size={17} />} {user ? 'Accept challenge and play' : 'Sign in to accept'}
          </button>
          <p className="tiny muted" style={{ marginBottom: 0, marginTop: '.6rem' }}>A game is created only after the authoritative server has validated every condition.</p>
        </div>
      </div>}
    </div>
  );
}
