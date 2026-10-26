import type { ProviderHealth } from '../../shared/contracts.js';
export type { ProviderHealth } from '../../shared/contracts.js';

export type ProviderId = 'paynow' | 'ecocash' | 'onemoney' | 'pesepay';
export type ProviderState = 'paid' | 'pending' | 'processing' | 'failed' | 'cancelled' | 'reversed' | 'completed' | 'unknown';

export interface ProviderInitiation {
  providerReference: string;
  redirectUrl: string | null;
  instructions: string;
  metadata: Record<string, unknown>;
  sandbox: boolean;
}

export interface ProviderStatus {
  state: ProviderState;
  amountCents: number | null;
  currency: string;
  providerReference: string;
  raw: unknown;
  authoritative: boolean;
}

export interface ProviderCallback {
  eventId: string;
  authenticated: boolean;
  references: string[];
  reason?: string;
  allowUnauthenticatedLookup?: boolean;
  raw: unknown;
}

export interface PaymentOperation {
  reference: string;
  amountCents: number;
  currency: string;
  userId?: string;
  phone?: string;
  email?: string;
  returnUrl?: string;
  resultUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface PaymentAdapter {
  readonly id: ProviderId;
  readonly name: string;
  readonly docsUrl: string;
  health(): ProviderHealth;
  initiateDeposit(input: PaymentOperation): Promise<ProviderInitiation>;
  initiateWithdrawal(input: PaymentOperation): Promise<ProviderInitiation>;
  parseCallback(rawBody: string, headers: Record<string, string | string[] | undefined>): ProviderCallback;
  checkStatus(input: { reference: string; providerReference?: string | null; metadata?: Record<string, unknown> }): Promise<ProviderStatus>;
  refund?(input: { reference: string; providerReference: string; amountCents: number; reason: string; phone?: string }): Promise<ProviderStatus>;
}

export class ProviderError extends Error {
  constructor(message: string, public readonly code = 'provider_error', public readonly status = 502) {
    super(message);
    this.name = 'ProviderError';
  }
}
