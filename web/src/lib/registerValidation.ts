/**
 * Client-side registration checks.
 *
 * These mirror the server rules so a person learns what is wrong while typing,
 * instead of being bounced with a generic message after a round trip on a slow
 * mobile connection. The server still validates everything: this is a courtesy,
 * never a security boundary.
 */
export interface RegistrationDraft {
  username: string;
  email: string;
  password: string;
  confirmPassword: string;
  acceptTerms: boolean;
}

export type FieldErrors = Record<string, string>;

export const USERNAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]+$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function passwordProblems(password: string): string[] {
  const problems: string[] = [];
  if (password.length < 10) problems.push('Use at least 10 characters');
  if (!/[a-z]/.test(password)) problems.push('Include a lowercase letter');
  if (!/[A-Z]/.test(password)) problems.push('Include an uppercase letter');
  if (!/[0-9]/.test(password)) problems.push('Include a number');
  return problems;
}

export function validateRegistration(draft: RegistrationDraft): FieldErrors {
  const errors: FieldErrors = {};
  const username = draft.username.trim();

  if (!username) errors.username = 'Choose a username';
  else if (username.length < 3 || username.length > 24) errors.username = 'Use 3–24 characters';
  else if (!USERNAME_PATTERN.test(username)) {
    errors.username = 'Use letters, numbers or underscores only, starting with a letter (no spaces)';
  }

  const email = draft.email.trim();
  if (!email) errors.email = 'Enter your email address';
  else if (!EMAIL_PATTERN.test(email)) errors.email = 'Enter a valid email address, for example you@example.com';

  const problems = passwordProblems(draft.password);
  if (problems.length) errors.password = problems[0];

  if (draft.confirmPassword !== draft.password) errors.confirmPassword = 'Passwords do not match';
  if (!draft.acceptTerms) errors.acceptTerms = 'Please accept the terms and privacy notice to continue';

  return errors;
}

export function firstFieldError(errors: FieldErrors): string | null {
  const values = Object.values(errors);
  return values.length ? values[0] : null;
}
