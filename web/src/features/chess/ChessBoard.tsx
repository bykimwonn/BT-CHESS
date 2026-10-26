import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { Chess, type Square } from 'chess.js';
import { Chessboard, defaultPieces, type Arrow, type PieceRenderObject, type PieceDropHandlerArgs, type SquareHandlerArgs } from 'react-chessboard';
import { usePreferences } from '../../app/ThemeProvider';
import { Icon } from '../../components/Icon';

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const RANKS = ['1', '2', '3', '4', '5', '6', '7', '8'];
const PIECE_KEYS = ['wP', 'wN', 'wB', 'wR', 'wQ', 'wK', 'bP', 'bN', 'bB', 'bR', 'bQ', 'bK'];

const BOARD_COLORS = {
  forest: { light: '#e8dcc2', dark: '#7a9b8e' },
  slate: { light: '#d7dee7', dark: '#536a91' },
  walnut: { light: '#f0dfbd', dark: '#a97852' },
};

function pieceName(piece: string | undefined, square: string): string {
  if (!piece) return square;
  const names: Record<string, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
  const colour = piece === piece.toUpperCase() ? 'White' : 'Black';
  return `${square} ${colour} ${names[piece.toLowerCase()] ?? 'piece'}`;
}

export interface ChessBoardProps {
  fen: string;
  orientation?: 'white' | 'black';
  onMove?: (from: string, to: string, promotion?: string) => void | Promise<void>;
  onIllegal?: (reason: string) => void;
  disabled?: boolean;
  lastMove?: { from: string; to: string } | null;
  legalMoves?: string[];
  arrows?: Arrow[];
  allowArrows?: boolean;
  className?: string;
}

