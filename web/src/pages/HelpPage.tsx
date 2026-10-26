import { Link } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { Icon } from '../components/Icon';

const FAQS = [
  { q: 'Is real money enabled?', a: 'Not by default. Free chess works independently. Paid competitions require a signed compliance activation manifest, verified legal authorisation, operator licensing, provider merchant approval, 18+ verification, AML/KYC controls and production provider credentials. A configuration flag alone is not enough.' },
  { q: 'How are games decided?', a: 'The server uses chess.js for legal moves and detects checkmate, stalemate, insufficient material, claimable threefold repetition and the fifty-move rule, resignation, agreed draws, timeout and abandonment. Clients never submit results, clocks or ratings.' },
  { q: 'What happens if I disconnect?', a: 'Your game remains persisted. Reconnect to restore the authoritative state. A one-sided disconnection starts a 90-second abandonment deadline; the connected player may win if the opponent does not return. If neither player returns, the game is voided and stakes are refunded. Server restarts pause clocks after a short recovery window rather than allowing downtime to drain them.' },
  { q: 'Can I claim a draw?', a: 'Yes, when the actual position has a threefold repetition or the fifty-move rule is available. The server verifies the claim; it does not trust a client-side button alone.' },
  { q: 'How is a winner paid?', a: 'Both stakes are reserved atomically before the game. A decisive result releases the pot minus the configured commission to the winner. A draw or void refunds each stake with no commission. Posted ledger entries are immutable; corrections use separate audited journals.' },
  { q: 'Why does my deposit still say pending?', a: 'A browser redirect is never proof of payment. The server verifies the outcome with the provider API, checks amount and currency, and only then posts a deposit journal. Use “Verify status” on the Wallet page or wait for the reconciliation job.' },
  { q: 'Can I practise against the engine?', a: 'Yes. Open Practice and choose one of eight strengths. The opponent is the same GPL-licensed Stockfish 19 WebAssembly build used by the analysis board, running entirely in your browser. Lower levels use the engine Skill Level option and, at the three easiest settings, deliberate random legal moves so the game feels human. Practice games are never rated, staked, submitted to the server or recorded against your account, and Hint or Review last move always search at full strength.' },
  { q: 'Is engine analysis used to ban players?', a: 'No automatic ban or confiscation is imposed solely because moves resemble engine suggestions. Engine similarity creates a review signal only; a human administrator must review the case and record a decision.' },
  { q: 'Which payment providers are supported?', a: 'The codebase contains server-side adapters for Paynow, EcoCash and PesePay based on their published documentation, plus an explicit disabled OneMoney adapter because no verified public direct merchant API contract was available. All are disabled until credentials and merchant approval are supplied. OneMoney may be available through an approved aggregator.' },
  { q: 'How do I reset my password?', a: 'Use Forgot password on the sign-in page. A one-time, expiring token is sent by SMTP. If SMTP is not configured, production password recovery is unavailable; local development exposes the token only in development responses, never as a delivered email.' },
  { q: 'What data is stored?', a: 'Accounts, sessions, games, moves, ratings, puzzles, notifications, disputes, audit logs, provider events and financial journals are stored in PostgreSQL. Chat messages are ephemeral and limited to the current server process. See the Privacy notice for details.' },
];

