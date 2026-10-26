import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { NotificationView, PlatformStatus } from '@shared/contracts';
import { api } from '../lib/api';
import { useAuth } from './AuthProvider';
import { usePreferences } from './ThemeProvider';
import { useSocket, useSocketEvent } from './SocketProvider';
import { Icon } from '../components/Icon';

const NAV = [
  { to: '/play', label: 'Play', icon: 'board' },
  { to: '/competitions', label: 'Competitions', icon: 'trophy' },
  { to: '/tournaments', label: 'Tournaments', icon: 'leaderboard' },
  { to: '/puzzles', label: 'Puzzles', icon: 'puzzle' },
  { to: '/learn', label: 'Learn', icon: 'book' },
  { to: '/train', label: 'Practice', icon: 'play' },
  { to: '/analysis', label: 'Analysis', icon: 'analysis' },
  { to: '/leaderboard', label: 'Leaderboard', icon: 'leaderboard' },
];

function StatusBanner() {
  const { data } = useQuery({ queryKey: ['platform-status'], queryFn: () => api<PlatformStatus>('/status'), staleTime: 60_000 });
  if (!data) return null;
  const message = data.mode === 'test'
    ? 'INTERNAL TEST MODE — test credits have no cash value and cannot be withdrawn.'
    : data.realMoneyEnabled
      ? 'AUTHORISED REAL MONEY MODE — 18+ verified players only. Read the competition rules before entering.'
      : 'Free chess mode — paid competitions and real-money deposits are disabled until legal, provider and age-verification approvals are complete.';
  return (
    <div className="status-banner">
      <div className="container status-banner-inner">
        <span className={`pill ${data.mode === 'test' ? 'pill-accent' : data.realMoneyEnabled ? 'pill-danger' : 'pill-teal'}`}>
          {data.mode === 'test' ? 'Internal test' : data.realMoneyEnabled ? 'Real money' : 'Free chess'}
        </span>
        <span>{message}</span>
        <Link to="/legal#compliance" className="small">Compliance details</Link>
      </div>
    </div>
  );
}

