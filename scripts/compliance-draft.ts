/**
 * Build the activation-manifest draft from environment variables.
 *
 *   npm run compliance:draft
 *
 * Every value must come from a document a human has actually verified: a legal
 * opinion, a licence, the provider's written approval, the identity provider's
 * contract and the named AML officer. This script refuses placeholders on
 * purpose. It writes config/compliance-activation.draft.json (mode 0600) and
 * never signs anything: signing uses COMPLIANCE_SIGNING_KEY through
 * `npm run compliance:sign` (scripts/sign-activation.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../server/config/env.js';

interface DraftField {
  key: string;
  env: string;
  description: string;
  value: string;
}

const now = new Date();
const inOneYear = new Date(now.getTime() + 365 * 86_400_000);

const fields: DraftField[] = [
  { key: 'jurisdiction', env: 'COMPLIANCE_JURISDICTION', description: 'jurisdiction code covered by the opinion and licence', value: (process.env.COMPLIANCE_JURISDICTION ?? 'ZW').trim() },
  { key: 'legalOpinionRef', env: 'COMPLIANCE_LEGAL_OPINION_REF', description: 'reference to the written legal opinion (firm + date)', value: (process.env.COMPLIANCE_LEGAL_OPINION_REF ?? '').trim() },
  { key: 'licenceRef', env: 'COMPLIANCE_LICENCE_REF', description: 'operator licence or written permission reference', value: (process.env.COMPLIANCE_LICENCE_REF ?? '').trim() },
  { key: 'providerApprovalRef', env: 'COMPLIANCE_PROVIDER_APPROVAL_REF', description: 'payment provider approval reference covering wagering', value: (process.env.COMPLIANCE_PROVIDER_APPROVAL_REF ?? '').trim() },
  { key: 'ageVerificationProvider', env: 'AGE_VERIFICATION_PROVIDER', description: 'contracted 18+ identity verification provider', value: env.ageVerificationProvider.trim() },
  { key: 'amlOfficerRef', env: 'COMPLIANCE_AML_OFFICER_REF', description: 'named AML/KYC officer or compliance officer record', value: (process.env.COMPLIANCE_AML_OFFICER_REF ?? '').trim() },
  { key: 'approvedBy', env: 'COMPLIANCE_APPROVED_BY', description: 'the human who approved this activation', value: (process.env.COMPLIANCE_APPROVED_BY ?? '').trim() },
  { key: 'approvedAt', env: 'COMPLIANCE_APPROVED_AT', description: 'ISO timestamp of approval', value: (process.env.COMPLIANCE_APPROVED_AT ?? now.toISOString()) },
  { key: 'expiresAt', env: 'COMPLIANCE_EXPIRES_AT', description: 'ISO expiry (never more than 12 months out)', value: (process.env.COMPLIANCE_EXPIRES_AT ?? inOneYear.toISOString()) },
];

const PLACEHOLDER = /^(replace|todo|tbd|changeme|example|xxx+)/i;

const missing = fields.filter((field) => !field.value || field.value.length < 2 || PLACEHOLDER.test(field.value));
const badDates = fields
  .filter((field) => field.key === 'approvedAt' || field.key === 'expiresAt')
  .filter((field) => Number.isNaN(Date.parse(field.value)));

if (missing.length || badDates.length) {
  console.error('The activation draft cannot be created yet. Missing or placeholder values:\n');
  for (const field of missing) console.error(`  - ${field.env}: ${field.description}`);
  for (const field of badDates) console.error(`  - ${field.env}: must be an ISO timestamp (received "${field.value}")`);
  console.error('\nThese values must reference real, independently verified documents.');
  console.error('The software cannot create or verify a licence, a legal opinion or provider approval.');
  console.error('See docs/GO-LIVE.md and docs/COMPLIANCE.md.\n');
  process.exit(1);
}

const approvedAt = Date.parse(fields.find((f) => f.key === 'approvedAt')!.value);
const expiresAt = Date.parse(fields.find((f) => f.key === 'expiresAt')!.value);
if (expiresAt <= approvedAt) {
  console.error('COMPLIANCE_EXPIRES_AT must be after COMPLIANCE_APPROVED_AT.');
  process.exit(1);
}
if (expiresAt - approvedAt > 366 * 86_400_000) {
  console.error('COMPLIANCE_EXPIRES_AT is more than a year after approval. Shorten the review period.');
  process.exit(1);
}

const manifest = {
  schema: 1,
  jurisdiction: fields.find((f) => f.key === 'jurisdiction')!.value,
  legalOpinionRef: fields.find((f) => f.key === 'legalOpinionRef')!.value,
  licenceRef: fields.find((f) => f.key === 'licenceRef')!.value,
  providerApprovalRef: fields.find((f) => f.key === 'providerApprovalRef')!.value,
  ageVerificationProvider: fields.find((f) => f.key === 'ageVerificationProvider')!.value,
  amlOfficerRef: fields.find((f) => f.key === 'amlOfficerRef')!.value,
  approvedBy: fields.find((f) => f.key === 'approvedBy')!.value,
  approvedAt: fields.find((f) => f.key === 'approvedAt')!.value,
  expiresAt: fields.find((f) => f.key === 'expiresAt')!.value,
};

const target = process.argv[2] ?? path.join(env.root, 'config', 'compliance-activation.draft.json');
if (target.endsWith('compliance-activation.json')) {
  console.error('Refusing to write the draft over a signed manifest. Use the .draft.json name and sign it afterwards.');
  process.exit(1);
}
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(target, 0o600);

console.log(`Wrote ${target} (mode 0600, gitignored).`);
console.log('Next steps:');
console.log('  1. Have the compliance officer review and approve this exact file out of band.');
console.log('  2. Sign it with a key that is not stored with the deployment secrets:');
console.log(`       COMPLIANCE_SIGNING_KEY='<separate key>' npm run compliance:sign -- ${target} config/compliance-activation.json`);
console.log('  3. Point COMPLIANCE_ACTIVATION_PATH at the signed file and run `npm run preflight`.');
