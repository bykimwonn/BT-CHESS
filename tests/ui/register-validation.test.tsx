import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthPage } from '../../web/src/pages/AuthPage';
import { AuthProvider } from '../../web/src/app/AuthProvider';
import { ToastProvider } from '../../web/src/app/ToastProvider';
import { validateRegistration, passwordProblems } from '../../web/src/lib/registerValidation';

/**
 * The reported bug: creating a second account on a phone produced
 * "Could not continue — Invalid request", with no indication of which field was
 * wrong. These tests pin the behaviour that replaced it.
 */

function renderAuth() {
  return render(
    <MemoryRouter initialEntries={['/auth?mode=register']}>
      <ToastProvider>
        <AuthProvider>
          <AuthPage />
        </AuthProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('registration validation', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ user: null, csrfToken: '' }), {
      status: 401, headers: { 'content-type': 'application/json' },
    })));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('names the exact password rule instead of a generic failure', () => {
    expect(passwordProblems('goodpassw0rd')).toEqual(['Include an uppercase letter']);
    expect(passwordProblems('GoodPassw0rd')).toEqual([]);
    expect(passwordProblems('Good1pass')).toEqual(['Use at least 10 characters']);
    expect(validateRegistration({
      username: 'MobileUser', email: 'mobile@example.com',
      password: 'goodpassw0rd', confirmPassword: 'goodpassw0rd', acceptTerms: true,
    })).toEqual({ password: 'Include an uppercase letter' });
  });

  it('explains a username a phone keyboard mangled with a space', () => {
    const errors = validateRegistration({
      username: 'mobile user', email: 'mobile@example.com',
      password: 'GoodPassw0rd', confirmPassword: 'GoodPassw0rd', acceptTerms: true,
    });
    expect(errors.username).toMatch(/no spaces/i);
  });

  it('reports mismatch and unaccepted terms separately', () => {
    const errors = validateRegistration({
      username: 'MobileUser', email: 'mobile@example.com',
      password: 'GoodPassw0rd', confirmPassword: 'GoodPassw0rd2', acceptTerms: false,
    });
    expect(errors.confirmPassword).toBe('Passwords do not match');
    expect(errors.acceptTerms).toMatch(/accept the terms/i);
  });

  it('shows the message inline, keeps the form usable and makes no request', async () => {
    renderAuth();
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: 'MobileUser' } });
    fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: 'mobile@example.com' } });
    const passwordInputs = document.querySelectorAll('input[type="password"]');
    fireEvent.change(passwordInputs[0], { target: { value: 'goodpassw0rd' } });
    fireEvent.change(passwordInputs[1], { target: { value: 'goodpassw0rd' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /accept terms/i }));
    fireEvent.submit(screen.getByRole('button', { name: /create account/i }).closest('form')!);

    const message = await screen.findByRole('alert');
    expect(message.textContent).toBe('Include an uppercase letter');
    expect((document.querySelectorAll('input[type="password"]')[0] as HTMLInputElement).getAttribute('aria-invalid')).toBe('true');
    // The rule is enforced before any network call, so a slow phone connection
    // never turns a fixable typo into a dead end.
    await waitFor(() => {
      const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
        .filter(([url]) => String(url).includes('/auth/register'));
      expect(calls).toHaveLength(0);
    });
  });

  it('marks inputs for mobile keyboards so autocapitalise and autocorrect stay off', () => {
    renderAuth();
    expect(screen.getByLabelText(/username/i).getAttribute('autocapitalize')).toBe('none');
    expect(screen.getByLabelText(/username/i).getAttribute('autocorrect')).toBe('off');
    expect(screen.getByLabelText(/email address/i).getAttribute('autocapitalize')).toBe('none');
    expect(screen.getByLabelText(/email address/i).getAttribute('inputmode')).toBe('email');
  });
});
