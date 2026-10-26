import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ALLOWED_STAKES_CENTS, TIME_PRESETS, formatMoney,
  type ChallengeView, type PlatformStatus, type TimeControl,
} from '@shared/contracts';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../app/AuthProvider';
import { useToast } from '../app/ToastProvider';
import { useSocket, useSocketEvent } from '../app/SocketProvider';
import { Modal } from '../components/Modal';
import { Icon } from '../components/Icon';
import { PageHeader, EmptyState, ErrorState } from '../components/PageHeader';
import { QuoteDisclosure, type CompetitionQuote, ProviderHealthCard } from '../components/Competition';
import { ModeChoiceCards } from '../components/ModeChoiceCards';

type Category = TimeControl['category'];

function useQuote(input: { context: 'challenge' | 'matchmaking'; kind?: string; opponentUsername?: string; timeControl: TimeControl; stakeCents: number; ratingRange: number }) {
  const key = ['quote', input.context, input.kind, input.opponentUsername, input.timeControl.category, input.timeControl.baseMs, input.timeControl.incrementMs, input.stakeCents, input.ratingRange];
  return useQuery({
    queryKey: key,
    queryFn: () => api<CompetitionQuote>('/competitions/quote', { method: 'POST', body: {
      context: input.context, kind: input.kind ?? 'open', opponentUsername: input.opponentUsername,
      timeControl: input.timeControl, stakeCents: input.stakeCents, ratingRange: input.ratingRange,
    } }),
    staleTime: 30_000,
  });
}

function TimeControlPicker({ value, onChange }: { value: TimeControl; onChange: (value: TimeControl) => void }) {
  const [minutes, setMinutes] = useState(String(Math.round(value.baseMs / 60_000)));
  const [increment, setIncrement] = useState(String(Math.round(value.incrementMs / 1000)));
  return (
    <div className="stack">
      <div className="segmented" role="group" aria-label="Time control">
        {(['bullet', 'blitz', 'rapid', 'classical', 'custom'] as Category[]).map((category) => (
          <button key={category} type="button" aria-pressed={value.category === category}
            onClick={() => onChange(category === 'custom'
              ? { category, baseMs: Math.max(30_000, Number(minutes) * 60_000 || 300_000), incrementMs: Number(increment) * 1000 || 0 }
              : { ...TIME_PRESETS[category] })}>
            {category}
          </button>
        ))}
      </div>
      {value.category === 'custom' && (
        <div className="grid-2">
          <label className="field"><span className="field-label">Base minutes</span>
            <input className="input" type="number" min="1" max="120" value={minutes} onChange={(e) => {
              setMinutes(e.target.value); onChange({ category: 'custom', baseMs: Math.max(30_000, Number(e.target.value) * 60_000 || 30_000), incrementMs: Number(increment) * 1000 || 0 });
            }} /></label>
          <label className="field"><span className="field-label">Increment seconds</span>
            <input className="input" type="number" min="0" max="60" value={increment} onChange={(e) => {
              setIncrement(e.target.value); onChange({ category: 'custom', baseMs: Math.max(30_000, Number(minutes) * 60_000 || 30_000), incrementMs: Number(e.target.value) * 1000 || 0 });
            }} /></label>
        </div>
      )}
      <span className="field-hint">{Math.round(value.baseMs / 60_000)} min + {value.incrementMs / 1000}s · server-authoritative clocks.</span>
    </div>
  );
}

function StakePicker({ stake, setStake, competitionsEnabled }: { stake: number; setStake: (value: number) => void; competitionsEnabled: boolean }) {
  return (
    <div className="field">
      <span className="field-label">Stake per player</span>
      <div className="stake-grid">
        <button type="button" className="stake-option" aria-pressed={stake === 0} onClick={() => setStake(0)}>Free</button>
        {ALLOWED_STAKES_CENTS.map((amount) => (
          <button type="button" key={amount} className="stake-option" aria-pressed={stake === amount}
            disabled={!competitionsEnabled} onClick={() => setStake(amount)}>{formatMoney(amount)}</button>
        ))}
      </div>
      {!competitionsEnabled && <span className="field-hint">Paid competitions are disabled until legal, provider and 18+ checks are verified. Free chess remains available.</span>}
    </div>
  );
}

