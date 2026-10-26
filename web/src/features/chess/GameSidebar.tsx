import { useMemo, useState } from 'react';
import { capturedPieces, formatMoney, formatClock, type GameSnapshot } from '@shared/contracts';
import { countryFlag, countryName, formatLocalDateTime } from '@shared/countries';
import { usePreferences, pieceSrc } from '../../app/ThemeProvider';
import { useToast } from '../../app/ToastProvider';
import { ConfirmDialog } from '../../components/Modal';
import { Icon } from '../../components/Icon';

interface ChatMessage { username: string; text: string; at: string }

interface GameSidebarProps {
  game: GameSnapshot;
  clocks: { white: number; black: number };
  replayPly: number | null;
  setReplayPly: (ply: number | null) => void;
  viewerId?: string | null;
  isSpectator: boolean;
  isMyTurn: boolean;
  pendingMove: boolean;
  connected: boolean;
  chat: ChatMessage[];
  onResign: () => Promise<void>;
  onOfferDraw: () => Promise<void>;
  onAnswerDraw: (accept: boolean) => Promise<void>;
  onClaimDraw: () => Promise<void>;
  onChat: (text: string) => Promise<void>;
  displayFen: string;
  replayMoves: string[];
}

function downloadText(filename: string, text: string, type = 'text/plain') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; anchor.click();
  URL.revokeObjectURL(url);
}

