#!/usr/bin/env -S npx tsx
/**
 * Calibration certificate tool for a trust root (core4#388/#435, backend#931).
 *
 *   npx tsx scripts/calibration-certificate.ts keygen  --key <file> --root-id <id> --subject <name>
 *   npx tsx scripts/calibration-certificate.ts sign    --key <file> --subject <name> --station <alias|id>
 *                                                     [--owner 0x..] [--days 365] [--sensor ..] [--method ..]
 *                                                     [--reference ..] [--notes ..] [--artifact-id ..] --out <file>
 *   npx tsx scripts/calibration-certificate.ts revoke  --key <file> --artifact-id <id> --reason <reason> --out <file>
 *   npx tsx scripts/calibration-certificate.ts verify  --file <cert.json> --roots '<CALIBRATION_TRUST_ROOTS_JSON>'
 *   npx tsx scripts/calibration-certificate.ts submit  --file <cert.json|revocation.json> --api <backend base URL>
 *
 * keygen writes a NEW ed25519 private key (PKCS#8 PEM, mode 0600, never overwrites) and prints only
 * the public trust-root entry to paste into CALIBRATION_TRUST_ROOTS_JSON. The private key is never
 * printed, sent or committed: keep the file offline (owner-held key on testnet).
 *
 * sign builds a `wrf-calibration-attestation/v1` certificate for the station's PUBLIC alias (a raw id
 * is converted locally; it is never written into the certificate) and signs it with the #931
 * contract: ed25519 over sha3-256(sorted-key JSON minus signature.value). Free-text fields must not
 * contain personal data (no names, emails, phone numbers): identity is the alias and owner wallet.
 *
 * submit POSTs the file to <api>/api/calibration-certificates (or /revocations for a revocation).
 * The public edge does not admit these POSTs; run it from the operator network against the backend.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign as cryptoSign } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  CALIBRATION_SIGNATURE_ALGORITHM,
  computeCalibrationSignedDigest,
  parseCalibrationArtifact,
  parseCalibrationTrustRoots,
  type CalibrationAttestationArtifactV1,
} from '../server/services/calibration-attestation-verifier.js';
import {
  CALIBRATION_REVOCATION_REASONS,
  CALIBRATION_REVOCATION_SCHEMA,
  calibrationCertificateCid,
  computeRevocationSignedDigest,
  evaluateCalibrationCertificate,
  parseCalibrationRevocation,
  verifyCalibrationRevocation,
  type CalibrationRevocationV1,
} from '../server/services/calibration-certificates.js';

const STATION_ALIAS_RE = /^st_[0-9a-f]{12}$/;

function args(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!flag.startsWith('--')) throw new Error(`unexpected argument: ${flag}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
    out[flag.slice(2)] = value;
    i += 1;
  }
  return out;
}

function need(opts: Record<string, string>, name: string): string {
  const value = opts[name];
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

/** Same derivation as server/utils/station-alias.js (owner ruling 2026-09-27). */
export function stationAliasOf(stationIdOrAlias: string): string {
  if (STATION_ALIAS_RE.test(stationIdOrAlias)) return stationIdOrAlias;
  return `st_${createHash('sha256').update(`wrfcoin-station-alias-v1:${stationIdOrAlias}`, 'utf8').digest('hex').slice(0, 12)}`;
}

function loadKey(path: string) {
  const privateKey = createPrivateKey(readFileSync(path));
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('the key file is not an ed25519 key');
  const raw = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
  return { privateKey, publicKeyHex: Buffer.from(raw).toString('hex') };
}

function writeNew(path: string, text: string, mode = 0o644) {
  if (existsSync(path)) throw new Error(`${path} already exists; refusing to overwrite`);
  writeFileSync(path, text, { mode, flag: 'wx' });
}

function keygen(opts: Record<string, string>) {
  const keyPath = need(opts, 'key');
  const rootId = need(opts, 'root-id');
  const subject = need(opts, 'subject');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  writeNew(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), 0o600);
  const publicKeyHex = Buffer.from(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)).toString('hex');
  console.log(`Wrote a new private key to ${keyPath} (mode 0600). Keep it offline; it is not printed.`);
  console.log('Trust-root entry for CALIBRATION_TRUST_ROOTS_JSON (public key only):');
  console.log(JSON.stringify([{ rootId, subject, publicKeyHex, active: true }]));
}

export function buildCertificate(input: {
  publicKeyHex: string;
  subject: string;
  stationAlias: string;
  ownerAddress?: string;
  issuedAt: Date;
  expiresAt: Date;
  artifactId: string;
  calibration?: Record<string, string>;
}): CalibrationAttestationArtifactV1 {
  const fingerprint = createHash('sha256').update(Buffer.from(input.publicKeyHex, 'hex')).digest('hex');
  const issuedAt = input.issuedAt.toISOString();
  const expiresAt = input.expiresAt.toISOString();
  return {
    schemaVersion: 'wrf-calibration-attestation/v1',
    artifactId: input.artifactId,
    subject: { stationId: input.stationAlias, ...(input.ownerAddress ? { ownerAddress: input.ownerAddress } : {}) },
    ...(input.calibration && Object.keys(input.calibration).length > 0 ? { calibration: input.calibration } : {}),
    issuer: {
      issuerId: input.subject,
      certificateChain: [
        { certId: `${input.artifactId}-signer`, subject: input.subject, issuer: input.subject, notBefore: issuedAt, notAfter: expiresAt, fingerprintSha256: fingerprint },
      ],
    },
    attestation: { issuedAt, expiresAt },
    signature: { algorithm: CALIBRATION_SIGNATURE_ALGORITHM, value: '', signerPublicKey: input.publicKeyHex },
  };
}