export function HelpPage() {
  return (
    <div className="container-narrow">
      <PageHeader eyebrow="Support" title="Help centre" description="Concrete rules, honest limitations and the exact behaviour implemented by the server." />
      <div className="stack">
        <section className="card">
          <h2 className="card-title"><Icon name="help" size={18} /> Frequently asked questions</h2>
          <div className="stack">{FAQS.map((faq) => <details key={faq.q} style={{ borderBottom: '1px solid var(--border)', padding: '.6rem 0' }}>
            <summary style={{ cursor: 'pointer', fontWeight: 750 }}>{faq.q}</summary>
            <p className="small soft" style={{ margin: '.5rem 0 0' }}>{faq.a}</p>
          </details>)}</div>
        </section>

        <section className="card" id="rules">
          <h2 className="card-title">Published game rules</h2>
          <div className="grid-2">
            <div><h3>Practice</h3><ul className="small soft"><li>Practice games are offline and unrated; they never touch the wallet or the leaderboard.</li><li>Strength is an anchor for choosing an opponent, not a rating claim.</li><li>Takeback, Hint and Review last move are coaching tools, not part of a rated game.</li></ul>
              <h3>Clocks</h3><ul className="small soft"><li>Presets: bullet 1+1, blitz 3+2, rapid 10+5, classical 30+10.</li><li>Custom games allow 30 seconds to 120 minutes with 0–60 second increment.</li><li>Increment is added when the move is accepted by the server.</li></ul>
              <h3>Terminal results</h3><ul className="small soft"><li>Checkmate, stalemate and insufficient material are automatic.</li><li>Threefold repetition and the fifty-move rule require a claim.</li><li>Timeout gives the opponent a win unless they lack mating material.</li></ul></div>
            <div><h3>Ratings (FIDE rules)</h3><ul className="small soft">
                <li>Ratings use the FIDE Rating Regulations (Handbook B.02): K = 40 until 30 rated games, K = 20 under 2400, K = 10 once a published rating has reached 2400.</li>
                <li>Juniors keep K = 40 below 2300 until the end of the year of their 18th birthday, when a year of birth is on file.</li>
                <li>A gap over 400 points counts as 400 below 2650; from 2650 the true gap is used. K × games per month is capped at 700.</li>
                <li>Changes round to the nearest whole point (.5 away from zero). The lowest rating is 1400 and new accounts start at 1500.</li>
              </ul>
              <h3>Integrity</h3><ul className="small soft"><li>Every move carries a unique client nonce and expected state version.</li><li>Stale versions, duplicate nonces, out-of-turn moves and illegal moves are rejected.</li><li>Ratings and statistics are updated only from persisted finished games.</li></ul>
              <h3>Disputes</h3><ul className="small soft"><li>Open a dispute from a game. Unresolved disputes block settlement.</li><li>Administrators can reject, keep under review, or void with an audited compensating correction.</li><li>No client can submit a custom winner or result.</li></ul></div>
          </div>
        </section>

        <section className="card" id="disputes">
          <h2 className="card-title">Dispute &amp; fair-play workflow</h2>
          <ol className="small soft"><li>Open a dispute with a reason and details from the game page.</li><li>The game status and settlement are blocked while the dispute is open.</li><li>An administrator reviews the persisted moves, clocks, provider events and audit logs.</li><li>The administrator records a decision and notes; high-impact actions require confirmation and MFA in production.</li><li>A posted payout is never silently edited. A void after payout creates a separate compensating journal and a settlement correction record.</li></ol>
          <p className="small muted">Engine-analysis signals are advisory. No automatic ban, confiscation or rating penalty follows from engine similarity alone.</p>
        </section>

        <section className="card" id="accessibility">
          <h2 className="card-title">Accessibility &amp; keyboard controls</h2>
          <div className="grid-2">
            <div><h3>Board</h3><ul className="small soft"><li>Enable “Keyboard mode” below the board.</li><li>Use arrow keys to move between squares; Home/End jump to the first/last square.</li><li>Enter or Space selects a piece or destination.</li><li>Alternatively type from/to squares (for example e2 and e4) and press Move.</li></ul></div>
            <div><h3>Display</h3><ul className="small soft"><li>Dark and light themes with high-contrast focus outlines.</li><li>Coordinates, legal-move hints and piece animations can be toggled.</li><li><code>prefers-reduced-motion</code> disables animations automatically.</li><li>Layouts reflow to one column on small screens without horizontal overflow.</li></ul></div>
          </div>
        </section>

        <section className="card" id="limitations">
          <h2 className="card-title">Honest deployment limitations</h2>
          <ul className="small soft">
            <li>This repository contains no live provider credentials, legal authorisation or regulator approval. Real-money mode is intentionally disabled.</li>
            <li>SMTP must be configured to deliver password reset and verification emails. The server never claims an undelivered email was sent.</li>
            <li>OneMoney direct API integration is disabled until an official merchant API contract is supplied; use an approved aggregator instead.</li>
            <li>Provider sandbox transactions create clearly labelled test credits. They are not real deposits and cannot be withdrawn.</li>
            <li>Operator contact details, legal entity and jurisdiction must be supplied in the deployment configuration before public launch.</li>
          </ul>
          <div className="row-wrap"><Link className="btn btn-sm" to="/legal#compliance">Compliance policy</Link><Link className="btn btn-sm" to="/legal#licences">Third-party licences</Link><Link className="btn btn-sm" to="/settings">Security settings</Link></div>
        </section>
      </div>
    </div>
  );
}