function Notifications() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data, refetch } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<{ items: NotificationView[]; unread: number }>('/notifications'),
    enabled: !!user,
    refetchInterval: 60_000,
  });
  useSocketEvent('notification:new', () => { void refetch(); void queryClient.invalidateQueries({ queryKey: ['wallet'] }); });
  if (!user) return null;
  const unread = data?.unread ?? 0;
  return (
    <div className="notification-menu">
      <button className="btn btn-icon btn-ghost" aria-label={`Notifications, ${unread} unread`} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name="bell" size={19} />{unread > 0 && <span className="badge" style={{ position: 'absolute', transform: 'translate(10px,-10px)' }}>{unread}</span>}
      </button>
      {open && (
        <div className="notification-popover" role="region" aria-label="Notifications">
          <div className="spread" style={{ padding: '.4rem' }}>
            <strong>Notifications</strong>
            <button className="btn btn-sm btn-ghost" onClick={() => void api('/notifications/read-all', { method: 'POST', body: {} }).then(() => refetch())}>Mark all read</button>
          </div>
          {!data?.items.length && <p className="small muted" style={{ padding: '.5rem' }}>No notifications yet.</p>}
          {data?.items.slice(0, 12).map((item) => (
            <div className={`notification-item ${item.readAt ? '' : 'unread'}`} key={item.id}>
              <div className="spread"><strong className="small">{item.title}</strong><span className="tiny muted">{new Date(item.createdAt).toLocaleDateString()}</span></div>
              <div className="small soft">{item.body}</div>
              {item.link && <Link className="tiny" to={item.link} onClick={() => setOpen(false)}>Open</Link>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Layout() {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = usePreferences();
  const { connectionState } = useSocket();
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [userMenu, setUserMenu] = useState(false);
  useEffect(() => { setMobileOpen(false); setUserMenu(false); window.scrollTo({ top: 0, behavior: 'auto' }); }, [location.pathname]);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <StatusBanner />
      <header className="site-header">
        <div className="container header-inner">
          <Link to="/" className="brand" aria-label="Rookstone Arena home">
            <span className="brand-mark" aria-hidden="true">♜</span>
            <span className="brand-text"><strong>Rookstone</strong><span>Arena</span></span>
          </Link>
          <nav className="main-nav" aria-label="Main navigation">
            {NAV.map((item) => <NavLink key={item.to} to={item.to} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
              <Icon name={item.icon} size={16} />{item.label}
            </NavLink>)}
          </nav>
          <div className="header-actions">
            <span className={`pill ${connectionState === 'connected' ? 'pill-success' : 'pill-danger'}`} title="Real-time connection">
              <span aria-hidden="true">●</span> {connectionState === 'connected' ? 'Live' : connectionState}
            </span>
            <button className="btn btn-icon btn-ghost" onClick={toggleTheme} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={19} />
            </button>
            <Notifications />
            {user ? (
              <div className="notification-menu">
                <button className="btn btn-sm" aria-expanded={userMenu} onClick={() => setUserMenu((v) => !v)}>
                  <span className="avatar" style={{ width: 24, height: 24, fontSize: '.7rem' }}>{user.username.slice(0, 1).toUpperCase()}</span>
                  <span className="btn-label">{user.username}</span>
                </button>
                {userMenu && (
                  <div className="notification-popover" style={{ width: 220 }}>
                    <Link className="nav-link" to={`/profile/${user.username}`}><Icon name="user" size={16} /> Profile</Link>
                    <Link className="nav-link" to="/history"><Icon name="clock" size={16} /> Game history</Link>
                    <Link className="nav-link" to="/wallet"><Icon name="wallet" size={16} /> Wallet</Link>
                    <Link className="nav-link" to="/settings"><Icon name="settings" size={16} /> Settings</Link>
                    {(user.role === 'agent' || user.role === 'admin') && <Link className="nav-link" to="/agent"><Icon name="wallet" size={16} /> Agent</Link>}
                    {user.role === 'admin' && <Link className="nav-link" to="/admin"><Icon name="shield" size={16} /> Admin</Link>}
                    <button className="nav-link" style={{ width: '100%', border: 0, background: 'transparent', textAlign: 'left' }}
                      onClick={() => void logout().then(() => navigate('/'))}>Log out</button>
                  </div>
                )}
              </div>
            ) : (
              <>
                <Link className="btn btn-ghost btn-sm" to="/auth">Sign in</Link>
                <Link className="btn btn-primary btn-sm" to="/auth?mode=register">Create account</Link>
              </>
            )}
            <button className="btn btn-icon btn-ghost mobile-nav-toggle" onClick={() => setMobileOpen((v) => !v)} aria-label="Toggle navigation" aria-expanded={mobileOpen}>
              <Icon name={mobileOpen ? 'close' : 'menu'} size={20} />
            </button>
          </div>
        </div>
        {mobileOpen && (
          <div className="container mobile-nav" aria-label="Mobile navigation">
            {NAV.map((item) => <NavLink key={item.to} to={item.to} className="nav-link"><Icon name={item.icon} size={16} />{item.label}</NavLink>)}
            <Link className="nav-link" to="/wallet"><Icon name="wallet" size={16} />Wallet</Link>
            <Link className="nav-link" to="/train"><Icon name="play" size={16} />Practice the engine</Link>
            <Link className="nav-link" to="/help"><Icon name="help" size={16} />Help</Link>
            {(user?.role === 'agent' || user?.role === 'admin') && <Link className="nav-link" to="/agent"><Icon name="wallet" size={16} />Agent</Link>}
            {user?.role === 'admin' && <Link className="nav-link" to="/admin"><Icon name="shield" size={16} />Admin</Link>}
          </div>
        )}
      </header>
      <main className="site-main" id="main-content"><Outlet /></main>
      <footer className="site-footer">
        <div className="container footer-grid">
          <div>
            <Link to="/" className="brand"><span className="brand-mark">♜</span><span className="brand-text"><strong>Rookstone</strong><span>Arena</span></span></Link>
            <p className="small muted" style={{ marginTop: '.75rem' }}>Original competitive chess with an authoritative server. No fake opponents, balances or engine evaluations.</p>
          </div>
          <div className="footer-links"><strong>Play</strong><Link to="/play">Lobby</Link><Link to="/competitions">Competitions</Link><Link to="/puzzles">Puzzles</Link><Link to="/train">Practice the engine</Link><Link to="/leaderboard">Leaderboard</Link></div>
          <div className="footer-links"><strong>Account</strong><Link to="/wallet">Wallet</Link><Link to="/history">History</Link><Link to="/settings">Settings</Link><Link to="/help">Help</Link></div>
          <div className="footer-links"><strong>Legal</strong><Link to="/legal#terms">Terms</Link><Link to="/legal#privacy">Privacy</Link><Link to="/legal#responsible">Responsible play</Link><Link to="/legal#compliance">Compliance</Link><Link to="/legal#licences">Licences</Link></div>
        </div>
        <div className="container small muted" style={{ marginTop: '1.5rem', borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>
          Rookstone Arena is a software implementation, not legal advice. Real-money competitions remain disabled until independently verified authorisation. Stockfish is GPL-3.0 licensed.
        </div>
      </footer>
    </div>
  );
}
