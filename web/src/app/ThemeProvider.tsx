import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type ThemeName = 'dark' | 'light';

/**
 * Square palettes. `green`, `brown` and `blue` are the familiar chess.com
 * boards; `midnight` and `wood` are the deeper, more textured looks.
 */
export type BoardTheme = 'green' | 'brown' | 'blue' | 'midnight' | 'wood';

/**
 * Piece art. `chesscom` is the Colin M. L. Burnett Staunton set (GPL-2.0-or-later), `merida`,
 * `chessnut` and `celtic` are vendored alternative sets, `meridian` is the
 * high-contrast recolour of the default set, and `staunton` is the vector set
 * bundled with react-chessboard.
 */
export type PieceTheme = 'chesscom' | 'merida' | 'chessnut' | 'celtic' | 'meridian' | 'staunton';

export interface ThemeOption<T extends string> {
  id: T;
  label: string;
  /** One line describing the look, shown in the board studio. */
  note: string;
  /** Vendor / author for the licence file, or null for project-built art. */
  attribution: string | null;
}

export const BOARD_THEMES: Array<ThemeOption<BoardTheme> & { light: string; dark: string }> = [
  { id: 'green', label: 'Tournament green', note: 'The classic chess.com board.', attribution: 'Project palette', light: '#ebecd0', dark: '#739552' },
  { id: 'brown', label: 'Warm wood', note: 'Soft maple and walnut, easy on the eyes.', attribution: 'Project palette', light: '#f0d9b5', dark: '#b58863' },
  { id: 'blue', label: 'Cool blue', note: 'Quiet slate blue for long sessions.', attribution: 'Project palette', light: '#dee3e6', dark: '#8ca2ad' },
  { id: 'midnight', label: 'Midnight gold', note: 'Charcoal and antique gold for a premium feel.', attribution: 'Project palette', light: '#c9a95c', dark: '#2d2c2a' },
  { id: 'wood', label: 'Dark walnut', note: 'Deep polished timber, like a real club board.', attribution: 'Project palette', light: '#e8cfa8', dark: '#5b3a24' },
];

export const PIECE_THEMES: Array<ThemeOption<PieceTheme>> = [
  { id: 'chesscom', label: 'Classic Staunton', note: 'The set Lichess uses; the familiar chess.com look.', attribution: 'Colin M. L. Burnett · GPL-2.0-or-later' },
  { id: 'merida', label: 'Merida', note: 'Fine hatched engraving, the classic engine GUI set.', attribution: 'Armando Hernandez Marroquin · GPL-2.0-or-later' },
  { id: 'chessnut', label: 'Chessnut', note: 'Clean filled silhouettes with soft rounding.', attribution: 'Alexis Luengas · Apache-2.0' },
  { id: 'celtic', label: 'Celtic', note: 'Distinctive outlined shapes, good on dark boards.', attribution: 'Maurizio Monge · MIT' },
  { id: 'meridian', label: 'High contrast', note: 'The default set recoloured for low vision.', attribution: 'Colin M. L. Burnett · GPL-2.0-or-later' },
  { id: 'staunton', label: 'Vector outline', note: 'Bundled with react-chessboard; no image files.', attribution: 'react-chessboard · MIT' },
];

/** Root folder under `web/public` for a piece set; the default set sits at the root. */
export function pieceSetFolder(theme: PieceTheme): string {
  if (theme === 'chesscom' || theme === 'meridian' || theme === 'staunton') return '';
  return `${PIECE_THEMES.find((entry) => entry.id === theme)?.id ?? ''}/`;
}

/** Public URL of a piece, e.g. `wK` -> `/pieces/merida/wK.svg`. */
export function pieceSrc(theme: PieceTheme, piece: string): string {
  const folder = pieceSetFolder(theme);
  return folder ? `/pieces/${folder}${piece}.svg` : `/pieces/${piece}.svg`;
}

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