export function PlayPage() {
  const { user } = useAuth();
  const { connected, emit } = useSocket();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState({ search: '', timeCategory: '', stake: '', sort: 'newest' });
  const [creating, setCreating] = useState(false);
  const [accepting, setAccepting] = useState<ChallengeView | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState<{ ticketId: string; timeControl: TimeControl } | null>(null);
  const [timeControl, setTimeControl] = useState<TimeControl>({ ...TIME_PRESETS.blitz });
  const [createTimeControl, setCreateTimeControl] = useState<TimeControl>({ ...TIME_PRESETS.rapid });
  const [stake, setStake] = useState(0);
  const [createStake, setCreateStake] = useState(0);
  const [ratingRange, setRatingRange] = useState(300);
  const [kind, setKind] = useState<'open' | 'direct' | 'private'>('open');
  const [opponent, setOpponent] = useState('');
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [acceptTermsAccepted, setAcceptTermsAccepted] = useState(false);
  const [mfaCode, setMfaCode] = useState('');

  const status = useQuery({ queryKey: ['platform-status'], queryFn: () => api<PlatformStatus>('/status'), staleTime: 60_000 });
  const competitionsEnabled = !!status.data?.competitionsEnabled;
  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    if (filters.search) params.set('search', filters.search);
    if (filters.timeCategory) params.set('timeCategory', filters.timeCategory);
    if (filters.stake) params.set('stakeCents', filters.stake);
    if (filters.sort) params.set('sort', filters.sort);
    return params.toString();
  }, [filters]);
  const challenges = useQuery({
    queryKey: ['challenges', queryString],
    queryFn: () => api<{ items: ChallengeView[]; total: number; limit: number; offset: number }>(`/challenges?${queryString}`),
    refetchInterval: 20_000,
  });
  const quickQuote = useQuote({ context: 'matchmaking', timeControl, stakeCents: stake, ratingRange });
  const createQuote = useQuote({ context: 'challenge', kind, opponentUsername: kind === 'direct' ? opponent : undefined, timeControl: createTimeControl, stakeCents: createStake, ratingRange });
  const acceptQuote = useQuery({
    queryKey: ['accept-quote', accepting?.id],
    queryFn: () => api<CompetitionQuote>('/competitions/quote', { method: 'POST', body: {
      context: 'challenge', kind: accepting!.kind,
      opponentUsername: accepting!.opponent?.username,
      timeControl: accepting!.timeControl,
      stakeCents: accepting!.stakeCents,
      ratingRange: Math.max(accepting!.ratingMax - accepting!.creator.rating, accepting!.creator.rating - accepting!.ratingMin),
    } }),
    enabled: !!accepting && accepting.stakeCents > 0,
  });

  useEffect(() => {
    if (!connected) return;
    void emit('challenge:subscribe', {}).catch(() => undefined);
  }, [connected, emit]);

  const refetchAll = () => {
    void queryClient.invalidateQueries({ queryKey: ['challenges'] });
    void queryClient.invalidateQueries({ queryKey: ['platform-status'] });
  };
  useSocketEvent('challenge:created', refetchAll);
  useSocketEvent('challenge:updated', refetchAll);
  useSocketEvent<{ gameId: string }>('matchmaking:found', (event) => {
    setQueued(null);
    toast.success('Match found', 'Two authenticated players are connected. Opening the board.');
    navigate(`/game/${event.gameId}`);
  });

  const quickMatch = async () => {
    if (!user) { navigate('/auth?next=/play'); return; }
    if (stake > 0 && (!quickQuote.data?.allowed || !termsAccepted)) {
      toast.error('Accept the competition terms', 'Review the quote and confirm the exact terms before entering.');
      return;
    }
    setBusy(true);
    try {
      const result = await api<{ status: 'queued' | 'matched'; gameId?: string; ticketId: string }>('/matchmaking', {
        method: 'POST',
        body: { timeControl, stakeCents: stake, ratingRange, acceptedTermsHash: quickQuote.data?.termsHash ?? undefined },
      });
      if (result.status === 'matched' && result.gameId) {
        toast.success('Match found', 'Opening your game.');
        navigate(`/game/${result.gameId}`);
      } else {
        setQueued({ ticketId: result.ticketId, timeControl });
        toast.info('You are in the queue', 'No opponent has been created. You will be redirected when another real account matches.');
      }
    } catch (error) { toast.error('Could not join the queue', errorMessage(error)); }
    finally { setBusy(false); }
  };

  const createChallenge = async () => {
    if (!user) { navigate('/auth?next=/play'); return; }
    if (createStake > 0 && (!createQuote.data?.allowed || !termsAccepted)) {
      toast.error('Accept the competition terms', 'Review the quote and confirm the exact terms before creating the challenge.');
      return;
    }
    setBusy(true);
    try {
      const result = await api<{ challenge: ChallengeView; inviteUrl: string | null }>('/challenges', {
        method: 'POST',
        body: {
          kind, opponentUsername: kind === 'direct' ? opponent : undefined,
          timeControl: createTimeControl, stakeCents: createStake, ratingRange,
          acceptedTermsHash: createQuote.data?.termsHash ?? undefined,
        },
      });
      setCreating(false);
      setInviteUrl(result.inviteUrl);
      toast.success('Challenge created', result.inviteUrl ? 'Share the private invitation to invite a real opponent.' : 'It now appears in the live lobby.');
      refetchAll();
    } catch (error) { toast.error('Could not create challenge', errorMessage(error)); }
    finally { setBusy(false); }
  };

  const acceptChallenge = async () => {
    if (!accepting) return;
    if (!user) { navigate(`/auth?next=${encodeURIComponent(`/challenge/${accepting.id}`)}`); return; }
    if (accepting.stakeCents > 0 && (!acceptQuote.data?.termsHash || !acceptTermsAccepted)) {
      toast.error('Accept the exact terms', 'Both players must accept identical hashed competition terms.');
      return;
    }
    setBusy(true);
    try {
      const result = await api<{ gameId: string }>(`/challenges/${accepting.id}/accept`, {
        method: 'POST',
        body: { acceptedTermsHash: acceptQuote.data?.termsHash ?? undefined },
      });
      toast.success('Challenge accepted', 'Opening the authoritative game board.');
      navigate(`/game/${result.gameId}`);
    } catch (error) { toast.error('Could not accept challenge', errorMessage(error)); }
    finally { setBusy(false); }
  };

  return (
    <div className="container">
      <PageHeader eyebrow="Live lobby" title="Play chess" description="Challenge a real signed-in player, join rating-aware matchmaking, or share a private invitation. No bots or simulated opponents are inserted into the lobby."
        actions={<button className="btn btn-primary" onClick={() => user ? setCreating(true) : navigate('/auth?next=/play')}><Icon name="play" size={17} /> Create challenge</button>} />

      <ModeChoiceCards compact />

      <div className="split">
        <div className="stack">
          <section className="card">
            <div className="card-header"><div><h2 className="card-title">Open challenges</h2><p className="card-subtitle">{challenges.data?.total ?? 0} live challenge{challenges.data?.total === 1 ? '' : 's'} from authenticated accounts.</p></div>
              <button className="btn btn-sm" onClick={() => void challenges.refetch()}><Icon name="analysis" size={15} /> Refresh</button></div>
            <div className="filter-bar">
              <label className="sr-only" htmlFor="challenge-search">Search by username</label>
              <input id="challenge-search" className="input" placeholder="Search player…" value={filters.search} onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))} />
              <label className="sr-only" htmlFor="challenge-time">Time control</label>
              <select id="challenge-time" className="select" value={filters.timeCategory} onChange={(e) => setFilters((f) => ({ ...f, timeCategory: e.target.value }))}>
                <option value="">All speeds</option>{['bullet', 'blitz', 'rapid', 'classical', 'custom'].map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <label className="sr-only" htmlFor="challenge-stake">Stake</label>
              <select id="challenge-stake" className="select" value={filters.stake} onChange={(e) => setFilters((f) => ({ ...f, stake: e.target.value }))}>
                <option value="">Any stake</option><option value="0">Free</option>{ALLOWED_STAKES_CENTS.map((s) => <option key={s} value={s}>{formatMoney(s)}</option>)}
              </select>
              <label className="sr-only" htmlFor="challenge-sort">Sort</label>
              <select id="challenge-sort" className="select" value={filters.sort} onChange={(e) => setFilters((f) => ({ ...f, sort: e.target.value }))}>
                <option value="newest">Newest</option><option value="stake">Highest stake</option><option value="rating">Creator rating</option><option value="expiry">Expiring soon</option>
              </select>
            </div>
            {challenges.isLoading && <div className="empty-state"><span className="loading" /> Loading live challenges…</div>}
            {challenges.error && <ErrorState message={errorMessage(challenges.error)} retry={() => void challenges.refetch()} />}
            {challenges.data?.items.length === 0 && <EmptyState title="No open challenges yet">Create one or join quick match. The lobby is updated in real time when another real account posts a challenge.</EmptyState>}
            <div className="stack">
              {challenges.data?.items.map((challenge) => (
                <article className="card challenge-card" key={challenge.id}>
                  <div className="min-w-0">
                    <div className="row-wrap"><strong>{challenge.creator.username}</strong><span className="pill">{challenge.creator.rating}</span><span className="pill pill-accent">{challenge.kind}</span></div>
                    <div className="challenge-meta" style={{ marginTop: '.5rem' }}>
                      <span className="pill"><Icon name="clock" size={13} /> {challenge.timeControl.category} · {Math.round(challenge.timeControl.baseMs / 60_000)}+{challenge.timeControl.incrementMs / 1000}</span>
                      <span className="pill">{challenge.stakeCents === 0 ? 'Free' : `${formatMoney(challenge.stakeCents)} stake`}</span>
                      <span className="pill">Rating {challenge.ratingMin}–{challenge.ratingMax}</span>
                      {challenge.opponent && <span className="pill">For {challenge.opponent.username}</span>}
                    </div>
                    <div className="tiny muted" style={{ marginTop: '.4rem' }}>Expires {new Date(challenge.expiresAt).toLocaleString()}</div>
                  </div>
                  <div className="row-wrap">
                    <Link className="btn btn-sm" to={`/challenge/${challenge.id}`}>Details</Link>
                    <button className="btn btn-sm btn-primary" onClick={() => { setAccepting(challenge); setAcceptTermsAccepted(false); }} disabled={!user || challenge.creator.id === user.id}>
                      {challenge.creator.id === user?.id ? 'Your challenge' : 'Accept'}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </div>

        <div className="sidebar">
          <section className="card">
            <div className="card-header"><div><h2 className="card-title">Quick match</h2><p className="card-subtitle">Rating-aware pairing with another real account.</p></div></div>
            <div className="stack">
              <TimeControlPicker value={timeControl} onChange={setTimeControl} />
              <StakePicker stake={stake} setStake={setStake} competitionsEnabled={competitionsEnabled} />
              <label className="field"><span className="field-label">Rating range ±{ratingRange}</span>
                <input className="input" type="range" min="50" max="1000" step="50" value={ratingRange} onChange={(e) => setRatingRange(Number(e.target.value))} /></label>
              {stake > 0 && quickQuote.data && <QuoteDisclosure quote={quickQuote.data} showAccept accepted={termsAccepted} onAccept={setTermsAccepted} />}
              {stake > 0 && quickQuote.isLoading && <span className="loading" />}
              {queued ? (
                <div className="alert alert-warning"><strong>Waiting in queue.</strong><div className="small">No opponent exists yet. Ticket {queued.ticketId.slice(0, 8)}. You will be redirected when a real player matches.</div>
                  <button className="btn btn-sm" style={{ marginTop: '.5rem' }} onClick={() => void api('/matchmaking', { method: 'DELETE' }).then(() => setQueued(null))}>Cancel queue</button></div>
              ) : (
                <button className="btn btn-primary btn-block" onClick={() => void quickMatch()} disabled={busy}>{busy ? <span className="loading" /> : <Icon name="play" size={16} />} Find a game</button>
              )}
              {!user && <p className="tiny muted" style={{ margin: 0 }}>Sign in to join matchmaking.</p>}
            </div>
          </section>
          <ProviderHealthCard compact />
        </div>
      </div>

      <Modal open={creating} onClose={() => setCreating(false)} title="Create a challenge" footer={<>
        <button className="btn" onClick={() => setCreating(false)}>Cancel</button>
        <button className="btn btn-primary" onClick={() => void createChallenge()} disabled={busy}>{busy ? <span className="loading" /> : 'Create challenge'}</button>
      </>}>
        <div className="stack">
          <div className="segmented" role="group" aria-label="Challenge visibility">
            {(['open', 'direct', 'private'] as const).map((value) => (
              <button key={value} type="button" aria-pressed={kind === value} onClick={() => setKind(value)}>{value}</button>
            ))}
          </div>
          {kind === 'direct' && <label className="field"><span className="field-label">Opponent username</span><input className="input" value={opponent} onChange={(e) => setOpponent(e.target.value)} placeholder="Exact username" /></label>}
          {kind === 'private' && <p className="small muted">A one-time shareable invitation URL will be generated. Only a signed-in invited player can accept it.</p>}
          <TimeControlPicker value={createTimeControl} onChange={setCreateTimeControl} />
          <StakePicker stake={createStake} setStake={setCreateStake} competitionsEnabled={competitionsEnabled} />
          {createStake > 0 && createQuote.data && <QuoteDisclosure quote={createQuote.data} showAccept accepted={termsAccepted} onAccept={setTermsAccepted} />}
        </div>
      </Modal>

      <Modal open={!!accepting} onClose={() => setAccepting(null)} title="Accept challenge" footer={<>
        <button className="btn" onClick={() => setAccepting(null)}>Cancel</button>
        <button className="btn btn-primary" onClick={() => void acceptChallenge()} disabled={busy}>{busy ? <span className="loading" /> : 'Accept and play'}</button>
      </>}>
        {accepting && <div className="stack">
          <p><strong>{accepting.creator.username}</strong> · {accepting.timeControl.category} · {accepting.stakeCents === 0 ? 'Free game' : `${formatMoney(accepting.stakeCents)} stake`}</p>
          {accepting.stakeCents > 0 && acceptQuote.data && <QuoteDisclosure quote={acceptQuote.data} showAccept accepted={acceptTermsAccepted} onAccept={setAcceptTermsAccepted} />}
          {accepting.stakeCents > 0 && acceptQuote.isLoading && <span className="loading" />}
          <label className="field"><span className="field-label">MFA code (if enabled on your account)</span>
            <input className="input mono" inputMode="numeric" value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} placeholder="Optional at login" /></label>
          <p className="tiny muted">MFA is verified at sign-in. Administrator actions require an additional per-action code.</p>
        </div>}
      </Modal>

      <Modal open={!!inviteUrl} onClose={() => setInviteUrl(null)} title="Private invitation ready" width={520} footer={<button className="btn btn-primary" onClick={() => setInviteUrl(null)}>Done</button>}>
        <p className="soft">Share this link with one other signed-in player. The server verifies the token before allowing acceptance.</p>
        <input className="input mono small" readOnly value={inviteUrl ?? ''} aria-label="Private invitation URL" />
        <button className="btn btn-sm" style={{ marginTop: '.5rem' }} onClick={() => void navigator.clipboard.writeText(inviteUrl ?? '').then(() => toast.success('Invitation copied'))}>Copy link</button>
      </Modal>
    </div>
  );
}
