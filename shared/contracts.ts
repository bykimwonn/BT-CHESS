/**
 * Contracts shared by the browser client and the authoritative server.
 * Pure TypeScript: no Node.js or DOM APIs may be imported here.
 */

export type OperatingMode = 'free' | 'test' | 'real';
export type CurrencyCode = string;
export const LEDGER_BASE_CURRENCY = 'USD';
export type Role = 'player' | 'admin' | 'agent';
export type GameStatus = 'waiting' | 'active' | 'finished' | 'void' | 'abandoned' | 'disputed';
export type GameResult = 'white' | 'black' | 'draw' | 'void';
export type Termination =
  | 'checkmate' | 'stalemate' | 'insufficient-material' | 'threefold-repetition'
  | 'fifty-move-rule' | 'agreed-draw' | 'resignation' | 'timeout'
  | 'abandonment' | 'void' | 'administrator';
export type TimeCategory = 'bullet' | 'blitz' | 'rapid' | 'classical' | 'custom';
export type ChallengeKind = 'open' | 'direct' | 'private';
export type ChallengeStatus = 'open' | 'accepted' | 'cancelled' | 'expired' | 'matched';
export type DepositStatus = 'pending' | 'confirmed' | 'failed' | 'cancelled' | 'reversed';
export type WithdrawalStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface TimeControl {
  category: TimeCategory;
  baseMs: number;
  incrementMs: number;
}

export interface CompetitionTerms {
  stakeCents: number;
  feeBps: number;
  potCents: number;
  feeCents: number;
  payoutCents: number;
  currency: 'USD';
  drawPolicy: 'refund-both-no-fee';
  version: number;
}

export const TERMS_VERSION = 1;
export const MIN_STAKE_CENTS = 50;
export const MAX_STAKE_CENTS = 50000;
export const ALLOWED_STAKES_CENTS = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000] as const;

export const TIME_PRESETS: Record<Exclude<TimeCategory, 'custom'>, TimeControl> = {
  bullet: { category: 'bullet', baseMs: 60_000, incrementMs: 1_000 },
  blitz: { category: 'blitz', baseMs: 180_000, incrementMs: 2_000 },
  rapid: { category: 'rapid', baseMs: 600_000, incrementMs: 5_000 },
  classical: { category: 'classical', baseMs: 1_800_000, incrementMs: 10_000 },
};

/** Deterministic integer-cent competition quote. Never uses floating point money. */
export function quoteTerms(stakeCents: number, feeBps: number): CompetitionTerms {
  if (!Number.isSafeInteger(stakeCents) || stakeCents < MIN_STAKE_CENTS || stakeCents > MAX_STAKE_CENTS) {
    throw new Error('Stake is outside the permitted USD-cent range');
  }
  if (!Number.isSafeInteger(feeBps) || feeBps < 0 || feeBps > 2500) {
    throw new Error('Commission basis points are invalid');
  }
  const potCents = stakeCents * 2;
  // Half-up rounding at the cent boundary, carried out with integers.
  const feeCents = Number((BigInt(potCents) * BigInt(feeBps) + 5_000n) / 10_000n);
  return {
    stakeCents, feeBps, potCents, feeCents,
    payoutCents: potCents - feeCents,
    currency: 'USD', drawPolicy: 'refund-both-no-fee', version: TERMS_VERSION,
  };
}

export function formatCents(cents: number, withSymbol = true): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(cents));
  const value = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  return `${sign}${withSymbol ? '$' : ''}${value}`;
}

/** Always show the ISO currency code; never imply an unlabelled conversion. */
export function formatMoney(cents: number, currency: CurrencyCode = LEDGER_BASE_CURRENCY): string {
  return `${String(currency).toUpperCase()} ${formatCents(cents)}`;
}

