import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type ThemeName = 'dark' | 'light';
/** Chess.com-style square palettes: green, brown and blue. */
export type BoardTheme = 'green' | 'brown' | 'blue';
/** `chesscom` is the Colin M. L. Burnett set; `staunton` is react-chessboard's own vectors. */
export type PieceTheme = 'chesscom' | 'meridian' | 'staunton';

export const BOARD_THEMES: Array<{ id: BoardTheme; label: string }> = [
  { id: 'green', label: 'Green' },
  { id: 'brown', label: 'Brown' },
  { id: 'blue', label: 'Blue' },
];
export const PIECE_THEMES: Array<{ id: PieceTheme; label: string }> = [
  { id: 'chesscom', label: 'Classic Staunton' },
  { id: 'meridian', label: 'High contrast' },
  { id: 'staunton', label: 'Vector outline' },
];

// Older builds stored different ids; keep those preferences working.
const LEGACY_BOARD: Record<string, BoardTheme> = { forest: 'green', walnut: 'brown', slate: 'blue' };
const LEGACY_PIECES: Record<string, PieceTheme> = { classic: 'chesscom' };

interface Preferences {
  theme: ThemeName;
  boardTheme: BoardTheme;
  pieceTheme: PieceTheme;
  showCoordinates: boolean;
  showLegalMoves: boolean;
  animations: boolean;
  sound: boolean;
  reducedMotion: boolean;
  setTheme: (theme: ThemeName) => void;
  toggleTheme: () => void;
  set: <K extends keyof Omit<Preferences, 'theme' | 'setTheme' | 'toggleTheme' | 'set' | 'reducedMotion'>>(key: K, value: Preferences[K]) => void;
}

const STORAGE_KEY = 'rookstone.preferences.v1';
const defaults = {
  theme: 'dark' as ThemeName,
  boardTheme: 'green' as BoardTheme,
  pieceTheme: 'chesscom' as PieceTheme,
  showCoordinates: true,
  showLegalMoves: true,
  animations: true,
  sound: false,
};

const BOARD_IDS = new Set<string>(BOARD_THEMES.map((entry) => entry.id));
const PIECE_IDS = new Set<string>(PIECE_THEMES.map((entry) => entry.id));

export function resolveBoardTheme(value: unknown): BoardTheme {
  if (typeof value === 'string') {
    if (BOARD_IDS.has(value)) return value as BoardTheme;
    if (LEGACY_BOARD[value]) return LEGACY_BOARD[value];
  }
  return defaults.boardTheme;
}

export function resolvePieceTheme(value: unknown): PieceTheme {
  if (typeof value === 'string') {
    if (PIECE_IDS.has(value)) return value as PieceTheme;
    if (LEGACY_PIECES[value]) return LEGACY_PIECES[value];
  }
  return defaults.pieceTheme;
}

function load(): typeof defaults {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<typeof defaults>;
    const theme = stored.theme === 'light' || stored.theme === 'dark' ? stored.theme
      : window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    return {
      ...defaults,
      ...stored,
      theme,
      boardTheme: resolveBoardTheme(stored.boardTheme),
      pieceTheme: resolvePieceTheme(stored.pieceTheme),
    };
  } catch { return defaults; }
}

const PreferencesContext = createContext<Preferences | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState(load);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = prefs.theme;
    document.documentElement.style.colorScheme = prefs.theme;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  }, [prefs]);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  const setTheme = useCallback((theme: ThemeName) => setPrefs((p) => ({ ...p, theme })), []);
  const toggleTheme = useCallback(() => setPrefs((p) => ({ ...p, theme: p.theme === 'dark' ? 'light' : 'dark' })), []);
  const set = useCallback(<K extends keyof Omit<Preferences, 'theme' | 'setTheme' | 'toggleTheme' | 'set' | 'reducedMotion'>>(key: K, value: Preferences[K]) => {
    setPrefs((p) => ({ ...p, [key]: value }));
  }, []);

  const value = useMemo<Preferences>(() => ({
    ...prefs, reducedMotion, setTheme, toggleTheme, set,
  }), [prefs, reducedMotion, setTheme, toggleTheme, set]);
  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences(): Preferences {
  const context = useContext(PreferencesContext);
  if (!context) throw new Error('usePreferences must be used inside ThemeProvider');
  return context;
}