export function GameSidebar(props: GameSidebarProps) {
  const {
    game, clocks, replayPly, setReplayPly, isSpectator, isMyTurn, pendingMove,
    connected, chat, onResign, onOfferDraw, onAnswerDraw, onClaimDraw, onChat, displayFen, viewerId,
  } = props;
  const toast = useToast();
  const prefs = usePreferences();
  const viewerLocalTime = formatLocalDateTime(game.startedAt);
  const [confirm, setConfirm] = useState<'resign' | 'claim' | null>(null);
  const [chatText, setChatText] = useState('');
  const captures = useMemo(() => capturedPieces(displayFen), [displayFen]);
  const sideToMove = game.fen.split(' ')[1] === 'w' ? 'white' : 'black';
  const activePly = replayPly ?? game.moves.length;

  const copy = async (value: string, label: string) => {
    try { await navigator.clipboard.writeText(value); toast.success(`${label} copied`); }
    catch { toast.error('Clipboard unavailable', 'Select and copy the text manually.'); }
  };

  const resultLabel = game.result === 'draw' ? 'Draw'
    : game.result === 'white' ? 'White wins'
      : game.result === 'black' ? 'Black wins'
        : game.result === 'void' ? 'Game void — stakes refunded' : null;

  return (
    <aside className="sidebar" aria-label="Game information">
      <section className="card" aria-labelledby="players-title">
        <div className="card-header">
          <h2 className="card-title" id="players-title">Players</h2>
          <span className={`pill ${connected ? 'pill-success' : 'pill-danger'}`}>{connected ? 'Live' : 'Reconnecting'}</span>
        </div>
        <div className="stack" style={{ gap: '.5rem' }}>
          <div className="player-strip">
            <div className="player-name">
              <span className="avatar" aria-hidden="true">{game.black.username.slice(0, 1).toUpperCase()}</span>
              <div className="min-w-0">
                <strong>{game.black.username} {game.black.countryShared && <span title={countryName(game.black.country)} aria-label={countryName(game.black.country)}>{countryFlag(game.black.country)}</span>}</strong>
                <div className="tiny muted">Black · {game.black.rating} · {game.black.connected ? 'online' : 'offline'}{game.black.timezoneShared && game.black.timezone ? ` · local ${formatLocalDateTime(game.startedAt, game.black.timezone)}` : ''}</div>
              </div>
            </div>
            <div className={`clock ${sideToMove === 'black' && game.status === 'active' ? 'active' : ''} ${clocks.black < 20000 ? 'low' : ''}`} aria-label={`Black clock ${formatClock(clocks.black)}`}>
              {formatClock(clocks.black)}
            </div>
          </div>
          <div className="stack" style={{ gap: '.25rem' }}>
            <div className="captured" aria-label={`White captured ${captures.white.length} pieces`}>
              {captures.white.map((piece, index) => <img key={`${piece}-${index}`} src={pieceSrc(prefs.pieceTheme, piece)} alt="" />)}
            </div>
            <div className="player-strip">
              <div className="player-name">
                <span className="avatar" aria-hidden="true">{game.white.username.slice(0, 1).toUpperCase()}</span>
                <div className="min-w-0">
                  <strong>{game.white.username} {game.white.countryShared && <span title={countryName(game.white.country)} aria-label={countryName(game.white.country)}>{countryFlag(game.white.country)}</span>}</strong>
                  <div className="tiny muted">White · {game.white.rating} · {game.white.connected ? 'online' : 'offline'}{game.white.timezoneShared && game.white.timezone ? ` · local ${formatLocalDateTime(game.startedAt, game.white.timezone)}` : ''}</div>
                </div>
              </div>
              <div className={`clock ${sideToMove === 'white' && game.status === 'active' ? 'active' : ''} ${clocks.white < 20000 ? 'low' : ''}`} aria-label={`White clock ${formatClock(clocks.white)}`}>
                {formatClock(clocks.white)}
              </div>
            </div>
            <div className="captured" aria-label={`Black captured ${captures.black.length} pieces`}>
              {captures.black.map((piece, index) => <img key={`${piece}-${index}`} src={pieceSrc(prefs.pieceTheme, piece)} alt="" />)}
            </div>
          </div>
          <div className="small muted">
            {game.timeControl.category} · {Math.round(game.timeControl.baseMs / 60000)} min + {game.timeControl.incrementMs / 1000}s · server-authoritative clocks
            <div data-testid="viewer-local-time">Started (your local time): {viewerLocalTime}</div>
            <div className="tiny">Server UTC: {formatLocalDateTime(game.startedAt, 'UTC')} · opponent timezone shown only when shared</div>
          </div>
          {game.competition && (
            <div className="alert" style={{ padding: '.6rem .75rem' }}>
              <strong>Competition:</strong> {formatMoney(game.competition.stakeCents, game.competition.currency)} each ·
              pot {formatMoney(game.competition.potCents, game.competition.currency)} · fee {formatMoney(game.competition.feeCents, game.competition.currency)} ·
              winner {formatMoney(game.competition.payoutCents, game.competition.currency)}
              <div className="tiny muted">Draws and voids refund both stakes with no commission.</div>
            </div>
          )}
        </div>
      </section>

      <section className="card move-list-panel" aria-labelledby="moves-title">
        <div className="card-header">
          <h2 className="card-title" id="moves-title">Moves &amp; replay</h2>
          <span className="pill">Version {game.version}</span>
        </div>
        {resultLabel && <div className="alert alert-success" style={{ marginBottom: '.75rem' }}><strong>{resultLabel}</strong> · {game.termination}</div>}
        <div className="replay-controls" role="group" aria-label="Replay controls">
          <button className="btn btn-icon btn-sm" onClick={() => setReplayPly(0)} aria-label="Go to starting position"><Icon name="first" size={16} /></button>
          <button className="btn btn-icon btn-sm" onClick={() => setReplayPly(Math.max(0, activePly - 1))} aria-label="Previous move"><Icon name="arrowLeft" size={16} /></button>
          <button className="btn btn-icon btn-sm" onClick={() => setReplayPly(Math.min(game.moves.length, activePly + 1))} aria-label="Next move"><Icon name="arrowRight" size={16} /></button>
          <button className="btn btn-icon btn-sm" onClick={() => setReplayPly(game.moves.length)} aria-label="Go to last move"><Icon name="last" size={16} /></button>
          <button className="btn btn-sm" onClick={() => setReplayPly(null)} aria-pressed={replayPly === null}>Live</button>
        </div>
        <div className="move-list" style={{ marginTop: '.75rem' }}>
          {game.moves.length === 0 && <p className="small muted">No moves yet. The first move is waiting.</p>}
          {Array.from({ length: Math.ceil(game.moves.length / 2) }, (_, index) => (
            <div className="move-row" key={index}>
              <span className="move-number">{index + 1}.</span>
              {[0, 1].map((offset) => {
                const move = game.moves[index * 2 + offset];
                return move ? (
                  <button key={move.ply} className={`move-cell ${activePly === move.ply ? 'active' : ''}`}
                    onClick={() => setReplayPly(move.ply)} aria-label={`Replay to move ${move.ply}, ${move.san}`}>
                    {move.san}
                  </button>
                ) : <span className="move-cell" />;
              })}
            </div>
          ))}
        </div>
        <div className="row-wrap" style={{ marginTop: '.75rem' }}>
          <button className="btn btn-sm" onClick={() => void copy(game.pgn, 'PGN')}><Icon name="copy" size={15} /> PGN</button>
          <button className="btn btn-sm" onClick={() => downloadText(`rookstone-${game.id}.pgn`, game.pgn, 'application/x-chess-pgn')}><Icon name="download" size={15} /> Download</button>
          <button className="btn btn-sm" onClick={() => void copy(displayFen, 'FEN')}>FEN</button>
        </div>
        <details style={{ marginTop: '.75rem' }}>
          <summary className="small">Position strings</summary>
          <label className="field" style={{ marginTop: '.5rem' }}>
            <span className="field-label">PGN</span>
            <textarea className="textarea pgn-box" readOnly value={game.pgn} aria-label="Portable Game Notation" />
          </label>
          <label className="field">
            <span className="field-label">FEN</span>
            <input className="input mono small" readOnly value={displayFen} aria-label="Forsyth-Edwards Notation" />
          </label>
        </details>
      </section>

      {!isSpectator && (
        <section className="card" aria-labelledby="actions-title">
          <div className="card-header"><h2 className="card-title" id="actions-title">Game actions</h2></div>
          {game.drawOfferBy && game.drawOfferBy !== viewerId && (
            <div className="alert alert-warning">
              <strong>Draw offered.</strong>
              <div className="row-wrap" style={{ marginTop: '.5rem' }}>
                <button className="btn btn-sm btn-teal" onClick={() => void onAnswerDraw(true)}>Accept</button>
                <button className="btn btn-sm" onClick={() => void onAnswerDraw(false)}>Decline</button>
              </div>
            </div>
          )}
          {pendingMove && <div className="alert">Waiting for the authoritative server to accept your move…</div>}
          <div className="row-wrap">
            <button className="btn btn-sm" onClick={() => void onOfferDraw()} disabled={game.status !== 'active'}>Offer draw</button>
            <button className="btn btn-sm" onClick={() => setConfirm('claim')} disabled={game.status !== 'active'}>Claim draw</button>
            <button className="btn btn-sm btn-danger" onClick={() => setConfirm('resign')} disabled={game.status !== 'active'}>Resign</button>
          </div>
          <p className="tiny muted" style={{ marginBottom: 0, marginTop: '.6rem' }}>
            Draw claims require a real threefold repetition or fifty-move position. The server decides all terminal results.
          </p>
        </section>
      )}

      <section className="card" aria-labelledby="chat-title">
        <div className="card-header"><h2 className="card-title" id="chat-title">Game chat</h2></div>
        <div className="chat-box" role="log" aria-live="polite">
          {chat.length === 0 && <p className="small muted">No messages. Chat is visible to both players and is rate limited.</p>}
          {chat.map((message, index) => (
            <div className="chat-message" key={`${message.at}-${index}`}>
              <strong>{message.username}</strong> <span className="muted tiny">{new Date(message.at).toLocaleTimeString()}</span>
              <div>{message.text}</div>
            </div>
          ))}
        </div>
        {!isSpectator && (
          <form className="row" style={{ marginTop: '.5rem' }} onSubmit={(e) => {
            e.preventDefault();
            if (!chatText.trim()) return;
            void onChat(chatText.trim()).then(() => setChatText('')).catch(() => undefined);
          }}>
            <label className="sr-only" htmlFor="chat-input">Chat message</label>
            <input id="chat-input" className="input" value={chatText} maxLength={300} placeholder="Say good luck…" onChange={(e) => setChatText(e.target.value)} />
            <button className="btn btn-sm" type="submit" disabled={!connected || !chatText.trim()}>Send</button>
          </form>
        )}
      </section>

      <ConfirmDialog open={confirm === 'resign'} onClose={() => setConfirm(null)} onConfirm={async () => { await onResign(); setConfirm(null); }}
        title="Resign this game?" message="Resignation immediately ends the game. The authoritative server will record the result and settle any locked competition." confirmLabel="Resign" danger />
      <ConfirmDialog open={confirm === 'claim'} onClose={() => setConfirm(null)} onConfirm={async () => { await onClaimDraw(); setConfirm(null); }}
        title="Claim a draw?" message="The server will verify a genuine threefold repetition or fifty-move-rule position before ending the game." confirmLabel="Claim draw" />
    </aside>
  );
}
