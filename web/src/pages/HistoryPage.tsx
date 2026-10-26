import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, apiUrl, errorMessage } from '../lib/api';
import { PageHeader, EmptyState, ErrorState } from '../components/PageHeader';
import { Icon } from '../components/Icon';

interface HistoryRow {
  id: string; status: string; result: string | null; termination: string | null; mode: string;
  time_control: { category: string; baseMs: number; incrementMs: number };
  started_at: string; ended_at: string | null; white_id: string; black_id: string;
  white_name: string; black_name: string; played_white: boolean; outcome: string; pgn: string;
}

export function HistoryPage() {
  const [filters, setFilters] = useState({ result: '', timeCategory: '', opponent: '', from: '', mode: '' });
  const query = useMemo(() => {
    const params = new URLSearchParams({ limit: '100' });
    if (filters.timeCategory) params.set('timeCategory', filters.timeCategory);
    return params.toString();
  }, [filters.timeCategory]);
  const games = useQuery({ queryKey: ['game-history', query], queryFn: () => api<{ items: HistoryRow[] }>(`/games?${query}`) });
  const rows = useMemo(() => (games.data?.items ?? []).filter((game) => {
    if (filters.opponent) {
      const opponent = String(game.played_white ? game.black_name : game.white_name).toLowerCase();
      if (!opponent.includes(filters.opponent.toLowerCase())) return false;
    }
    if (filters.from && new Date(game.started_at) < new Date(filters.from)) return false;
    if (filters.mode && game.mode !== filters.mode) return false;
    if (filters.result === 'draw' && game.result !== 'draw') return false;
    if (filters.result === 'win' && game.outcome !== 'win') return false;
    if (filters.result === 'loss' && game.outcome !== 'loss') return false;
    return true;
  }), [games.data, filters]);
  const summary = useMemo(() => ({
    total: rows.length,
    wins: rows.filter((r) => r.outcome === 'win').length,
    losses: rows.filter((r) => r.outcome === 'loss').length,
    draws: rows.filter((r) => r.result === 'draw').length,
  }), [rows]);

  return (
    <div className="container">
      <PageHeader eyebrow="Archive" title="Game history" description="Search and replay your persisted games. Results, PGN and ratings come from the authoritative server — no local-only games are fabricated."
        actions={<Link className="btn btn-sm" to="/analysis"><Icon name="analysis" size={15} /> Open analysis board</Link>} />
      <div className="grid-4" style={{ marginBottom: '1.5rem' }}>
        <div className="card"><div className="stat-label">Games shown</div><div className="stat-value">{summary.total}</div></div>
        <div className="card"><div className="stat-label">Wins</div><div className="stat-value positive">{summary.wins}</div></div>
        <div className="card"><div className="stat-label">Losses</div><div className="stat-value negative">{summary.losses}</div></div>
        <div className="card"><div className="stat-label">Draws</div><div className="stat-value">{summary.draws}</div></div>
      </div>
      <section className="card">
        <div className="filter-bar">
          <input className="input" placeholder="Opponent username…" aria-label="Filter by opponent" value={filters.opponent} onChange={(e) => setFilters((f) => ({ ...f, opponent: e.target.value }))} />
          <select className="select" aria-label="Filter by outcome" value={filters.result} onChange={(e) => setFilters((f) => ({ ...f, result: e.target.value }))}>
            <option value="">All outcomes</option><option value="win">Wins</option><option value="loss">Losses</option><option value="draw">Draws</option>
          </select>
          <select className="select" aria-label="Filter by time control" value={filters.timeCategory} onChange={(e) => setFilters((f) => ({ ...f, timeCategory: e.target.value }))}>
            <option value="">All controls</option>{['bullet', 'blitz', 'rapid', 'classical', 'custom'].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select className="select" aria-label="Filter by mode" value={filters.mode} onChange={(e) => setFilters((f) => ({ ...f, mode: e.target.value }))}>
            <option value="">All modes</option><option value="free">Free</option><option value="test">Internal test</option><option value="real">Real money</option>
          </select>
          <input className="input" type="date" aria-label="From date" value={filters.from} onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} />
        </div>
        {games.isLoading && <div className="empty-state"><span className="loading" /> Loading persisted games…</div>}
        {games.error && <ErrorState message={errorMessage(games.error)} retry={() => void games.refetch()} />}
        {rows.length === 0 && <EmptyState title="No games match these filters">Play a real game or broaden the filters. No synthetic history is shown.</EmptyState>}
        {rows.length > 0 && <div className="table-wrap">
          <table className="table"><thead><tr><th>Date</th><th>Opponent</th><th>Colour</th><th>Control</th><th>Mode</th><th>Outcome</th><th>Termination</th><th>Replay</th><th>PGN</th></tr></thead>
            <tbody>{rows.map((game) => <tr key={game.id}>
              <td>{new Date(game.started_at).toLocaleString()}</td>
              <td>{String(game.played_white ? game.black_name : game.white_name)}</td>
              <td>{game.played_white ? 'White' : 'Black'}</td>
              <td>{game.time_control.category} · {Math.round(game.time_control.baseMs / 60000)}+{game.time_control.incrementMs / 1000}</td>
              <td><span className="pill">{game.mode}</span></td>
              <td><span className={`pill ${game.outcome === 'win' ? 'pill-success' : game.outcome === 'loss' ? 'pill-danger' : ''}`}>{game.outcome}</span></td>
              <td>{game.termination ?? game.status}</td>
              <td><Link to={`/game/${game.id}`}>Replay</Link></td>
              <td><a href={apiUrl(`/games/${game.id}/pgn`)}><Icon name="download" size={14} /> PGN</a></td>
            </tr>)}</tbody></table>
        </div>}
      </section>
    </div>
  );
}