export function ChessBoard({
  fen, orientation = 'white', onMove, onIllegal, disabled = false,
  lastMove, legalMoves, arrows = [], allowArrows = true, className = '',
}: ChessBoardProps) {
  const prefs = usePreferences();
  const [selected, setSelected] = useState<string | null>(null);
  const [boardOrientation, setBoardOrientation] = useState<'white' | 'black'>(orientation);
  const [pendingPromotion, setPendingPromotion] = useState<{ from: string; to: string } | null>(null);
  const [keyboardMode, setKeyboardMode] = useState(false);
  const [manualFrom, setManualFrom] = useState('');
  const [manualTo, setManualTo] = useState('');
  const [focusSquare, setFocusSquare] = useState('e2');
  const focusRefs = useRef(new Map<string, HTMLButtonElement>());
  const promotionRef = useRef<HTMLButtonElement>(null);

  const chess = useMemo(() => {
    try { return new Chess(fen); } catch { return new Chess(); }
  }, [fen]);
  const turn = chess.turn();
  const localLegal = useMemo(() => chess.moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion ?? '')), [chess]);
  const allowed = legalMoves?.length ? legalMoves : localLegal;
  const colors = BOARD_COLORS[prefs.boardTheme];

  useEffect(() => { setSelected(null); setPendingPromotion(null); }, [fen]);
  useEffect(() => setBoardOrientation(orientation), [orientation]);
  useEffect(() => { if (pendingPromotion) promotionRef.current?.focus(); }, [pendingPromotion]);

  const pieces: PieceRenderObject = useMemo(() => {
    if (prefs.pieceTheme === 'staunton') return defaultPieces;
    return Object.fromEntries(PIECE_KEYS.map((key) => [
      key,
      () => <img className={`piece-image ${prefs.pieceTheme}`} src={`/pieces/${key}.svg`} alt="" draggable={false} />,
    ])) as PieceRenderObject;
  }, [prefs.pieceTheme]);

  const squareStyles = useMemo(() => {
    const styles: Record<string, CSSProperties> = {};
    if (lastMove) {
      const highlight = { backgroundColor: 'rgba(216, 180, 106, .38)' };
      styles[lastMove.from] = highlight;
      styles[lastMove.to] = highlight;
    }
    if (selected) styles[selected] = { ...(styles[selected] ?? {}), backgroundColor: 'rgba(216, 180, 106, .58)' };
    if (prefs.showLegalMoves && selected) {
      for (const move of allowed) {
        if (move.startsWith(selected) && move.length >= 4) {
          const target = move.slice(2, 4);
          styles[target] = {
            ...(styles[target] ?? {}),
            background: chess.get(target as Square)
              ? 'radial-gradient(circle, rgba(20,80,60,.62) 16%, transparent 18%)'
              : 'radial-gradient(circle, rgba(20,80,60,.42) 14%, transparent 16%)',
          };
        }
      }
    }
    if (chess.isCheck()) {
      const king = chess.board().flat().find((p) => p?.type === 'k' && p.color === chess.turn());
      if (king) styles[king.square] = { ...(styles[king.square] ?? {}), backgroundColor: 'rgba(255, 90, 90, .58)' };
    }
    return styles;
  }, [lastMove, selected, allowed, chess, prefs.showLegalMoves]);

  const isLegalPair = (from: string, to: string): boolean =>
    allowed.some((move) => move.startsWith(`${from}${to}`)) ||
    chess.moves({ square: from as Square, verbose: true }).some((m) => m.to === to);

  const needsPromotion = (from: string, to: string): boolean =>
    chess.get(from as Square)?.type === 'p' && (to.endsWith('8') || to.endsWith('1'));

  const attemptMove = (from: string, to: string) => {
    if (disabled || !onMove) return;
    if (!isLegalPair(from, to)) {
      onIllegal?.('That move is not legal in the current position.');
      return;
    }
    if (needsPromotion(from, to)) {
      setPendingPromotion({ from, to });
      return;
    }
    setSelected(null);
    void onMove(from, to);
  };

  const finishPromotion = (promotion: string) => {
    if (!pendingPromotion) return;
    void onMove?.(pendingPromotion.from, pendingPromotion.to, promotion);
    setPendingPromotion(null);
    setSelected(null);
  };

  const onSquareClick = ({ square, piece }: SquareHandlerArgs) => {
    if (disabled || !onMove || keyboardMode) return;
    if (!selected) {
      if (piece?.pieceType) setSelected(square);
      return;
    }
    if (selected === square) { setSelected(null); return; }
    attemptMove(selected, square);
  };

  const boardOptions = useMemo(() => ({
    id: `rookstone-${orientation}-${prefs.boardTheme}`,
    position: fen,
    boardOrientation,
    pieces,
    boardStyle: { borderRadius: '8px', boxShadow: 'inset 0 0 0 1px rgba(0,0,0,.25)' },
    darkSquareStyle: { backgroundColor: colors.dark },
    lightSquareStyle: { backgroundColor: colors.light },
    squareStyles,
    showNotation: prefs.showCoordinates,
    darkSquareNotationStyle: { color: 'rgba(255,255,255,.75)', fontSize: '11px', fontWeight: 700 },
    lightSquareNotationStyle: { color: 'rgba(20,32,51,.7)', fontSize: '11px', fontWeight: 700 },
    showAnimations: prefs.animations && !prefs.reducedMotion,
    animationDurationInMs: prefs.reducedMotion ? 0 : 180,
    allowDragging: !disabled && !keyboardMode && !!onMove,
    allowDragOffBoard: false,
    allowDrawingArrows: allowArrows && !disabled,
    arrows,
    clearArrowsOnClick: false,
    clearArrowsOnPositionChange: true,
    canDragPiece: ({ piece }: { piece: { pieceType?: string } }) => {
      if (disabled || !piece.pieceType) return false;
      const expected = turn === 'w' ? 'w' : 'b';
      return piece.pieceType.startsWith(expected);
    },
    onSquareClick,
    onPieceDrop: ({ sourceSquare, targetSquare }: PieceDropHandlerArgs) => {
      if (!targetSquare || !onMove || disabled) return false;
      if (!isLegalPair(sourceSquare, targetSquare)) { onIllegal?.('That move is not legal in the current position.'); return false; }
      attemptMove(sourceSquare, targetSquare);
      return true;
    },
  }), [fen, boardOrientation, pieces, colors, squareStyles, prefs.showCoordinates, prefs.animations, prefs.reducedMotion,
    disabled, keyboardMode, onMove, arrows, allowArrows, selected, turn]); // eslint-disable-line react-hooks/exhaustive-deps

  const orderedSquares = useMemo(() => {
    const files = boardOrientation === 'white' ? FILES : [...FILES].reverse();
    const ranks = boardOrientation === 'white' ? [...RANKS].reverse() : RANKS;
    return ranks.flatMap((rank) => files.map((file) => `${file}${rank}`));
  }, [boardOrientation]);

  const onKeyboardSquare = (event: KeyboardEvent<HTMLButtonElement>, square: string) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!selected) { setSelected(square); setManualFrom(square); }
      else if (selected === square) setSelected(null);
      else { setManualTo(square); attemptMove(selected, square); }
      return;
    }
    const index = orderedSquares.indexOf(square);
    let next = index;
    if (event.key === 'ArrowRight') next = Math.min(index + 1, orderedSquares.length - 1);
    else if (event.key === 'ArrowLeft') next = Math.max(index - 1, 0);
    else if (event.key === 'ArrowDown') next = Math.min(index + 8, orderedSquares.length - 1);
    else if (event.key === 'ArrowUp') next = Math.max(index - 8, 0);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = orderedSquares.length - 1;
    else return;
    event.preventDefault();
    const target = orderedSquares[next];
    setFocusSquare(target);
    focusRefs.current.get(target)?.focus();
  };

  const submitManualMove = () => {
    const from = manualFrom.trim().toLowerCase();
    const to = manualTo.trim().toLowerCase();
    if (!/^[a-h][1-8]$/.test(from) || !/^[a-h][1-8]$/.test(to)) {
      onIllegal?.('Enter squares such as e2 and e4.');
      return;
    }
    attemptMove(from, to);
    setManualTo('');
  };

  return (
    <div className={`board-shell ${className}`}>
      <div className="board-frame">
        <div className="board-container">
          <Chessboard options={boardOptions} />
        </div>
        {pendingPromotion && (
          <div className="promotion-overlay" role="presentation">
            <div className="promotion-dialog" role="dialog" aria-modal="true" aria-labelledby="promotion-title">
              <strong id="promotion-title">Choose promotion</strong>
              <div className="promotion-options">
                {(['q', 'r', 'b', 'n'] as const).map((piece, index) => (
                  <button key={piece} ref={index === 0 ? promotionRef : undefined}
                    className="promotion-option" onClick={() => finishPromotion(piece)}
                    aria-label={`Promote to ${({ q: 'queen', r: 'rook', b: 'bishop', n: 'knight' })[piece]}`}>
                    <img className="piece-image classic" src={`/pieces/${turn === 'w' ? 'w' : 'b'}${piece.toUpperCase()}.svg`} alt="" />
                  </button>
                ))}
              </div>
              <button className="btn btn-ghost btn-sm" style={{ marginTop: '.6rem' }} onClick={() => setPendingPromotion(null)}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      <div className="board-actions" aria-label="Board controls">
        <button className="btn btn-sm" onClick={() => setBoardOrientation((v) => v === 'white' ? 'black' : 'white')}>
          <Icon name="board" size={16} /> Flip board
        </button>
        <button className="btn btn-sm" aria-pressed={keyboardMode} onClick={() => setKeyboardMode((v) => !v)}>
          <Icon name="board" size={16} /> Keyboard mode
        </button>
        {keyboardMode && <span className="pill pill-teal">Arrow keys navigate · Enter selects</span>}
      </div>

      {keyboardMode && (
        <div className="stack" style={{ marginTop: '.75rem' }}>
          <div className="board-keyboard" role="group" aria-label="Keyboard chessboard. Use arrow keys to move between squares and Enter to select a piece or destination.">
            {orderedSquares.map((square) => {
              const piece = chess.get(square as Square);
              const light = (FILES.indexOf(square[0]) + Number(square[1])) % 2 === 0;
              const target = allowed.some((move) => move.startsWith(`${selected ?? ''}${square}`)) && selected !== square;
              return (
                <button key={square} ref={(node) => { if (node) focusRefs.current.set(square, node); }}
                  className={`key-square ${light ? 'light' : 'dark'} ${selected === square ? 'selected' : ''} ${target ? 'legal' : ''}`}
                  tabIndex={focusSquare === square ? 0 : -1}
                  aria-label={pieceName(piece?.type, square)}
                  aria-pressed={selected === square}
                  onFocus={() => setFocusSquare(square)}
                  onKeyDown={(event) => onKeyboardSquare(event, square)}
                  onClick={() => onSquareClick({ square, piece: piece ? { pieceType: `${piece.color}${piece.type.toUpperCase()}` } : null })}>
                  <span className="sr-only">{pieceName(piece?.type, square)}</span>
                  <span aria-hidden="true">{square}</span>
                </button>
              );
            })}
          </div>
          <div className="row-wrap" role="group" aria-label="Algebraic move entry">
            <label className="sr-only" htmlFor="move-from">From square</label>
            <input id="move-from" className="input" style={{ width: 90 }} placeholder="e2" value={manualFrom}
              onChange={(e) => setManualFrom(e.target.value)} maxLength={2} />
            <label className="sr-only" htmlFor="move-to">To square</label>
            <input id="move-to" className="input" style={{ width: 90 }} placeholder="e4" value={manualTo}
              onChange={(e) => setManualTo(e.target.value)} maxLength={2}
              onKeyDown={(e) => { if (e.key === 'Enter') submitManualMove(); }} />
            <button className="btn btn-sm" onClick={submitManualMove} disabled={disabled || !onMove}>Move</button>
            <span className="small muted">Example: e2 → e4</span>
          </div>
        </div>
      )}

      <div className="board-caption">
        <span>{prefs.showCoordinates ? 'Coordinates visible' : 'Coordinates hidden'} · {prefs.pieceTheme} pieces</span>
        <span>Stockfish 19 GPL engine available in Analysis</span>
      </div>
    </div>
  );
}
