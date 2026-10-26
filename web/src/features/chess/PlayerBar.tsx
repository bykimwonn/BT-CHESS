import { formatClock, type GameStatus, type PlayerSeat } from '@shared/contracts';
import { countryFlag, countryName } from '@shared/countries';
import { pieceSrc, usePreferences } from '../../app/ThemeProvider';

export interface PlayerBarProps {
  seat: PlayerSeat;
  /** Which colour this seat plays; drives the aria label and ordering. */
  color: 'white' | 'black';
  clockMs: number;
  /** True while it is this side's turn in a live game. */
  active: boolean;
  status: GameStatus;
  /** The viewer's own seat gets a quiet "You" marker. */
  isViewer: boolean;
  /** Pieces this player has taken from the opponent, already in display order. */
  captured: string[];
  /** Mirrors the board, so the name plate stays on the same edge as the pieces. */
  onFlip?: () => void;
}

/**
 * One player's name plate, placed above (opponent) and below (you) the board.
 * Shows the FIDE rating, clock, connection and captures — nothing else.
 */
export function PlayerBar({ seat, color, clockMs, active, status, isViewer, captured }: PlayerBarProps) {
  const prefs = usePreferences();
  const live = active && status === 'active';
  return (
    <div className={`player-bar ${live ? 'active' : ''}`} data-side={color}>
      <span className="avatar" aria-hidden="true">{seat.username.slice(0, 1).toUpperCase()}</span>
      <div className="player-info">
        <div className="player-line">
          <strong title={seat.username}>{seat.username}</strong>
          {seat.countryShared && seat.country && (
            <span className="player-flag" title={countryName(seat.country)} aria-label={countryName(seat.country)}>
              {countryFlag(seat.country)}
            </span>
          )}
          <span className="player-rating" title={`FIDE rating ${seat.rating}`} aria-label={`FIDE rating ${seat.rating}`}>
            {seat.rating}
          </span>
          {isViewer && <span className="player-you">You</span>}
        </div>
        <div className="player-sub">
          <span className={`status-dot ${seat.connected ? 'on' : ''}`} aria-hidden="true" />
          <span className="tiny muted">{seat.connected ? 'online' : 'offline'}</span>
          {captured.length > 0 && (
            <span className="captured" aria-label={`${captured.length} pieces captured`}>
              {captured.map((piece, index) => (
                <img key={`${piece}-${index}`} src={pieceSrc(prefs.pieceTheme, piece)} alt="" draggable={false} />
              ))}
            </span>
          )}
        </div>
      </div>
      <div className={`clock ${live ? 'active' : ''} ${clockMs < 20_000 ? 'low' : ''}`}
        aria-label={`${color} clock ${formatClock(clockMs)}`}>
        {formatClock(clockMs)}
      </div>
    </div>
  );
}
