import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Chess, type Square } from 'chess.js';
import { useQuery } from '@tanstack/react-query';
import type { PlatformStatus } from '@shared/contracts';
import { api } from '../lib/api';
import { ChessBoard } from '../features/chess/ChessBoard';
import { Icon } from '../components/Icon';
import { CompetitionRules } from '../components/Competition';
import { ModeChoiceCards } from '../components/ModeChoiceCards';

const DEMO_FEN = 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';

const FEATURES = [
  { icon: 'shield', title: 'Server-authoritative play', text: 'Chess rules, clocks, ratings, results and money live in PostgreSQL. The browser never decides a game.' },
  { icon: 'spark', title: 'Genuine Stockfish 19', text: 'A real GPL-licensed UCI WASM engine powers analysis. No invented evaluations or hardcoded best moves.' },
  { icon: 'trophy', title: 'Compliance-gated competitions', text: 'Double-entry USD-cent ledger, atomic reservations and exactly-once settlement. Real money stays off until approved.' },
  { icon: 'puzzle', title: 'Training that is real', text: 'Original composed puzzles, verified solutions, persisted ratings and move-quality summaries from actual games.' },
  { icon: 'user', title: 'Accessible by design', text: 'Keyboard move input, focus states, reduced-motion support, responsive layouts and readable dark/light themes.' },
  { icon: 'lock', title: 'Operator accountability', text: 'RBAC, MFA, immutable audit logs, dispute review and human-only sanctions before consequential decisions.' },
];

export function LandingPage() {
  const [fen, setFen] = useState(DEMO_FEN);
  const [history, setHistory] = useState<string[]>([]);
  const [message, setMessage] = useState('Try a legal move on this position.');
  const status = useQuery({ queryKey: ['platform-status'], queryFn: () => api<PlatformStatus>('/status'), staleTime: 60_000 });
  const legalMoves = useMemo(() => {
    try { return new Chess(fen).moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion ?? '')); } catch { return []; }
  }, [fen]);

  const onMove = (from: string, to: string, promotion?: string) => {
    const chess = new Chess(fen);
    const move = chess.move({ from: from as Square, to: to as Square, promotion });
    if (!move) { setMessage('That move is not legal here.'); return; }
    setHistory((h) => [...h, move.lan]);
    setFen(chess.fen());
    setMessage(`${move.san} — legal move accepted by chess.js.`);
  };

  return (
    <>
      <section className="container hero">
        <div className="hero-copy">
          <span className="eyebrow">Original competitive chess</span>
          <h1>Every move <span>accounted for.</span></h1>
          <p className="hero-lead">Rookstone Arena is a premium online chess arena built around an authoritative server, real-time play, genuine engine analysis and an auditable competition ledger.</p>
          <div className="hero-actions">
            <Link className="btn btn-primary" to="/play"><Icon name="play" size={17} /> Play free chess</Link>
            <Link className="btn" to="/analysis"><Icon name="analysis" size={17} /> Open analysis board</Link>
            <Link className="btn btn-ghost" to="/competitions">How competitions work</Link>
          </div>
          <div className="hero-proof">
            <span><Icon name="check" size={15} /> No simulated opponents</span>
            <span><Icon name="check" size={15} /> No fabricated balances</span>
            <span><Icon name="check" size={15} /> No fake engine output</span>
          </div>
          <div className="alert" style={{ marginTop: '1.5rem' }}>
            <strong>Current platform mode:</strong>{' '}
            {status.data?.mode === 'test' ? 'Internal test credits only.'
              : status.data?.realMoneyEnabled ? 'Authorised real-money mode.'
                : 'Free chess. Real-money competitions are disabled.'}{' '}
            <Link to="/legal#compliance">Read why</Link>.
          </div>
        </div>
        <div className="hero-board">
          <ChessBoard fen={fen} legalMoves={legalMoves} onMove={onMove} onIllegal={setMessage}
            lastMove={history.length ? { from: history[history.length - 1].slice(0, 2), to: history[history.length - 1].slice(2, 4) } : null} />
          <p className="text-center tiny muted" style={{ marginTop: '.75rem' }}>{message} <button className="btn btn-sm btn-ghost" onClick={() => { setFen(DEMO_FEN); setHistory([]); setMessage('Position reset.'); }}>Reset</button></p>
        </div>
      </section>

      <section className="container section" aria-label="Play mode selection">
        <div className="section-head">
          <div><span className="eyebrow">Your choice, every game</span><h2>Free chess or optional money matches</h2></div>
          <p>Free play never asks for a deposit. Money matches are separate, eligibility-checked and disabled until independently authorised.</p>
        </div>
        <ModeChoiceCards />
      </section>

      <section className="container section">
        <div className="section-head">
          <div><span className="eyebrow">Built for trust</span><h2>Architecture you can audit</h2></div>
          <p>Every critical state transition is persisted, versioned and verified on the server. This is a working system, not a mock payment or chess demo.</p>
        </div>
        <div className="feature-grid">
          {FEATURES.map((feature) => (
            <article className="card feature-card" key={feature.title}>
              <div className="feature-icon"><Icon name={feature.icon} size={22} /></div>
              <h3>{feature.title}</h3>
              <p className="small soft">{feature.text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="container section">
        <div className="split">
          <div>
            <span className="eyebrow">From lobby to ledger</span>
            <h2>One authoritative path</h2>
            <div className="timeline" style={{ marginTop: '1.25rem' }}>
              <div className="timeline-item"><strong>Create or accept a challenge</strong><p className="small soft">Open, direct and private invitations are validated against live accounts and rating ranges. Paid entries require identical hashed terms.</p></div>
              <div className="timeline-item"><strong>Play in real time</strong><p className="small soft">Socket.IO synchronises state. Reconnection restores the persisted game; stale versions and duplicate move nonces are rejected.</p></div>
              <div className="timeline-item"><strong>Finish and settle exactly once</strong><p className="small soft">The server determines checkmate, draws, resignation, timeout and abandonment. A balanced journal pays the winner or refunds both stakes.</p></div>
              <div className="timeline-item"><strong>Review, reconcile and export</strong><p className="small soft">Players get PGN, FEN, move-quality summaries, transaction history and CSV statements. Administrators get immutable audit logs.</p></div>
            </div>
          </div>
          <CompetitionRules />
        </div>
      </section>

      <section className="container section">
        <div className="card" style={{ background: 'linear-gradient(135deg, rgba(216,180,106,.12), rgba(127,209,193,.08))' }}>
          <div className="spread" style={{ flexWrap: 'wrap' }}>
            <div><span className="eyebrow">Ready when you are</span><h2 style={{ marginBottom: '.35rem' }}>Free chess works without real money.</h2><p className="soft" style={{ margin: 0 }}>Create an account, challenge another signed-in player, or explore puzzles and analysis immediately.</p></div>
            <div className="row-wrap"><Link className="btn btn-primary" to="/auth?mode=register">Create your account</Link><Link className="btn" to="/help">Read the rules</Link></div>
          </div>
        </div>
      </section>
    </>
  );
}
