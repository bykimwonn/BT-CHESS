import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { TIME_PRESETS, type TimeControl, type TournamentPairing, type TournamentStanding, type TournamentView } from '@shared/contracts';
import { countryFlag, formatLocalDateTime } from '@shared/countries';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../app/AuthProvider';
import { useToast } from '../app/ToastProvider';
import { PageHeader, EmptyState, ErrorState } from '../components/PageHeader';
import { Icon } from '../components/Icon';

interface TournamentDetail {
  tournament: TournamentView;
  standings: TournamentStanding[];
  pairings: TournamentPairing[];
}

export function TournamentsPage() {
  const { user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', category: 'blitz' as TimeControl['category'], maxPlayers: '16', rated: true });
  const [busy, setBusy] = useState(false);

  const list = useQuery({ queryKey: ['tournaments'], queryFn: () => api<{ items: TournamentView[] }>('/tournaments'), refetchInterval: 20_000 });
  const detail = useQuery({
    queryKey: ['tournament', selectedId],
    queryFn: () => api<TournamentDetail>(`/tournaments/${selectedId}`),
    enabled: !!selectedId,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['tournaments'] });
    if (selectedId) void queryClient.invalidateQueries({ queryKey: ['tournament', selectedId] });
  };

  const requireUser = () => {
    if (!user) { navigate('/auth?next=/tournaments'); return false; }
    return true;
  };

  const create = async () => {
    if (!requireUser()) return;
    if (form.name.trim().length < 3) { toast.error('Enter a tournament name'); return; }
    setBusy(true);
    try {
      const created = await api<TournamentView>('/tournaments', {
        method: 'POST',
        body: {
          name: form.name, timeControl: { ...TIME_PRESETS[form.category as Exclude<TimeControl['category'], 'custom'>] },
          maxPlayers: Number(form.maxPlayers), rated: form.rated,
        },
      });
      setSelectedId(created.id);
      setForm((f) => ({ ...f, name: '' }));
      toast.success('Tournament created', 'Share the page with international players. No payment is required.');
      invalidate();
    } catch (error) { toast.error('Could not create tournament', errorMessage(error)); }
    finally { setBusy(false); }
  };

  const act = async (path: string, success: string) => {
    if (!requireUser()) return;
    setBusy(true);
    try {
      await api(path, { method: 'POST', body: {} });
      toast.success(success);
      invalidate();
    } catch (error) { toast.error('Tournament action failed', errorMessage(error)); }
    finally { setBusy(false); }
  };

  const selected = detail.data?.tournament;
  const isDirector = !!selected && !!user && (selected.createdBy === user.id || user.role === 'admin');
  const joined = !!detail.data?.standings.some((s) => s.userId === user?.id);
  const activeRoundGames = detail.data?.pairings.filter((p) => p.roundNo === selected?.currentRound) ?? [];
  const roundFinished = activeRoundGames.length > 0 && activeRoundGames.every((p) => p.result !== null);

  return (
    <div className="container">
      <PageHeader eyebrow="International competition" title="Tournaments" description="Free, rated, server-paired tournaments for real entrants from any supported country. No entry fee, no fake participants and no dependency on payment providers."
        actions={<Link className="btn btn-sm" to="/play">Back to lobby</Link>} />

      <div className="split">
        <div className="stack">
          <section className="card">
            <div className="card-header"><h2 className="card-title">Open tournaments</h2><span className="pill">{list.data?.items.length ?? 0} real events</span></div>
            {list.isLoading && <div className="empty-state"><span className="loading" /> Loading tournaments…</div>}
            {list.error && <ErrorState message={errorMessage(list.error)} retry={() => void list.refetch()} />}
            {list.data?.items.length === 0 && <EmptyState title="No tournaments yet">Create one and invite real players. The server will pair actual entrants only.</EmptyState>}
            <div className="stack">
              {list.data?.items.map((item) => (
                <button key={item.id} className={`btn tournament-row ${selectedId === item.id ? 'btn-primary' : ''}`} onClick={() => setSelectedId(item.id)}>
                  <span className="grow" style={{ textAlign: 'left' }}>
                    <strong>{item.name}</strong>
                    <span className="tiny muted" style={{ display: 'block' }}>
                      {item.status} · {item.timeControl.category} · {item.entrants}/{item.maxPlayers} entrants · {item.rated ? 'rated' : 'casual'} · UTC {formatLocalDateTime(item.createdAt, 'UTC')}
                    </span>
                  </span>
                  <Icon name="arrowRight" size={16} />
                </button>
              ))}
            </div>
          </section>

          {selectedId && detail.data && <section className="card" data-testid="tournament-detail">
            <div className="card-header"><div><h2 className="card-title">{detail.data.tournament.name}</h2><p className="card-subtitle">Round {detail.data.tournament.currentRound} · started {formatLocalDateTime(detail.data.tournament.createdAt)} in your timezone</p></div>
              <span className="pill">{detail.data.tournament.status}</span></div>
            <div className="row-wrap" style={{ marginBottom: '1rem' }}>
              {detail.data.tournament.status === 'registration' && !joined && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void act(`/tournaments/${selectedId}/join`, 'Joined tournament')}>Join tournament</button>}
              {detail.data.tournament.status === 'registration' && joined && <span className="pill pill-teal">You are entered</span>}
              {isDirector && detail.data.tournament.status === 'registration' && <button className="btn btn-sm" disabled={busy || detail.data.tournament.entrants < 2} onClick={() => void act(`/tournaments/${selectedId}/start`, 'First round paired')}>Start & pair round 1</button>}
              {isDirector && detail.data.tournament.status === 'active' && <button className="btn btn-sm" disabled={busy || !roundFinished} onClick={() => void act(`/tournaments/${selectedId}/pair`, 'Next round paired')}>Pair next round</button>}
            </div>
            <div className="grid-2">
              <div>
                <h3>Standings</h3>
                {detail.data.standings.length === 0 && <p className="small muted">No entrants yet.</p>}
                <div className="table-wrap"><table className="table"><thead><tr><th>#</th><th>Player</th><th>Rating</th><th>Points</th></tr></thead>
                  <tbody>{detail.data.standings.map((standing) => <tr key={standing.userId}>
                    <td>{standing.rank}</td>
                    <td>{standing.countryShared ? `${countryFlag(standing.country)} ` : ''}<Link to={`/profile/${standing.username}`}>{standing.username}</Link></td>
                    <td>{standing.rating}</td><td><strong>{standing.points}</strong></td>
                  </tr>)}</tbody></table></div>
              </div>
              <div>
                <h3>Pairings</h3>
                {detail.data.pairings.length === 0 && <p className="small muted">No games have been paired yet.</p>}
                <div className="stack" style={{ gap: '.4rem' }}>
                  {detail.data.pairings.map((pairing) => <div className="alert" key={pairing.id} style={{ padding: '.6rem' }}>
                    <div className="spread"><strong>Round {pairing.roundNo} · board {pairing.boardNo}</strong><span className="pill">{pairing.result ?? 'live'}</span></div>
                    <div className="small">{pairing.whiteUsername} vs {pairing.blackUsername}</div>
                    {pairing.gameId && <Link className="tiny" to={`/game/${pairing.gameId}`}>Open game</Link>}
                  </div>)}
                </div>
              </div>
            </div>
          </section>}
        </div>

        <aside className="card">
          <h2 className="card-title">Create a free tournament</h2>
          <p className="small soft">Tournaments use the same authoritative rules, clocks and ratings as every other game.</p>
          <div className="stack">
            <label className="field"><span className="field-label">Name</span><input className="input" value={form.name} maxLength={80} placeholder="Global Blitz Open" onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></label>
            <label className="field"><span className="field-label">Time control</span>
              <select className="select" value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value as TimeControl['category'] }))}>
                {['bullet', 'blitz', 'rapid', 'classical'].map((c) => <option key={c} value={c}>{c} · {Math.round(TIME_PRESETS[c as Exclude<TimeControl['category'], 'custom'>].baseMs / 60000)}+{TIME_PRESETS[c as Exclude<TimeControl['category'], 'custom'>].incrementMs / 1000}</option>)}
              </select></label>
            <label className="field"><span className="field-label">Maximum players</span><input className="input" type="number" min="2" max="128" value={form.maxPlayers} onChange={(e) => setForm((f) => ({ ...f, maxPlayers: e.target.value }))} /></label>
            <label className="checkbox"><input type="checkbox" checked={form.rated} onChange={(e) => setForm((f) => ({ ...f, rated: e.target.checked }))} /> Rated games</label>
            <button className="btn btn-primary btn-block" disabled={busy || !user} onClick={() => void create()}>{user ? 'Create tournament' : 'Sign in to create'}</button>
          </div>
          <div className="alert" style={{ marginTop: '1rem' }}><strong>No payment required.</strong><div className="tiny muted">Tournament creation never creates a financial transaction or requires a local payment method.</div></div>
        </aside>
      </div>
    </div>
  );
}
