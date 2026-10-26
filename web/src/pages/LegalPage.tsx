import { Link } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';

const SECTIONS = [
  { id: 'terms', label: 'Terms of service' },
  { id: 'privacy', label: 'Privacy notice' },
  { id: 'cookies', label: 'Cookies & sessions' },
  { id: 'competition-rules', label: 'Competition rules' },
  { id: 'responsible', label: 'Responsible play' },
  { id: 'disputes', label: 'Disputes & fair play' },
  { id: 'compliance', label: 'Compliance & activation' },
  { id: 'licences', label: 'Third-party licences' },
];

export function LegalPage() {
  return (
    <div className="container-narrow">
      <PageHeader eyebrow="Legal" title="Policies &amp; compliance" description="Product policies for Rookstone Arena. These documents describe the software’s behaviour; they are not legal advice and do not grant a gaming licence." />
      <div className="alert alert-warning"><strong>Before public deployment:</strong> replace the operator identity, jurisdiction, support contact, privacy contact and regulator references in the deployment documentation. No legal entity or support address is invented in this template.</div>
      <nav className="card" aria-label="Legal sections" style={{ margin: '1rem 0' }}>
        <div className="row-wrap">{SECTIONS.map((section) => <a className="pill" key={section.id} href={`#${section.id}`}>{section.label}</a>)}</div>
      </nav>

      <div className="stack">
        <section className="card" id="terms">
          <h2>Terms of service</h2>
          <p className="small muted">Last updated: 26 October 2026. Operator: to be supplied by the deploying organisation.</p>
          <h3>1. Service</h3><p className="small soft">Rookstone Arena provides online chess, puzzles, learning material, an offline engine practice board, analysis, game history and optional competition features. Practice games against the engine are never rated, staked or stored server-side. Free chess is available without payment. Paid competitions are disabled unless the platform has independently verified authorisation and displays the active compliance status.</p>
          <h3>2. Eligibility</h3><p className="small soft">You must provide accurate registration details and comply with the law in your jurisdiction. Real-money competitions require provider-verified 18+ status, email verification, active account status and any additional operator checks. The service does not accept self-declared age as verification.</p>
          <h3>3. Accepted game rules</h3><p className="small soft">All games use standard chess rules as implemented by the authoritative server. The server records legal moves, clocks, results and ratings. Client-supplied results, balances, clocks and ratings are rejected. The full operational rules are in the <Link to="/help#rules">Help centre</Link>.</p>
          <h3>4. Prohibited conduct</h3><ul className="small soft"><li>Exploiting bugs, replaying messages, forging provider callbacks or bypassing rate limits.</li><li>Using another person’s account or payment instrument without authorisation.</li><li>Harassment in game chat, false disputes, chargeback fraud or money-laundering behaviour.</li><li>Circumventing self-exclusion or responsible-play controls.</li></ul>
          <h3>5. Suspension</h3><p className="small soft">An administrator may suspend an account for a documented reason. High-impact actions are recorded in immutable audit logs. Engine similarity alone does not trigger an automatic ban or confiscation.</p>
        </section>

        <section className="card" id="privacy">
          <h2>Privacy notice</h2>
          <h3>Data processed</h3><p className="small soft">The service stores account identifiers, email address, Argon2id password hash, username, display name, optional avatar/bio, session metadata, security events, games, moves, ratings, puzzles, notifications, disputes, responsible-play restrictions and financial ledger records. Provider callbacks are stored with their raw payload for reconciliation. Chat messages are ephemeral and not written to the database.</p>
          <h3>Purpose and legal basis</h3><p className="small soft">Data is used to authenticate users, operate games, prevent abuse, meet accounting/audit obligations, verify payments and provide player-requested features. A licensed operator must document the applicable legal basis in its jurisdiction before launch.</p>
          <h3>Sharing</h3><p className="small soft">Payment data is shared only with the selected approved provider for the purpose of verifying a transaction. Administrators see masked email addresses in user lists. Private player information is not exposed on public profiles or leaderboards.</p>
          <h3>Retention</h3><p className="small soft">Financial journals, audit logs and game records are retained because they are needed for dispute resolution, reconciliation and regulatory obligations. Posted ledger entries are immutable; corrections are separate compensating records. Sessions expire and can be revoked by the user.</p>
          <h3>Your controls</h3><p className="small soft">Users can update profile information, change passwords, revoke sessions, enable MFA, set responsible-play limits and download transaction statements from Settings and Wallet. A licensed operator must provide a verified privacy contact and data-subject request process before launch.</p>
        </section>

        <section className="card" id="cookies">
          <h2>Cookies &amp; sessions</h2>
          <p className="small soft">Two first-party cookies are used: <code>rs_session</code> (HttpOnly, random session token) and <code>rs_csrf</code> (readable by the frontend, used as a double-submit CSRF token). Both use SameSite=Lax and Secure in production. No advertising or third-party tracking cookies are set. Browser preferences for theme and board settings are stored in localStorage.</p>
        </section>

        <section className="card" id="competition-rules">
          <h2>Competition rules</h2>
          <p className="small soft">The default illustrative commission is 5% of the total pot, configurable only with an audited administrator reason. Money is stored as integer USD cents. Example: two $1.00 stakes create a $2.00 pot, a $0.10 fee and a $1.90 winner payout. Two $0.50 stakes create a $1.00 pot, a $0.05 fee and a $0.95 winner payout. Draws and voids refund both stakes with no commission.</p>
          <p className="small soft">Both players must accept identical hashed terms. Funds are reserved atomically before the game and released only by an idempotent server settlement. Unresolved disputes block automatic settlement. A posted payout is corrected only through a separate audited compensating journal.</p>
        </section>

        <section className="card" id="responsible">
          <h2>Responsible play</h2>
          <p className="small soft">Real-money competition is restricted to verified adults. Players may set daily deposit and stake limits from Settings, request self-exclusion, and review their real transaction history. Self-exclusion suspends the account, revokes active sessions and applies a 180-day cooling-off period in this implementation.</p>
          <p className="small soft">Competition should be entertainment, not income. Do not stake funds you cannot afford to lose. A licensed operator must publish local support resources, intervention procedures, affordability checks and complaint escalation before enabling real money.</p>
        </section>

        <section className="card" id="disputes">
          <h2>Disputes &amp; fair play</h2>
          <p className="small soft">A player may open a dispute from a game. While open, automatic settlement is blocked. An administrator reviews the persisted game, clock timeline, provider events and audit logs, then records a decision with notes. Engine-analysis signals are advisory and never constitute proof of cheating. No automatic ban, confiscation or rating penalty follows from engine similarity alone.</p>
        </section>

        <section className="card" id="compliance">
          <h2>Compliance &amp; activation</h2>
          <div className="alert alert-danger"><strong>Real-money mode is disabled by default.</strong> This software does not include legal authorisation, an operator licence, a payment-provider merchant approval, an age-verification provider contract or AML/KYC approval.</div>
          <p className="small soft">Activation requires all of the following, verified by independent humans and recorded in a signed activation manifest:</p>
          <ol className="small soft"><li>Written legal opinion covering the exact competition format in each target jurisdiction.</li><li>Current gaming law and regulator requirements. Relevant starting points include the <a href="https://lgb.co.zw/" target="_blank" rel="noreferrer">Lotteries and Gaming Board of Zimbabwe</a> and the <a href="https://www.law.co.zw/download/1762/" target="_blank" rel="noreferrer">Lotteries and Gaming Act [Chapter 10:26]</a>, including amendments and any remote-gaming regime in force at activation time.</li><li>Issued operator licence/permission reference and named compliance officer.</li><li>Written payment-provider approval for the specific wagering/competition use case, with sandbox and production credentials separated.</li><li>Approved 18+ identity/age verification integration and AML/KYC, sanctions, tax and responsible-play procedures.</li><li>Signed HMAC activation manifest, separate signing key stored outside application deployment credentials, plus environment flags confirming legal and provider verification.</li><li>Completed sandbox reconciliation, signed webhook, refund, reversal, dispute and restart-recovery tests.</li></ol>
          <p className="small soft">A single <code>OPERATING_MODE=real</code> flag cannot override these checks. The server requires the signed manifest, environment flags, provider health and age-verification configuration before real-money competitions can be created.</p>
        </section>

        <section className="card" id="licences">
          <h2>Third-party licences &amp; attribution</h2>
          <p className="small soft"><strong>Stockfish 19 Lite WASM</strong> is distributed under GPL-3.0-or-later. Upstream engine: <a href="https://github.com/official-stockfish/Stockfish" target="_blank" rel="noreferrer">official-stockfish/Stockfish</a>. WASM port: <a href="https://github.com/nmrugg/stockfish.js" target="_blank" rel="noreferrer">nmrugg/stockfish.js</a> npm package <code>stockfish@19.0.1</code>. The exact licence text is shipped at <code>/engine/stockfish-19-lite-single.js</code> header and in <code>docs/licenses/stockfish-GPL-3.0.txt</code>. The browser and server use the same genuine UCI engine; no evaluation is fabricated.</p>
          <p className="small soft"><strong>Chess piece SVGs</strong> are third-party artwork vendored into <code>web/public/pieces</code>: the Colin M. L. Burnett set (default), Merida by Armando Hernandez Marroquin (GPL-2.0-or-later), Chessnut by Alexis Luengas (Apache-2.0) and Celtic by Maurizio Monge (MIT). Each keeps its own licence and attribution — see <code>web/public/pieces/ATTRIBUTION.md</code>. The alternative vector set is provided by the MIT-licensed <code>react-chessboard</code> package.</p>
          <p className="small soft"><strong>Payment documentation</strong> used for adapter design: <a href="https://developers.paynow.co.zw/docs/paynow/initiate_transaction/" target="_blank" rel="noreferrer">Paynow</a>, <a href="https://developers.ecocash.co.zw/docs" target="_blank" rel="noreferrer">EcoCash</a>, and <a href="https://developers.pesepay.com/getting-started/overview/" target="_blank" rel="noreferrer">PesePay</a>. No provider relationship, approval or endpoint is implied beyond what the deploying operator verifies.</p>
        </section>
      </div>
    </div>
  );
}
