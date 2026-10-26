import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, errorMessage } from '../lib/api';
import { countryFlag, countryName, formatLocalDateTime } from '@shared/countries';
import { PageHeader, EmptyState, ErrorState } from '../components/PageHeader';
import { Icon } from '../components/Icon';

interface ProfileResponse {
  user: {
    id: string; username: string; displayName: string; rating: number; puzzleRating: number;
    gamesPlayed: number; wins: number; losses: number; draws: number; winPercentage: number;
    favouriteTimeControl: string | null; country: string; countryShared: boolean;
    timezone: string | null; timezoneShared: boolean; accountCurrency: string; memberSince: string;
    emailVerified: boolean; ageVerified: boolean;
    ratingHistory: Array<{ rating: number; at: string; delta: number }> | null;
  };
  recentGames: Array<Record<string, unknown>>;
  achievements: Array<{ id: string; title: string; earnedAt: string | null }>;
}

function RatingChart({ points }: { points: Array<{ rating: number; at: string }> }) {
  if (!points.length) return <div className="rating-chart" style={{ display: 'grid', placeItems: 'center', textAlign: 'center' }}><span className="small muted">No rating history yet. Finish a rated game to create the first point.</span></div>;
  const ratings = points.map((p) => p.rating);
  const min = Math.min(...ratings) - 20, max = Math.max(...ratings) + 20;
  const coords = points.map((point, index) => {
    const x = (index / Math.max(1, points.length - 1)) * 600;
    const y = 160 - ((point.rating - min) / Math.max(1, max - min)) * 140 - 10;
    return `${x},${y}`;
  }).join(' ');
  return (
    <svg className="rating-chart" viewBox="0 0 600 160" role="img" aria-label={`Rating history from ${points[0].rating} to ${points[points.length - 1].rating}`}>
      <line x1="0" y1="150" x2="600" y2="150" stroke="var(--border)" />
      <polyline points={coords} fill="none" stroke="var(--teal)" strokeWidth="3" />
      {points.map((point, index) => { const [x, y] = coords.split(' ')[index].split(','); return <circle key={point.at + index} cx={x} cy={y} r="3" fill="var(--accent)" />; })}
    </svg>
  );
}

