import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ChessBoard } from '../../web/src/features/chess/ChessBoard';
import { ThemeProvider, resolveBoardTheme, resolvePieceTheme, BOARD_THEMES, PIECE_THEMES } from '../../web/src/app/ThemeProvider';
import { MemoryRouter } from 'react-router-dom';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('board appearance', () => {
  it('offers every shipped palette and piece set', () => {
    expect(BOARD_THEMES.map((theme) => theme.id)).toEqual(['green', 'brown', 'blue', 'midnight', 'wood']);
    expect(PIECE_THEMES.map((theme) => theme.id)).toEqual(['chesscom', 'merida', 'chessnut', 'celtic', 'meridian', 'staunton']);
  });

  it('keeps old stored preference ids working', () => {
    expect(resolveBoardTheme('forest')).toBe('green');
    expect(resolveBoardTheme('walnut')).toBe('brown');
    expect(resolveBoardTheme('slate')).toBe('blue');
    expect(resolvePieceTheme('classic')).toBe('chesscom');
    expect(resolveBoardTheme('nonsense')).toBe('green');
    expect(resolvePieceTheme(undefined)).toBe('chesscom');
    expect(resolvePieceTheme(42)).toBe('chesscom');
  });

  it('renders every piece from the vendored Staunton set by default', () => {
    render(
      <MemoryRouter>
        <ThemeProvider><ChessBoard fen={START_FEN} onMove={() => {}} /></ThemeProvider>
      </MemoryRouter>,
    );
    const images = [...document.querySelectorAll('.board-container img')] as HTMLImageElement[];
    expect(images.length).toBeGreaterThanOrEqual(32);
    for (const image of images) {
      expect(image.getAttribute('src')).toMatch(/^\/pieces\/[wb][KQRBNP]\.svg$/);
      expect(image.className).toContain('chesscom');
    }
  });

  it('keeps keyboard play working on the new board styling', () => {
    const moves: string[] = [];
    render(
      <MemoryRouter>
        <ThemeProvider><ChessBoard fen={START_FEN} onMove={(from, to) => { moves.push(`${from}${to}`); }} /></ThemeProvider>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Keyboard mode/i }));
    fireEvent.change(screen.getByPlaceholderText('e2'), { target: { value: 'g1' } });
    fireEvent.change(screen.getByPlaceholderText('e4'), { target: { value: 'f3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));
    expect(moves).toEqual(['g1f3']);
  });

  it('uses the configured promotion set for the promotion dialog', () => {
    render(
      <MemoryRouter>
        <ThemeProvider><ChessBoard fen="7k/P7/8/8/8/8/8/7K w - - 0 1" onMove={() => {}} /></ThemeProvider>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Keyboard mode/i }));
    fireEvent.change(screen.getByPlaceholderText('e2'), { target: { value: 'a7' } });
    fireEvent.change(screen.getByPlaceholderText('e4'), { target: { value: 'a8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));
    const dialog = screen.getByRole('dialog', { name: /Choose promotion/i });
    const images = [...dialog.querySelectorAll('img')] as HTMLImageElement[];
    expect(images.map((image) => image.getAttribute('src'))).toEqual([
      '/pieces/wQ.svg', '/pieces/wR.svg', '/pieces/wB.svg', '/pieces/wN.svg',
    ]);
  });
});
