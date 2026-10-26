import { z } from 'zod';
import { TIME_PRESETS, isStakeAllowed, type TimeCategory } from './contracts.js';
import { UNDISCLOSED_COUNTRY, isValidTimeZone, normalizeCountryCode } from './countries.js';

export const usernameSchema = z.string().trim().min(3).max(24)
  .regex(/^[a-zA-Z][a-zA-Z0-9_]+$/, 'Use 3–24 letters, numbers or underscores, starting with a letter');
export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z.string().min(10).max(128)
  .regex(/[a-z]/, 'Include a lowercase letter')
  .regex(/[A-Z]/, 'Include an uppercase letter')
  .regex(/[0-9]/, 'Include a number');

export const countrySchema = z.string().trim().toUpperCase()
  .refine((value) => value === UNDISCLOSED_COUNTRY || normalizeCountryCode(value) !== null, 'Choose a valid country or prefer not to say');
export const timezoneSchema = z.string().trim().min(1).max(80).refine(isValidTimeZone, 'Choose a valid IANA time zone');
export const currencySchema = z.enum(['USD']);

export const registerSchema = z.object({
  username: usernameSchema,
  email: emailSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(1).max(48).optional(),
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional(),
  country: countrySchema.default(UNDISCLOSED_COUNTRY),
  countryShared: z.boolean().default(false),
  timezone: timezoneSchema.default('UTC'),
  timezoneShared: z.boolean().default(false),
  accountCurrency: currencySchema.default('USD'),
}).refine((data) => data.country !== UNDISCLOSED_COUNTRY || !data.countryShared,
  'Choose a country before sharing it');
export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
  mfaCode: z.string().regex(/^\d{6}$/).optional(),
});
export const forgotSchema = z.object({ email: emailSchema });
export const resetSchema = z.object({ token: z.string().min(20), password: passwordSchema });

export const internationalProfileSchema = z.object({
  country: countrySchema.optional(),
  countryShared: z.boolean().optional(),
  timezone: timezoneSchema.optional(),
  timezoneShared: z.boolean().optional(),
  accountCurrency: currencySchema.optional(),
}).refine((data) => Object.keys(data).length > 0, 'No international preferences supplied');

export const eligibilityVerificationSchema = z.object({
  userId: z.string().uuid(),
  providerReference: z.string().min(3).max(120),
  verified: z.literal(true),
  identityVerified: z.boolean().default(true),
  locationVerified: z.boolean().default(true),
  jurisdiction: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/),
  signature: z.string().length(64),
});

export const stakeCentsSchema = z.number().int().refine(
  (value) => value === 0 || isStakeAllowed(value),
  'Choose a supported USD stake amount',
);

export const timeControlSchema = z.object({
  category: z.enum(['bullet', 'blitz', 'rapid', 'classical', 'custom']),
  baseMs: z.number().int().min(30_000).max(7_200_000),
  incrementMs: z.number().int().min(0).max(60_000),
}).refine((t) => t.category !== 'custom' || t.baseMs >= 30_000, 'Custom base must be at least 30 seconds');

export const challengeCreateSchema = z.object({
  kind: z.enum(['open', 'direct', 'private']),
  opponentUsername: z.string().trim().min(3).max(24).optional(),
  timeControl: timeControlSchema,
  stakeCents: stakeCentsSchema,
  ratingRange: z.number().int().min(50).max(1000).default(300),
  acceptedTermsHash: z.string().length(64).optional(),
}).refine((c) => c.kind !== 'direct' || !!c.opponentUsername, 'Direct challenges need a username');

export const matchmakingSchema = z.object({
  timeControl: timeControlSchema,
  stakeCents: stakeCentsSchema,
  ratingRange: z.number().int().min(50).max(1000).default(300),
  acceptedTermsHash: z.string().length(64).optional(),
});

export const quoteSchema = z.object({
  context: z.enum(['challenge', 'matchmaking']),
  kind: z.enum(['open', 'direct', 'private']).default('open'),
  opponentUsername: z.string().trim().min(3).max(24).optional(),
  timeControl: timeControlSchema,
  stakeCents: stakeCentsSchema,
  ratingRange: z.number().int().min(50).max(1000).default(300),
});

export const tournamentCreateSchema = z.object({
  name: z.string().trim().min(3).max(80),
  timeControl: timeControlSchema,
  maxPlayers: z.number().int().min(2).max(128).default(32),
  rated: z.boolean().default(true),
  startsAt: z.string().datetime().nullable().optional(),
});

export const jurisdictionPolicySchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^(\*|[A-Z]{2})$/),
  label: z.string().trim().min(2).max(80),
  freePlayAllowed: z.boolean(),
  realMoneyAllowed: z.boolean(),
  ageVerificationRequired: z.boolean().default(true),
  identityVerificationRequired: z.boolean().default(true),
  permittedCompetitionTypes: z.array(z.enum(['free', 'test', 'real'])).min(1),
  allowedProviders: z.array(z.enum(['paynow', 'ecocash', 'onemoney', 'pesepay'])).default([]),
  depositLimitCents: z.number().int().min(0).nullable().optional(),
  withdrawalLimitCents: z.number().int().min(0).nullable().optional(),
  reason: z.string().trim().min(8).max(500),
  confirm: z.literal(true),
});

export const exchangeRateSchema = z.object({
  fromCurrency: z.string().trim().toUpperCase().length(3),
  toCurrency: z.string().trim().toUpperCase().length(3),
  rate: z.string().regex(/^\d+(\.\d{1,12})?$/),
  effectiveAt: z.string().datetime(),
  source: z.string().trim().min(3).max(120),
  evidenceRef: z.string().trim().max(200).default(''),
  reason: z.string().trim().min(8).max(500),
  confirm: z.literal(true),
}).refine((r) => r.fromCurrency !== r.toCurrency && Number(r.rate) > 0);

export const conversionQuoteSchema = z.object({
  fromCurrency: z.string().trim().toUpperCase().length(3),
  toCurrency: z.string().trim().toUpperCase().length(3),
  amountCents: z.number().int().positive(),
});

export const moveSchema = z.object({
  gameId: z.string().uuid(),
  version: z.number().int().nonnegative(),
  from: z.string().regex(/^[a-h][1-8]$/),
  to: z.string().regex(/^[a-h][1-8]$/),
  promotion: z.enum(['q', 'r', 'b', 'n']).optional(),
  nonce: z.string().min(8).max(80),
});

export const depositSchema = z.object({
  provider: z.enum(['paynow', 'ecocash', 'onemoney', 'pesepay']),
  amountCents: z.number().int().min(50).max(500_000),
  phone: z.string().trim().regex(/^(263\d{9}|0\d{9})$/).optional(),
  returnUrl: z.string().url().optional(),
});
export const withdrawalSchema = z.object({
  provider: z.enum(['paynow', 'ecocash', 'onemoney', 'pesepay']),
  amountCents: z.number().int().min(100).max(500_000),
  destination: z.string().trim().min(6).max(120),
});

export function normalizeTimeControl(input: z.infer<typeof timeControlSchema>): { category: TimeCategory; baseMs: number; incrementMs: number } {
  if (input.category !== 'custom') return { ...TIME_PRESETS[input.category] };
  return input;
}
