import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider, usePreferences } from '../../web/src/app/ThemeProvider';

function Probe() {
  const prefs = usePreferences();
  return (
    <div>
      <span data-testid="theme">{prefs.theme}</span>
      <button onClick={prefs.toggleTheme}>Toggle</button>
      <button onClick={() => prefs.set('showCoordinates', false)}>Hide coordinates</button>
      <span data-testid="coords">{String(prefs.showCoordinates)}</span>
    </div>
  );
}

describe('ThemeProvider', () => {
  it('toggles dark/light theme and persists a safe document attribute', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
    fireEvent.click(screen.getByRole('button', { name: 'Toggle' }));
    expect(screen.getByTestId('theme')).toHaveTextContent('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('updates board preferences independently', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId('coords')).toHaveTextContent('true');
    fireEvent.click(screen.getByRole('button', { name: 'Hide coordinates' }));
    expect(screen.getByTestId('coords')).toHaveTextContent('false');
  });
});
