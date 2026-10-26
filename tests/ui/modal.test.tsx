import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ConfirmDialog, Modal } from '../../web/src/components/Modal';

describe('accessible dialogs', () => {
  it('renders a labelled modal and closes on Escape', () => {
    const onClose = vi.fn();
    render(<Modal open onClose={onClose} title="Test dialog"><p>Dialog body</p></Modal>);
    expect(screen.getByRole('dialog', { name: 'Test dialog' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('requires an explicit confirm button for high-impact actions', () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog open onClose={() => undefined} onConfirm={onConfirm} title="Resign?" message="This ends the game." />);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenCalled();
  });
});
