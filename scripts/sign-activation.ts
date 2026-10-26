import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../server/config/env.js';
import { signActivation, type ComplianceActivation } from '../server/config/compliance.js';

const draftPath = process.argv[2] ?? path.join(env.root, 'config', 'compliance-activation.draft.json');
const outputPath = process.argv[3] ?? env.complianceActivationPath;
const key = process.env.COMPLIANCE_SIGNING_KEY ?? env.complianceSigningKey;
if (!key || key.length < 32) {
  throw new Error('COMPLIANCE_SIGNING_KEY must be at least 32 characters and must not be committed to Git');
}
const draft = JSON.parse(fs.readFileSync(draftPath, 'utf8')) as Omit<ComplianceActivation, 'signature'>;
const required = ['jurisdiction', 'legalOpinionRef', 'licenceRef', 'providerApprovalRef', 'ageVerificationProvider', 'amlOfficerRef', 'approvedBy', 'approvedAt', 'expiresAt'];
for (const field of required) {
  if (!draft[field as keyof typeof draft] || String(draft[field as keyof typeof draft]).includes('REPLACE')) {
    throw new Error(`Draft field ${field} is missing or still contains a placeholder`);
  }
}
if (draft.schema !== 1) throw new Error('Draft schema must be 1');
const signed = { ...draft, signature: signActivation(draft, key) };
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(signed, null, 2) + '\n', { mode: 0o600 });
console.log(`Signed activation manifest written to ${outputPath}`);
console.log(`Manifest digest: ${crypto.createHash('sha256').update(JSON.stringify(signed)).digest('hex')}`);
