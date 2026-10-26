import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type ThemeName = 'dark' | 'light';
export type BoardTheme = 'forest' | 'slate' | 'walnut';
export type PieceTheme = 'classic' | 'meridian' | 'staunton';

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
  boardTheme: 'forest' as BoardTheme,
  pieceTheme: 'classic' as PieceTheme,
  showCoordinates: true,
  showLegalMoves: true,
  animations: true,
  sound: false,
};

function load(): typeof defaults {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<typeof defaults>;
    const theme = stored.theme === 'light' || stored.theme === 'dark' ? stored.theme
      : window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    return { ...defaults, ...stored, theme };
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
