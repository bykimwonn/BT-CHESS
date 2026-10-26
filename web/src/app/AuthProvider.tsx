import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { PublicUser } from '@shared/contracts';
import { api, ApiError } from '../lib/api';

interface SessionResponse { user: PublicUser; csrfToken: string; mfaEnabled: boolean }
interface RegisterInput {
  username: string; email: string; password: string; displayName?: string;
  country?: string; countryShared?: boolean; timezone?: string; timezoneShared?: boolean;
  accountCurrency?: string;
}
interface AuthValue {
  user: PublicUser | null;
  mfaEnabled: boolean;
  loading: boolean;
  csrfToken: string;
  refresh: () => Promise<void>;
  login: (email: string, password: string, mfaCode?: string) => Promise<PublicUser>;
  register: (input: RegisterInput) => Promise<PublicUser>;
  logout: () => Promise<void>;
  setMfaEnabled: (value: boolean) => void;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [mfaEnabled, setMfaEnabled] = useState(false);
  const [csrfToken, setCsrfToken] = useState('');
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const session = await api<SessionResponse>('/auth/session');
      setUser(session.user);
      setMfaEnabled(session.mfaEnabled);
      setCsrfToken(session.csrfToken);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setUser(null); setMfaEnabled(false); setCsrfToken('');
      } else throw error;
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void refresh().catch(() => setLoading(false)); }, [refresh]);

  const login = useCallback(async (email: string, password: string, mfaCode?: string) => {
    const session = await api<{ user: PublicUser; csrfToken: string }>('/auth/login', { method: 'POST', body: { email, password, mfaCode } });
    setUser(session.user); setCsrfToken(session.csrfToken);
    await refresh();
    return session.user;
  }, [refresh]);

  const register = useCallback(async (input: RegisterInput) => {
    const result = await api<{ user: PublicUser; csrfToken: string }>('/auth/register', { method: 'POST', body: input });
    setUser(result.user); setCsrfToken(result.csrfToken);
    await refresh();
    return result.user;
  }, [refresh]);

  const logout = useCallback(async () => {
    try { await api('/auth/logout', { method: 'POST', body: {} }); }
    finally { setUser(null); setMfaEnabled(false); setCsrfToken(''); }
  }, []);

  const value = useMemo<AuthValue>(() => ({
    user, mfaEnabled, loading, csrfToken, refresh, login, register, logout, setMfaEnabled,
  }), [user, mfaEnabled, loading, csrfToken, refresh, login, register, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
