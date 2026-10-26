import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ChessBoard } from '../../web/src/features/chess/ChessBoard';
import { ThemeProvider } from '../../web/src/app/ThemeProvider';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function renderBoard(props: Partial<React.ComponentProps<typeof ChessBoard>> = {}) {
  const onMove = vi.fn();
  const utils = render(<ThemeProvider><ChessBoard fen={START_FEN} onMove={onMove} {...props} /></ThemeProvider>);
  return { ...utils, onMove };
}

describe('ChessBoard', () => {
  it('renders a real board and supports keyboard algebraic move input', () => {
    const { onMove } = renderBoard();
    expect(document.querySelector('.board-container')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Keyboard mode/i }));
    fireEvent.change(screen.getByPlaceholderText('e2'), { target: { value: 'e2' } });
    fireEvent.change(screen.getByPlaceholderText('e4'), { target: { value: 'e4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));
    expect(onMove).toHaveBeenCalledWith('e2', 'e4');
  });

  it('requires a promotion choice and sends the selected piece to the server callback', () => {
    const onMove = vi.fn();
    render(<ThemeProvider><ChessBoard fen="7k/P7/8/8/8/8/8/7K w - - 0 1" onMove={onMove} /></ThemeProvider>);
    fireEvent.click(screen.getByRole('button', { name: /Keyboard mode/i }));
    fireEvent.change(screen.getByPlaceholderText('e2'), { target: { value: 'a7' } });
    fireEvent.change(screen.getByPlaceholderText('e4'), { target: { value: 'a8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));
    expect(screen.getByRole('dialog', { name: /Choose promotion/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Promote to queen/i }));
    expect(onMove).toHaveBeenCalledWith('a7', 'a8', 'q');
  });

  it('hides pointer move controls when the board is disabled', () => {
    renderBoard({ disabled: true, onMove: undefined });
    expect(screen.getByText(/Stockfish 19 GPL engine available in Analysis/)).toBeInTheDocument();
  });
});
