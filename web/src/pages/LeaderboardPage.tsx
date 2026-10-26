import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { LeaderboardEntry } from '@shared/contracts';
import { countryFlag, countryName } from '@shared/countries';
import { api, errorMessage } from '../lib/api';
import { PageHeader, EmptyState, ErrorState } from '../components/PageHeader';
import { Icon } from '../components/Icon';

export function LeaderboardPage() {
  const leaderboard = useQuery({
    queryKey: ['leaderboard'],
    queryFn: () => api<{ items: LeaderboardEntry[] }>('/leaderboard?limit=100'),
    refetchInterval: 60_000,
  });
  return (
    <div className="container">
      <PageHeader eyebrow="Ratings" title="Leaderboard" description="Ratings and records are calculated from persisted, finished, server-adjudicated games. Accounts with no completed games do not appear." />
      <section className="card">
        {leaderboard.isLoading && <div className="empty-state"><span className="loading" /> Loading real player records…</div>}
        {leaderboard.error && <ErrorState message={errorMessage(leaderboard.error)} retry={() => void leaderboard.refetch()} />}
        {leaderboard.data?.items.length === 0 && <EmptyState title="No rated games have finished yet">Play a game against another real account to create the first leaderboard entry.</EmptyState>}
        {!!leaderboard.data?.items.length && <div className="table-wrap">
          <table className="table">
            <thead><tr><th>#</th><th>Player</th><th>Rating</th><th>Games</th><th>W</th><th>L</th><th>D</th><th>Record</th></tr></thead>
            <tbody>{leaderboard.data.items.map((entry) => (
              <tr key={entry.userId}>
                <td><strong>{entry.rank}</strong></td>
                <td><Link to={`/profile/${entry.username}`}><Icon name="user" size={14} /> {entry.displayName} <span className="muted">@{entry.username}</span></Link>
                  {entry.countryShared && <span title={countryName(entry.country)}> {countryFlag(entry.country)}</span>}</td>
                <td><strong>{entry.rating}</strong></td><td>{entry.gamesPlayed}</td><td className="positive">{entry.wins}</td><td className="negative">{entry.losses}</td><td>{entry.draws}</td>
                <td>{entry.gamesPlayed ? `${Math.round((entry.wins / entry.gamesPlayed) * 100)}%` : '—'}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>}
      </section>
      <div className="grid-3" style={{ marginTop: '1.5rem' }}>
        <div className="card"><h3><Icon name="shield" size={17} /> Authoritative ratings</h3><p className="small soft">The server applies an Elo update after each decisive or drawn result and stores the full rating history.</p></div>
        <div className="card"><h3><Icon name="clock" size={17} /> All time controls</h3><p className="small soft">This view combines rated bullet, blitz, rapid, classical and custom games. Free chess and internal test games are included; voids are not.</p></div>
        <div className="card"><h3><Icon name="analysis" size={17} /> No fake activity</h3><p className="small soft">No bots, placeholder accounts or invented statistics are inserted to make the table look busy.</p></div>
      </div>
    </div>
  );
}
