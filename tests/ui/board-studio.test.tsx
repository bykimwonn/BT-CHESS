import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  BOARD_THEMES, PIECE_THEMES, pieceSetFolder, pieceSrc, resolveBoardTheme, resolvePieceTheme,
} from '../../web/src/app/ThemeProvider';
import { BoardsPage } from '../../web/src/pages/BoardsPage';
import { ThemeProvider } from '../../web/src/app/ThemeProvider';
import { ToastProvider } from '../../web/src/app/ToastProvider';
import { ChessBoard } from '../../web/src/features/chess/ChessBoard';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function renderStudio() {
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <ToastProvider>
          <BoardsPage />
        </ToastProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

describe('board studio', () => {
  it('offers five board palettes and six piece sets, each with its licence', () => {
    expect(BOARD_THEMES.map((theme) => theme.id)).toEqual(['green', 'brown', 'blue', 'midnight', 'wood']);
    expect(PIECE_THEMES.map((theme) => theme.id)).toEqual(['chesscom', 'merida', 'chessnut', 'celtic', 'meridian', 'staunton']);
    for (const theme of BOARD_THEMES) {
      expect(theme.light).toMatch(/^#[0-9a-f]{6}$/i);
      expect(theme.dark).toMatch(/^#[0-9a-f]{6}$/i);
      expect(theme.light).not.toBe(theme.dark);
      expect(theme.note.length).toBeGreaterThan(10);
    }
    for (const theme of PIECE_THEMES) {
      expect(theme.attribution, `${theme.id} must name its licence holder`).toBeTruthy();
      expect(theme.note.length).toBeGreaterThan(10);
    }
  });

  it('maps each piece set to its own folder, with the default staying at the root', () => {
    expect(pieceSrc('chesscom', 'wK')).toBe('/pieces/wK.svg');
    expect(pieceSrc('meridian', 'bQ')).toBe('/pieces/bQ.svg');
    expect(pieceSrc('merida', 'wK')).toBe('/pieces/merida/wK.svg');
    expect(pieceSrc('chessnut', 'bN')).toBe('/pieces/chessnut/bN.svg');
    expect(pieceSrc('celtic', 'wP')).toBe('/pieces/celtic/wP.svg');
    expect(pieceSetFolder('staunton')).toBe('');
    expect(pieceSetFolder('merida')).toBe('merida/');
  });

  it('accepts every shipped id and keeps legacy ids working', () => {
    for (const theme of BOARD_THEMES) expect(resolveBoardTheme(theme.id)).toBe(theme.id);
    for (const theme of PIECE_THEMES) expect(resolvePieceTheme(theme.id)).toBe(theme.id);
    expect(resolveBoardTheme('forest')).toBe('green');
    expect(resolvePieceTheme('classic')).toBe('chesscom');
    expect(resolveBoardTheme('neon')).toBe('green');
    expect(resolvePieceTheme('unknown')).toBe('chesscom');
  });

  it('applies a chosen palette and piece set to the live board', () => {
    renderStudio();
    fireEvent.click(screen.getByRole('button', { name: /Midnight gold/i }));
    fireEvent.click(screen.getByRole('button', { name: /Merida/i }));
    const images = [...document.querySelectorAll('.board-container img')] as HTMLImageElement[];
    expect(images.length).toBeGreaterThanOrEqual(32);
    expect(images.every((image) => /^\/pieces\/merida\/[wb][KQRBNP]\.svg$/.test(image.getAttribute('src') ?? ''))).toBe(true);
    // The palette reaches the rendered squares, not just the picker.
    const squares = [...document.querySelectorAll('.board-container [data-square]')] as HTMLElement[];
    const styled = squares.filter((square) => (square.getAttribute('style') ?? '').includes('45, 44, 42') || (square.getAttribute('style') ?? '').includes('201, 169, 92'));
    expect(styled.length).toBeGreaterThan(0);
  });

  it('marks the current choice for assistive technology', () => {
    renderStudio();
    const groups = screen.getAllByRole('group');
    const pieceGroup = groups.find((group) => group.getAttribute('aria-label') === 'Piece set');
    expect(pieceGroup).toBeTruthy();
    const pressed = within(pieceGroup as HTMLElement).getAllByRole('button').filter((button) => button.getAttribute('aria-pressed') === 'true');
    expect(pressed).toHaveLength(1);
    expect(pressed[0].textContent).toContain('Classic Staunton');
  });

  it('uses the selected piece set inside the board component itself', () => {
    localStorage.setItem('rookstone.preferences.v1', JSON.stringify({ pieceTheme: 'celtic', boardTheme: 'blue' }));
    render(
      <MemoryRouter>
        <ThemeProvider><ChessBoard fen={START_FEN} onMove={() => {}} /></ThemeProvider>
      </MemoryRouter>,
    );
    const images = [...document.querySelectorAll('.board-container img')] as HTMLImageElement[];
    expect(images.every((image) => image.getAttribute('src')?.startsWith('/pieces/celtic/'))).toBe(true);
    expect(screen.getByText(/Celtic pieces/)).toBeInTheDocument();
  });
});
