import crypto from 'node:crypto';
import fs from 'node:fs';
import { env } from './env.js';

/**
 * Real-money competition requires BOTH environment flags and an independently
 * signed activation manifest. A single configuration flag is deliberately not
 * enough. The manifest records the legal opinion, licence, merchant approval
 * and age-verification integration that a human compliance officer verified.
 */
export interface ComplianceActivation {
  schema: 1;
  jurisdiction: string;
  legalOpinionRef: string;
  licenceRef: string;
  providerApprovalRef: string;
  ageVerificationProvider: string;
  amlOfficerRef: string;
  approvedBy: string;
  approvedAt: string;
  expiresAt: string;
  signature?: string;
}

export type ComplianceState = {
  realMoneyEnabled: boolean;
  competitionsEnabled: boolean;
  testMode: boolean;
  blockers: string[];
  activation: Omit<ComplianceActivation, 'signature'> | null;
  notice: string;
};

const FIELDS: (keyof ComplianceActivation)[] = [
  'schema', 'jurisdiction', 'legalOpinionRef', 'licenceRef', 'providerApprovalRef',
  'ageVerificationProvider', 'amlOfficerRef', 'approvedBy', 'approvedAt', 'expiresAt',
];

export function activationPayload(input: ComplianceActivation): string {
  return JSON.stringify(FIELDS.map((key) => [key, input[key]]));
}

export function signActivation(input: Omit<ComplianceActivation, 'signature'>, key: string): string {
  return crypto.createHmac('sha256', key).update(activationPayload(input)).digest('hex');
}

function verifySignature(manifest: ComplianceActivation, key: string): boolean {
  if (!manifest.signature || !/^[0-9a-f]{64}$/i.test(manifest.signature)) return false;
  const expected = signActivation(manifest, key);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(manifest.signature, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function loadActivation(): { manifest: ComplianceActivation | null; error: string | null } {
  if (!fs.existsSync(env.complianceActivationPath)) {
    return { manifest: null, error: 'Signed compliance activation manifest is not present' };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(env.complianceActivationPath, 'utf8')) as ComplianceActivation;
    if (parsed.schema !== 1) return { manifest: null, error: 'Unsupported activation manifest schema' };
    for (const field of FIELDS) {
      const value = parsed[field];
      if (value === undefined || value === null || value === '') {
        return { manifest: null, error: `Activation manifest field ${field} is missing` };
      }
      if (field !== 'schema' && typeof value === 'string' && value.trim().length < 2) {
        return { manifest: null, error: `Activation manifest field ${field} is missing` };
      }
    }
    if (!env.complianceSigningKey || env.complianceSigningKey.length < 32) {
      return { manifest: null, error: 'COMPLIANCE_SIGNING_KEY is not configured (32+ characters required)' };
    }
    if (!verifySignature(parsed, env.complianceSigningKey)) {
      return { manifest: null, error: 'Activation manifest signature is invalid' };
    }
    if (Number.isNaN(Date.parse(parsed.expiresAt)) || Date.parse(parsed.expiresAt) <= Date.now()) {
      return { manifest: null, error: 'Activation manifest has expired' };
    }
    const { signature: _signature, ...safe } = parsed;
    return { manifest: { ...safe }, error: null };
  } catch (error) {
    return { manifest: null, error: `Activation manifest could not be read: ${(error as Error).message}` };
  }
}

export function evaluateCompliance(): ComplianceState {
  const blockers: string[] = [];
  const testMode = env.operatingMode === 'test';
  if (env.operatingMode !== 'test' && env.operatingMode !== 'free' && env.operatingMode !== 'real') {
    blockers.push('OPERATING_MODE must be free, test or real');
  }
  if (env.operatingMode === 'real') {
    if (!env.legalAuthorisationVerified) blockers.push('Independent legal authorisation has not been verified');
    if (!env.providerApprovalVerified) blockers.push('Payment-provider merchant approval has not been verified');
    if (!env.ageVerificationProvider) blockers.push('An 18+ age-verification integration is not configured');
    const { manifest, error } = loadActivation();
    if (error) blockers.push(error);
    if (manifest && manifest.ageVerificationProvider !== env.ageVerificationProvider) {
      blockers.push('Age-verification provider does not match the signed manifest');
    }
    return {
      realMoneyEnabled: blockers.length === 0,
      competitionsEnabled: true,
      testMode: false,
      blockers,
      activation: manifest,
      notice: blockers.length
        ? 'Real-money competitions are disabled. Free chess remains available.'
        : 'Authorised real-money mode. All paid competitions require immutable accepted terms.',
    };
  }
  if (env.operatingMode === 'test') {
    return {
      realMoneyEnabled: false,
      competitionsEnabled: true,
      testMode: true,
      blockers: ['Internal test mode uses isolated, clearly labelled test credits; no real money is accepted.'],
      activation: null,
      notice: 'INTERNAL TEST MODE: test credits have no cash value and cannot be withdrawn.',
    };
  }
  return {
    realMoneyEnabled: false,
    competitionsEnabled: false,
    testMode: false,
    blockers: ['Paid competitions are disabled until legal and provider approval is verified.'],
    activation: null,
    notice: 'Free chess mode. Paid competitions are not available.',
  };
}