function sign(opts: Record<string, string>) {
  const { privateKey, publicKeyHex } = loadKey(need(opts, 'key'));
  const out = need(opts, 'out');
  const days = Number(opts.days ?? '365');
  if (!Number.isInteger(days) || days < 1 || days > 1825) throw new Error('--days must be 1..1825');
  const owner = opts.owner?.toLowerCase();
  if (owner !== undefined && !/^0x[0-9a-f]{40}$/.test(owner)) throw new Error('--owner must be a 0x + 40 hex wallet address');
  const calibration: Record<string, string> = {};
  for (const field of ['sensor', 'method', 'reference', 'notes']) if (opts[field]) calibration[field] = opts[field];
  // Back-date issuance a minute so a submit right away is not "not yet valid" on a server whose clock
  // runs slightly behind the signer's.
  const issuedAt = new Date(Date.now() - 60_000);
  const artifact = buildCertificate({
    publicKeyHex,
    subject: need(opts, 'subject'),
    stationAlias: stationAliasOf(need(opts, 'station')),
    ownerAddress: owner,
    issuedAt,
    expiresAt: new Date(issuedAt.getTime() + days * 86_400_000),
    artifactId: opts['artifact-id'] ?? `cal-${randomUUID()}`,
    calibration,
  });
  const signed = { ...artifact, signature: { ...artifact.signature, value: cryptoSign(null, computeCalibrationSignedDigest(artifact), privateKey).toString('hex') } };
  const parsed = parseCalibrationArtifact(signed);
  if (!parsed) throw new Error('the certificate does not pass the v1 schema (check field lengths)');
  writeNew(out, `${JSON.stringify(signed, null, 2)}\n`);
  console.log(`Signed ${signed.artifactId} for ${signed.subject.stationId}, valid until ${signed.attestation.expiresAt}.`);
  console.log(`Content id: ${calibrationCertificateCid(parsed.raw)}. Wrote ${out}.`);
}

function revoke(opts: Record<string, string>) {
  const { privateKey, publicKeyHex } = loadKey(need(opts, 'key'));
  const reason = need(opts, 'reason');
  if (!(CALIBRATION_REVOCATION_REASONS as readonly string[]).includes(reason)) {
    throw new Error(`--reason must be one of: ${CALIBRATION_REVOCATION_REASONS.join(', ')}`);
  }
  const unsigned: CalibrationRevocationV1 = {
    schemaVersion: CALIBRATION_REVOCATION_SCHEMA,
    artifactId: need(opts, 'artifact-id'),
    reason: reason as CalibrationRevocationV1['reason'],
    revokedAt: new Date().toISOString(),
    signature: { algorithm: CALIBRATION_SIGNATURE_ALGORITHM, signerPublicKey: publicKeyHex, value: '' },
  };
  const value = cryptoSign(null, computeRevocationSignedDigest(unsigned), privateKey).toString('hex');
  const signed = { ...unsigned, signature: { ...unsigned.signature, value } };
  writeNew(need(opts, 'out'), `${JSON.stringify(signed, null, 2)}\n`);
  console.log(`Signed a revocation of ${signed.artifactId} (${reason}).`);
}

async function verify(opts: Record<string, string>) {
  const doc = JSON.parse(readFileSync(need(opts, 'file'), 'utf8'));
  const roots = parseCalibrationTrustRoots(need(opts, 'roots'));
  if (doc?.schemaVersion === CALIBRATION_REVOCATION_SCHEMA) {
    const revocation = parseCalibrationRevocation(doc);
    const check = revocation ? verifyCalibrationRevocation(revocation, roots) : { ok: false, code: 'CAL_REVOCATION_SCHEMA_INVALID' };
    console.log(JSON.stringify(check));
    process.exitCode = check.ok ? 0 : 1;
    return;
  }
  const parsed = parseCalibrationArtifact(doc);
  if (!parsed) {
    console.log(JSON.stringify({ status: 'invalid', reasonCodes: ['CAL_ARTIFACT_SCHEMA_INVALID'] }));
    process.exitCode = 1;
    return;
  }
  const evaluation = await evaluateCalibrationCertificate(parsed.raw, { trustRoots: roots });
  console.log(JSON.stringify({ cid: calibrationCertificateCid(parsed.raw), ...evaluation }));
  process.exitCode = evaluation.status === 'calibrated' ? 0 : 1;
}

async function submit(opts: Record<string, string>) {
  const doc = JSON.parse(readFileSync(need(opts, 'file'), 'utf8'));
  const base = need(opts, 'api').replace(/\/+$/, '');
  const path = doc?.schemaVersion === CALIBRATION_REVOCATION_SCHEMA ? '/api/calibration-certificates/revocations' : '/api/calibration-certificates';
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(doc),
  });
  console.log(`${response.status} ${await response.text()}`);
  process.exitCode = response.ok ? 0 : 1;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const opts = args(rest);
  switch (command) {
  case 'keygen': return keygen(opts);
  case 'sign': return sign(opts);
  case 'revoke': return revoke(opts);
  case 'verify': return verify(opts);
  case 'submit': return submit(opts);
  default:
    console.error('usage: calibration-certificate.ts keygen|sign|revoke|verify|submit [--flags]; see the header of this file');
    process.exitCode = 2;
  }
}

if (process.argv[1] && /calibration-certificate\.ts$/.test(process.argv[1])) {
  main().catch(error => {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