export function formatClock(ms: number): string {
  const clamped = Math.max(0, Math.floor(ms));
  const tenths = clamped < 20_000 ? Math.floor((clamped % 1000) / 100) : 0;
  const total = Math.floor(clamped / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  const ss = String(seconds).padStart(2, '0');
  return clamped < 20_000 ? `${mm}:${ss}.${tenths}` : hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function canonicalTerms(terms: CompetitionTerms): string {
  return [
    'rookstone-terms', terms.version, terms.currency, terms.stakeCents, terms.feeBps,
    terms.potCents, terms.feeCents, terms.payoutCents, terms.drawPolicy,
  ].join('|');
}

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  status: string;
  emailVerified: boolean;
  ageVerified: boolean;
  country: string;
  countryShared: boolean;
  timezone: string | null;
  timezoneShared: boolean;
  accountCurrency: CurrencyCode;
  createdAt: string;
  rating: number;
}

export interface WalletView {
  availableCents: number;
  reservedCents: number;
  totalCents: number;
  currency: CurrencyCode;
  pendingDepositsCents: number;
  pendingWithdrawalsCents: number;
  source: 'ledger';
}

export interface GameSnapshot {
  id: string;
  version: number;
  status: GameStatus;
  mode: OperatingMode;
  fen: string;
  initialFen: string;
  pgn: string;
  moves: MoveRecord[];
  white: PlayerSeat;
  black: PlayerSeat;
  timeControl: TimeControl;
  whiteClockMs: number;
  blackClockMs: number;
  turnStartedAt: string | null;
  startedAt: string;
  serverTime: string;
  result: GameResult | null;
  termination: Termination | null;
  lastMove: { from: string; to: string } | null;
  drawOfferBy: string | null;
  inCheck: boolean;
  competition: CompetitionTerms | null;
  connection: 'connected' | 'reconnecting' | 'offline';
  legalMoves: string[];
}

export interface PlayerSeat {
  userId: string;
  username: string;
  rating: number;
  connected: boolean;
  country?: string;
  countryShared?: boolean;
  timezone?: string | null;
  timezoneShared?: boolean;
}

export interface MoveRecord {
  ply: number;
  san: string;
  uci: string;
  fen: string;
  color: 'w' | 'b';
  clockMs: number;
  createdAt: string;
}

export interface ChallengeView {
  id: string;
  kind: ChallengeKind;
  creator: { id: string; username: string; rating: number };
  opponent: { id: string; username: string; rating: number } | null;
  timeControl: TimeControl;
  stakeCents: number;
  terms: CompetitionTerms | null;
  ratingMin: number;
  ratingMax: number;
  status: ChallengeStatus;
  expiresAt: string;
  createdAt: string;
  inviteUrl: string | null;
  gameId: string | null;
  requiresAcceptance: boolean;
}

export interface PlatformStatus {
  mode: OperatingMode;
  freeChessEnabled: boolean;
  competitionsEnabled: boolean;
  realMoneyEnabled: boolean;
  realMoneyBlockers: string[];
  feeBps: number;
  testFundsEnabled: boolean;
  providerHealth: ProviderHealth[];
  engine: { available: boolean; name: string | null; version: string | null; license: string };
  legalNotice: string;
  ledgerBaseCurrency: CurrencyCode;
  freePlayGlobal: boolean;
}

export interface ProviderHealth {
  id: string;
  name: string;
  configured: boolean;
  sandbox: boolean;
  enabledForRealMoney: boolean;
  reason: string;
  capabilities: string[];
}

export interface NotificationView {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  username: string;
  displayName: string;
  rating: number;
  gamesPlayed: number;
  wins: number;
  losses: number;
  draws: number;
  country?: string;
  countryShared?: boolean;
}

export interface JurisdictionPolicy {
  code: string;
  label: string;
  freePlayAllowed: boolean;
  realMoneyAllowed: boolean;
  ageVerificationRequired: boolean;
  identityVerificationRequired: boolean;
  permittedCompetitionTypes: OperatingMode[];
  allowedProviders: string[];
  depositLimitCents: number | null;
  withdrawalLimitCents: number | null;
  reason: string;
  updatedAt?: string;
  version?: number;
}

export interface EligibilityView {
  authenticated: boolean;
  countryOfResidence: string;
  countryShared: boolean;
  verifiedEligibilityJurisdiction: string | null;
  eligibilityVerifiedAt: string | null;
  accountCurrency: CurrencyCode;
  timezone: string;
  timezoneShared: boolean;
  policyCode: string;
  policy: JurisdictionPolicy;
  freePlay: { allowed: boolean; reason: string };
  moneyMatches: { allowed: boolean; blockers: string[]; permittedTypes: OperatingMode[]; allowedProviders: string[] };
  platform: { mode: OperatingMode; realMoneyEnabled: boolean; competitionsEnabled: boolean };
}

export interface TournamentView {
  id: string;
  name: string;
  mode: OperatingMode;
  status: 'registration' | 'active' | 'finished';
  timeControl: TimeControl;
  maxPlayers: number;
  currentRound: number;
  rated: boolean;
  createdBy: string;
  creatorUsername: string;
  startsAt: string | null;
  createdAt: string;
  entrants: number;
}

export interface TournamentStanding {
  rank: number;
  userId: string;
  username: string;
  country: string;
  countryShared: boolean;
  rating: number;
  points: number;
  status: string;
}

export interface TournamentPairing {
  id: string;
  roundNo: number;
  boardNo: number;
  whiteId: string;
  whiteUsername: string;
  blackId: string;
  blackUsername: string;
  gameId: string | null;
  result: string | null;
  createdAt: string;
}

export const SOCKET_EVENTS = {
  gameState: 'game:state',
  gameMove: 'game:move',
  gameResign: 'game:resign',
  gameDrawOffer: 'game:draw-offer',
  gameDrawAnswer: 'game:draw-answer',
  gameClaimDraw: 'game:claim-draw',
  gameChat: 'game:chat',
  challengeCreated: 'challenge:created',
  challengeUpdated: 'challenge:updated',
  notification: 'notification:new',
  matchFound: 'matchmaking:found',
  error: 'server:error',
} as const;

export function isStakeAllowed(stakeCents: number): boolean {
  return (ALLOWED_STAKES_CENTS as readonly number[]).includes(stakeCents);
}

/** Parse a provider decimal string into integer cents without floating point. */
export function decimalToCents(value: string | number): number {
  const text = String(value).trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new Error(`Invalid decimal currency amount: ${text}`);
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

export function centsToDecimal(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new Error('Invalid cent amount');
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Captured pieces derived from the material currently on the board. */
export function capturedPieces(fen: string): { white: string[]; black: string[] } {
  const initial: Record<string, number> = { q: 1, r: 2, b: 2, n: 2, p: 8 };
  const current: Record<string, number> = {};
  for (const ch of fen.split(' ')[0]) if (/[a-zA-Z]/.test(ch)) current[ch] = (current[ch] ?? 0) + 1;
  const captured = (upper: boolean): string[] => {
    const out: string[] = [];
    for (const piece of ['q', 'r', 'b', 'n', 'p']) {
      const key = upper ? piece.toUpperCase() : piece;
      const missing = Math.max(0, initial[piece] - (current[key] ?? 0));
      for (let i = 0; i < missing; i++) out.push(`${upper ? 'w' : 'b'}${piece.toUpperCase()}`);
    }
    return out;
  };
  return { white: captured(true), black: captured(false) };
}
