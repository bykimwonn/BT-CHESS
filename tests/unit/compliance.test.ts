import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { env } = await import('../../server/config/env.js');
const { signActivation, activationPayload, loadActivation, evaluateCompliance } = await import('../../server/config/compliance.js');

test('activation signatures cover all material fields', () => {
  const manifest = {
    schema: 1 as const, jurisdiction: 'ZW', legalOpinionRef: 'LO-1', licenceRef: 'LIC-1',
    providerApprovalRef: 'PAY-1', ageVerificationProvider: 'Provider', amlOfficerRef: 'AML-1',
    approvedBy: 'Officer', approvedAt: '2026-10-26T00:00:00.000Z', expiresAt: '2027-10-26T00:00:00.000Z',
  };
  const signature = signActivation(manifest, 'a-compliance-signing-key-that-is-long-enough');
  assert.match(signature, /^[0-9a-f]{64}$/);
  const changed = { ...manifest, licenceRef: 'LIC-2' };
  assert.notEqual(activationPayload(manifest), activationPayload(changed));
  assert.notEqual(signature, signActivation(changed, 'a-compliance-signing-key-that-is-long-enough'));
});

test('real-money activation requires a valid signed manifest and independent flags', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rookstone-compliance-'));
  const activationPath = path.join(dir, 'activation.json');
  const key = 'a-compliance-signing-key-that-is-long-enough';
  const original = {
    path: env.complianceActivationPath, key: env.complianceSigningKey,
    legal: env.legalAuthorisationVerified, provider: env.providerApprovalVerified,
    age: env.ageVerificationProvider, mode: env.operatingMode,
  };
  try {
    const manifest = {
      schema: 1 as const, jurisdiction: 'ZW', legalOpinionRef: 'LO-1', licenceRef: 'LIC-1',
      providerApprovalRef: 'PAY-1', ageVerificationProvider: 'Approved18Plus', amlOfficerRef: 'AML-1',
      approvedBy: 'Compliance Officer', approvedAt: '2026-10-26T00:00:00.000Z', expiresAt: '2030-10-26T00:00:00.000Z',
    };
    fs.writeFileSync(activationPath, JSON.stringify({ ...manifest, signature: signActivation(manifest, key) }));
    env.complianceActivationPath = activationPath;
    env.complianceSigningKey = key;
    env.legalAuthorisationVerified = true;
    env.providerApprovalVerified = true;
    env.ageVerificationProvider = 'Approved18Plus';
    env.operatingMode = 'real';
    const valid = evaluateCompliance();
    assert.equal(valid.realMoneyEnabled, true, valid.blockers.join('; '));
    assert.equal(loadActivation().error, null);
    env.legalAuthorisationVerified = false;
    const blocked = evaluateCompliance();
    assert.equal(blocked.realMoneyEnabled, false);
    assert.ok(blocked.blockers.some((b) => /legal authorisation/i.test(b)));
    env.legalAuthorisationVerified = true;
    fs.writeFileSync(activationPath, JSON.stringify({ ...manifest, licenceRef: 'CHANGED', signature: signActivation(manifest, key) }));
    assert.match(loadActivation().error ?? '', /signature/i);
  } finally {
    env.complianceActivationPath = original.path;
    env.complianceSigningKey = original.key;
    env.legalAuthorisationVerified = original.legal;
    env.providerApprovalVerified = original.provider;
    env.ageVerificationProvider = original.age;
    env.operatingMode = original.mode;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