export function ProfilePage() {
  const { username = '' } = useParams();
  const profile = useQuery({ queryKey: ['profile', username], queryFn: () => api<ProfileResponse>(`/users/${encodeURIComponent(username)}/profile`) });
  const games = useQuery({ queryKey: ['profile-games', username], queryFn: () => api<{ items: Array<Record<string, unknown>> }>(`/users/${encodeURIComponent(username)}/games?limit=50`) });
  const data = profile.data?.user;
  const history = useMemo(() => [...(data?.ratingHistory ?? [])].reverse(), [data?.ratingHistory]);

  return (
    <div className="container">
      <PageHeader eyebrow="Player profile" title={data?.displayName ?? username} description="Statistics are computed from persisted, server-adjudicated games and rating history. No placeholder achievements or fabricated win streaks."
        actions={<Link className="btn btn-sm" to="/leaderboard"><Icon name="leaderboard" size={15} /> Leaderboard</Link>} />
      {profile.isLoading && <div className="card"><span className="loading" /> Loading real player statistics…</div>}
      {profile.error && <ErrorState message={errorMessage(profile.error)} retry={() => void profile.refetch()} />}
      {data && <>
        <section className="card" style={{ marginBottom: '1.5rem' }}>
          <div className="spread" style={{ flexWrap: 'wrap' }}>
            <div className="row">
              <span className="avatar" style={{ width: 64, height: 64, fontSize: '1.8rem' }}>{data.username.slice(0, 1).toUpperCase()}</span>
              <div><h2 style={{ margin: 0 }}>@{data.username} {data.countryShared && <span title={countryName(data.country)}>{countryFlag(data.country)}</span>}</h2>
                <div className="small muted">Member since {formatLocalDateTime(data.memberSince)} · {data.countryShared ? countryName(data.country) : 'country not shared'} · {data.accountCurrency}</div>
                {data.timezoneShared && data.timezone && <div className="tiny muted">Opponents may see times in {data.timezone}</div>}
                <div className="row-wrap" style={{ marginTop: '.4rem' }}>
                  {data.emailVerified && <span className="pill pill-success">Email verified</span>}
                  {data.ageVerified && <span className="pill pill-teal">18+ verified</span>}
                  {!data.ageVerified && <span className="pill">Age not verified</span>}
                </div>
              </div>
            </div>
            <div className="stat"><div className="stat-label">Rating</div><div className="stat-value">{data.rating}</div><div className="stat-foot">{data.favouriteTimeControl ? `Favourite: ${data.favouriteTimeControl}` : 'No favourite time control yet'}</div></div>
          </div>
          <div className="stat-grid" style={{ marginTop: '1rem' }}>
            <div className="stat"><div className="stat-label">Games</div><div className="stat-value">{data.gamesPlayed}</div></div>
            <div className="stat"><div className="stat-label">Wins</div><div className="stat-value positive">{data.wins}</div></div>
            <div className="stat"><div className="stat-label">Losses</div><div className="stat-value negative">{data.losses}</div></div>
            <div className="stat"><div className="stat-label">Draws</div><div className="stat-value">{data.draws}</div></div>
            <div className="stat"><div className="stat-label">Win rate</div><div className="stat-value">{data.winPercentage}%</div></div>
            <div className="stat"><div className="stat-label">Puzzle rating</div><div className="stat-value">{data.puzzleRating}</div></div>
          </div>
        </section>

        <div className="split">
          <div className="stack">
            <section className="card">
              <div className="card-header"><h2 className="card-title">Rating history</h2><span className="pill">{history.length} persisted changes</span></div>
              <RatingChart points={history} />
            </section>
            <section className="card">
              <div className="card-header"><h2 className="card-title">Game history</h2><Link className="btn btn-sm" to="/history">Your full history</Link></div>
              {games.isLoading && <span className="loading" />}
              {games.error && <ErrorState message={errorMessage(games.error)} retry={() => void games.refetch()} />}
              {games.data?.items.length === 0 && <EmptyState title="No finished games yet">This player has no persisted game history.</EmptyState>}
              {!!games.data?.items.length && <div className="table-wrap">
                <table className="table"><thead><tr><th>Date</th><th>Opponent</th><th>Colour</th><th>Outcome</th><th>Control</th><th>Replay</th></tr></thead>
                  <tbody>{games.data.items.map((game) => <tr key={String(game.id)}>
                    <td>{new Date(String(game.started_at)).toLocaleDateString()}</td>
                    <td>{String(game.played_white ? game.black_name : game.white_name)}</td>
                    <td>{game.played_white ? 'White' : 'Black'}</td>
                    <td><span className={`pill ${game.outcome === 'win' ? 'pill-success' : game.outcome === 'loss' ? 'pill-danger' : ''}`}>{String(game.outcome)}</span></td>
                    <td>{String((game.time_control as { category?: string })?.category ?? '—')}</td>
                    <td><Link to={`/game/${String(game.id)}`}>Open</Link></td>
                  </tr>)}</tbody></table>
              </div>}
            </section>
          </div>
          <aside className="card">
            <div className="card-header"><h2 className="card-title">Achievements</h2><span className="pill">From persisted games</span></div>
            <div className="stack" style={{ gap: '.5rem' }}>
              {profile.data?.achievements.map((achievement) => <div className={`alert ${achievement.earnedAt ? 'alert-success' : ''}`} key={achievement.id}>
                <div className="spread"><strong>{achievement.title}</strong><Icon name={achievement.earnedAt ? 'check' : 'lock'} size={16} /></div>
                <div className="tiny muted">{achievement.earnedAt ? `Earned ${new Date(achievement.earnedAt).toLocaleDateString()}` : 'Not earned yet'}</div>
              </div>)}
            </div>
          </aside>
        </div>
      </>}
    </div>
  );
}
