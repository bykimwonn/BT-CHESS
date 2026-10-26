import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { PublicUser } from '@shared/contracts';
import { SettingsPage } from '../../web/src/pages/SettingsPage';
import { AuthPage } from '../../web/src/pages/AuthPage';
import { AuthProvider } from '../../web/src/app/AuthProvider';
import { ToastProvider } from '../../web/src/app/ToastProvider';
import { ThemeProvider } from '../../web/src/app/ThemeProvider';

const user: PublicUser = {
  id: 'user-1', username: 'PlayerOne', displayName: 'Player One', role: 'player', status: 'active',
  emailVerified: false, ageVerified: false, country: 'ZZ', countryShared: false,
  timezone: null, timezoneShared: false, accountCurrency: 'USD',
  createdAt: '2026-01-01T00:00:00.000Z', rating: 1200,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
}

function renderSettings(delivery: { delivered: boolean; reason?: string }) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/auth/session') return json({ user, csrfToken: 'csrf', mfaEnabled: false });
    if (url === '/api/status') return json({});
    if (url === '/api/auth/email-verification/send') return json(delivery);
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <ThemeProvider>
            <AuthProvider>
              <SettingsPage />
            </AuthProvider>
          </ThemeProvider>
        </ToastProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return fetchMock;
}

function renderRegistration(delivery: { delivered: boolean; reason?: string }) {
  let registered = false;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/auth/session') {
      return registered
        ? json({ user, csrfToken: 'csrf', mfaEnabled: false })
        : json({ error: { code: 'unauthorized', message: 'Sign in required' } }, 401);
    }
    if (url === '/api/auth/register') {
      registered = true;
      return json({ user, csrfToken: 'csrf', emailDelivery: delivery });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(
    <MemoryRouter initialEntries={['/auth?mode=register']}>
      <ToastProvider>
        <AuthProvider>
          <AuthPage />
        </AuthProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('email delivery reporting', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('does not claim a verification email was sent when SMTP rejects it', async () => {
    const fetchMock = renderSettings({ delivered: false, reason: 'Gmail rejected the sign-in (EAUTH).' });
    fireEvent.click(screen.getByRole('button', { name: 'Send verification email' }));

    expect(await screen.findByText('Verification email not delivered')).toBeInTheDocument();
    expect(screen.getByText('Gmail rejected the sign-in (EAUTH).')).toBeInTheDocument();
    expect(screen.queryByText('Verification email sent')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/email-verification/send', expect.objectContaining({ method: 'POST' }));
  });

  it('describes a successful SMTP handoff as accepted, not inbox delivery', async () => {
    renderSettings({ delivered: true });
    fireEvent.click(screen.getByRole('button', { name: 'Send verification email' }));

    expect(await screen.findByText('Verification email accepted')).toBeInTheDocument();
    expect(screen.getByText(/SMTP server accepted the message/)).toBeInTheDocument();
    expect(screen.queryByText('Verification email sent')).not.toBeInTheDocument();
  });

  it('reports a registration delivery failure instead of directing the user to an empty inbox', async () => {
    renderRegistration({ delivered: false, reason: 'SMTP authentication failed.' });
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: 'MobileUser' } });
    fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: 'mobile@example.com' } });
    const passwordInputs = document.querySelectorAll('input[type="password"]');
    fireEvent.change(passwordInputs[0], { target: { value: 'GoodPassw0rd' } });
    fireEvent.change(passwordInputs[1], { target: { value: 'GoodPassw0rd' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /accept terms/i }));
    fireEvent.submit(screen.getByRole('button', { name: /create account/i }).closest('form')!);

    expect(await screen.findByText('Account created — verification email not delivered')).toBeInTheDocument();
    expect(screen.getByText(/SMTP authentication failed\. You can retry from Settings\./)).toBeInTheDocument();
    expect(screen.queryByText(/Check your inbox/)).not.toBeInTheDocument();
  });
});
