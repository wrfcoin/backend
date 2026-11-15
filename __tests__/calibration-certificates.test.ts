/**
 * Station calibration certificates (core4#388/#435, backend#931): a trust root signs, the backend
 * verifies and stores, anyone reads the station's status. Real ed25519 keys throughout; the signer
 * side is the shipped CLI's own builder (scripts/calibration-certificate.ts).
 */
import express from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { describe, expect, it, test, beforeAll, afterAll } from '@jest/globals';
import {
  computeCalibrationSignedDigest,
  parseCalibrationTrustRoots,
  type CalibrationAttestationArtifactV1,
  type CalibrationTrustRoot,
} from '../server/services/calibration-attestation-verifier.js';
import {
  CALIBRATION_REVOCATION_SCHEMA,
  InMemoryCalibrationCertificateStore,
  calibrationCertificateCid,
  computeRevocationSignedDigest,
  createPgCalibrationCertificateStore,
  type CalibrationRevocationV1,
} from '../server/services/calibration-certificates.js';
import { createCalibrationCertificateRouter, type CalibrationCertificateDeps } from '../server/routes/calibration-certificate-routes.js';
import { buildCertificate, stationAliasOf } from '../scripts/calibration-certificate.js';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { stationAlias } = require('../server/utils/station-alias.js');

// A raw id that carries a personal name: it must never be signed, stored or returned.
const RAW_STATION = 'PWS-DULUTH-JANEDOE-01';
const ALIAS = stationAlias(RAW_STATION) as string;
const OWNER = '0x' + 'ab'.repeat(20);
const SUBJECT = 'WRFCoin owner (testnet)';
const T0 = Date.parse('2026-11-01T12:00:00Z');

function keypair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyHex = Buffer.from(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)).toString('hex');
  return { privateKey, publicKeyHex };
}
const root = keypair();
const stranger = keypair();
const rootsFor = (k: { publicKeyHex: string }, rootId = 'wrfcoin-owner-testnet'): CalibrationTrustRoot[] =>
  parseCalibrationTrustRoots(JSON.stringify([{ rootId, subject: SUBJECT, publicKeyHex: k.publicKeyHex, active: true }]));

function signCert(
  key: { privateKey: KeyObject; publicKeyHex: string },
  over: Partial<{ station: string; artifactId: string; issuedAt: number; days: number; calibration: Record<string, string>; owner: string }> = {},
) {
  const issuedAt = new Date(over.issuedAt ?? T0 - 60_000);
  const artifact = buildCertificate({
    publicKeyHex: key.publicKeyHex,
    subject: SUBJECT,
    stationAlias: over.station ?? ALIAS,
    ownerAddress: over.owner ?? OWNER,
    issuedAt,
    expiresAt: new Date(issuedAt.getTime() + (over.days ?? 365) * 86_400_000),
    artifactId: over.artifactId ?? 'cal-test-1',
    calibration: over.calibration ?? { sensor: 'Davis 6152 temp/RH', method: 'two-point salt test', reference: 'NIST-traceable thermometer #T-77' },
  });
  return { ...artifact, signature: { ...artifact.signature, value: cryptoSign(null, computeCalibrationSignedDigest(artifact), key.privateKey).toString('hex') } };
}

function signRevocation(key: { privateKey: KeyObject; publicKeyHex: string }, artifactId: string, reason: CalibrationRevocationV1['reason'] = 'sensor_replaced') {
  const unsigned: CalibrationRevocationV1 = {
    schemaVersion: CALIBRATION_REVOCATION_SCHEMA, artifactId, reason, revokedAt: new Date(T0 + 1000).toISOString(),
    signature: { algorithm: 'ed25519-sha3-256-json-v1', signerPublicKey: key.publicKeyHex, value: '' },
  };
  return { ...unsigned, signature: { ...unsigned.signature, value: cryptoSign(null, computeRevocationSignedDigest(unsigned), key.privateKey).toString('hex') } };
}

function app(over: Partial<CalibrationCertificateDeps> & { clock?: { now: number }; roots?: { list: CalibrationTrustRoot[] } } = {}) {
  const clock = over.clock ?? { now: T0 };
  const roots = over.roots ?? { list: rootsFor(root) };
  const a = express();
  a.use(express.json());
  a.use('/api/calibration-certificates', createCalibrationCertificateRouter({
    store: new InMemoryCalibrationCertificateStore(() => new Date(clock.now)),
    trustRoots: () => roots.list,
    revokedCertificates: () => [],
    stationExists: async (alias) => (alias === ALIAS ? 'found' : 'not_found'),
    enabled: () => true,
    now: () => new Date(clock.now),
    readRateLimit: null,
    writeRateLimit: null,
    ...over,
  }));
  return { app: a, clock, roots };
}

const noRawId = (body: unknown) => expect(JSON.stringify(body).toLowerCase()).not.toContain('janedoe');

describe('calibration certificates: sign, submit, read', () => {
  it('a trust-root-signed certificate is stored and the station reads as calibrated, with the full signed JSON', async () => {
    const { app: a } = app();
    const cert = signCert(root);
    const posted = await request(a).post('/api/calibration-certificates').send(cert);
    expect(posted.status).toBe(201);
    expect(posted.body).toMatchObject({ success: true, created: true, status: 'calibrated', artifactId: 'cal-test-1', stationAlias: ALIAS, trustRootId: 'wrfcoin-owner-testnet' });
    expect(posted.body.cid).toMatch(/^b[a-z2-7]{58}$/);

    const read = await request(a).get(`/api/calibration-certificates/station/${ALIAS}`);
    expect(read.status).toBe(200);
    expect(read.headers['cache-control']).toBe('public, max-age=60');
    expect(read.body).toMatchObject({
      stationAlias: ALIAS, status: 'calibrated',
      certificate: {
        cid: posted.body.cid, status: 'calibrated', reasonCodes: ['CAL_OK'], ownerAddress: OWNER,
        issuer: { issuerId: SUBJECT, trustRootId: 'wrfcoin-owner-testnet' },
        calibration: { sensor: 'Davis 6152 temp/RH', method: 'two-point salt test' }, revocation: null,
      },
      history: [],
      trustRoots: [{ rootId: 'wrfcoin-owner-testnet', subject: SUBJECT, publicKeyHex: root.publicKeyHex }],
    });
    expect(read.body.certificate.artifact.signature.value).toBe(cert.signature.value);
    noRawId(read.body);
    noRawId(posted.body);
  });

  it('re-submitting the same bytes is idempotent; a different certificate reusing the artifact id is a clone (409)', async () => {
    const { app: a } = app();
    const cert = signCert(root);
    expect((await request(a).post('/api/calibration-certificates').send(cert)).status).toBe(201);
    const again = await request(a).post('/api/calibration-certificates').send(cert);
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    const clone = signCert(root, { calibration: { sensor: 'another sensor' } });
    const res = await request(a).post('/api/calibration-certificates').send(clone);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CAL_ARTIFACT_CLONED');
  });

  it('the newest certificate decides the status; older ones are listed without their bodies', async () => {
    const { app: a } = app();
    await request(a).post('/api/calibration-certificates').send(signCert(root, { artifactId: 'old', issuedAt: T0 - 86_400_000 }));
    await request(a).post('/api/calibration-certificates').send(signCert(root, { artifactId: 'new' }));
    const read = await request(a).get(`/api/calibration-certificates/station/${ALIAS}`);
    expect(read.body.certificate.artifactId).toBe('new');
    expect(read.body.history.map((h: any) => h.artifactId)).toEqual(['old']);
    expect(read.body.history[0].artifact).toBeUndefined();
  });

  it('a station with no certificate reads as none', async () => {
    const { app: a } = app();
    const read = await request(a).get(`/api/calibration-certificates/station/${ALIAS}`);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ status: 'none', certificate: null, history: [] });
  });
});

describe('calibration certificates: what is refused', () => {
  it('fails closed with no trust roots: submit 503, read lists no roots', async () => {
    const { app: a } = app({ roots: { list: [] } });
    const res = await request(a).post('/api/calibration-certificates').send(signCert(root));
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('CAL_TRUST_ROOT_UNCONFIGURED');
    const read = await request(a).get(`/api/calibration-certificates/station/${ALIAS}`);
    expect(read.body).toMatchObject({ status: 'none', trustRoots: [] });
  });

  it('rejects a certificate signed by a key that is not a trust root', async () => {
    const { app: a } = app();
    const res = await request(a).post('/api/calibration-certificates').send(signCert(stranger));
    expect(res.status).toBe(422);
    expect(res.body.error.reasonCodes).toContain('CAL_ISSUER_UNTRUSTED_ROOT');
  });

  it('rejects a certificate whose signed calibration details were edited after signing', async () => {
    const { app: a } = app();
    const cert = signCert(root);
    const tampered = { ...cert, calibration: { ...cert.calibration, reference: 'made up' } };
    const res = await request(a).post('/api/calibration-certificates').send(tampered);
    expect(res.status).toBe(422);
    expect(res.body.error.reasonCodes).toEqual(['CAL_SIGNATURE_INVALID']);
  });

  it('rejects an edited owner wallet the same way', async () => {
    const { app: a } = app();
    const cert = signCert(root);
    const res = await request(a).post('/api/calibration-certificates').send({ ...cert, subject: { ...cert.subject, ownerAddress: '0x' + 'cd'.repeat(20) } });
    expect(res.status).toBe(422);
    expect(res.body.error.reasonCodes).toEqual(['CAL_SIGNATURE_INVALID']);
  });

  it('refuses a raw station id as the subject (it can carry a personal name)', async () => {
    const { app: a } = app();
    const res = await request(a).post('/api/calibration-certificates').send(signCert(root, { station: RAW_STATION }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CAL_SUBJECT_MUST_BE_STATION_ALIAS');
    noRawId(res.body);
  });

  it('refuses an unknown station (404) and fails closed when the lookup is down (503)', async () => {
    const other = stationAlias('some-other-station');
    const { app: a } = app();
    expect((await request(a).post('/api/calibration-certificates').send(signCert(root, { station: other }))).status).toBe(404);
    const { app: down } = app({ stationExists: async () => 'unavailable' });
    expect((await request(down).post('/api/calibration-certificates').send(signCert(root))).status).toBe(503);
  });

  it('refuses an already-expired or not-yet-valid certificate', async () => {
    const { app: a } = app();
    const expired = await request(a).post('/api/calibration-certificates').send(signCert(root, { issuedAt: T0 - 10 * 86_400_000, days: 2 }));
    expect(expired.status).toBe(422);
    expect(expired.body.error.reasonCodes).toContain('CAL_ATTESTATION_EXPIRED');
    const future = await request(a).post('/api/calibration-certificates').send(signCert(root, { issuedAt: T0 + 3_600_000 }));
    expect(future.status).toBe(422);
    expect(future.body.error.reasonCodes).toContain('CAL_ATTESTATION_NOT_YET_VALID');
  });

  it('rejects malformed bodies and free text over the length bound', async () => {
    const { app: a } = app();
    expect((await request(a).post('/api/calibration-certificates').send({ hello: 'world' })).status).toBe(400);
    const long = signCert(root, { calibration: { notes: 'x'.repeat(201) } });
    expect((await request(a).post('/api/calibration-certificates').send(long)).status).toBe(400);
    const extra = signCert(root, { calibration: { email: 'someone@example.com' } as any });
    expect((await request(a).post('/api/calibration-certificates').send(extra)).status).toBe(400);
  });

  it('answers 404 for a raw station id read and for every path while the flag is off', async () => {
    const { app: a } = app();
    expect((await request(a).get(`/api/calibration-certificates/station/${RAW_STATION}`)).status).toBe(404);
    const { app: off } = app({ enabled: () => false });
    expect((await request(off).get(`/api/calibration-certificates/station/${ALIAS}`)).status).toBe(404);
    expect((await request(off).post('/api/calibration-certificates').send(signCert(root))).status).toBe(404);
    expect((await request(off).post('/api/calibration-certificates/revocations').send({})).status).toBe(404);
  });
});

describe('calibration certificates: expiry, revocation and trust changes show on read', () => {
  it('reads as expired once the validity window has passed (no job needed)', async () => {
    const { app: a, clock } = app();
    await request(a).post('/api/calibration-certificates').send(signCert(root, { days: 30 }));
    clock.now = T0 + 31 * 86_400_000;
    const read = await request(a).get(`/api/calibration-certificates/station/${ALIAS}`);
    expect(read.body.status).toBe('expired');
    expect(read.body.certificate.reasonCodes).toContain('CAL_ATTESTATION_EXPIRED');
  });

  it('a revocation signed by the trust root revokes; one signed by anyone else is refused', async () => {
    const { app: a } = app();
    await request(a).post('/api/calibration-certificates').send(signCert(root));
    const forged = await request(a).post('/api/calibration-certificates/revocations').send(signRevocation(stranger, 'cal-test-1'));
    expect(forged.status).toBe(403);
    expect(forged.body.error.code).toBe('CAL_ISSUER_UNTRUSTED_ROOT');
    const bad = signRevocation(root, 'cal-test-1');
    const tampered = await request(a).post('/api/calibration-certificates/revocations').send({ ...bad, reason: 'other' });
    expect(tampered.status).toBe(403);
    expect(tampered.body.error.code).toBe('CAL_SIGNATURE_INVALID');
    const unknown = await request(a).post('/api/calibration-certificates/revocations').send(signRevocation(root, 'no-such-cert'));
    expect(unknown.status).toBe(404);

    const ok = await request(a).post('/api/calibration-certificates/revocations').send(signRevocation(root, 'cal-test-1'));
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ created: true, artifactId: 'cal-test-1', reason: 'sensor_replaced' });
    const read = await request(a).get(`/api/calibration-certificates/station/${ALIAS}`);
    expect(read.body.status).toBe('revoked');
    expect(read.body.certificate.revocation).toMatchObject({ reason: 'sensor_replaced' });
    // A revoked certificate cannot be re-submitted.
    const again = await request(a).post('/api/calibration-certificates').send(signCert(root));
    expect(again.status).toBe(422);
    expect(again.body.error.reasonCodes).toEqual(['CAL_CERT_REVOKED']);
  });

  it('reads as not_trusted when its root is removed from the configuration', async () => {
    const { app: a, roots } = app();
    await request(a).post('/api/calibration-certificates').send(signCert(root));
    roots.list = rootsFor(stranger, 'someone-else');
    const read = await request(a).get(`/api/calibration-certificates/station/${ALIAS}`);
    expect(read.body.status).toBe('not_trusted');
  });
});

describe('trust-root configuration and content ids', () => {
  it('pins a root by public key, accepts a matching fingerprint, drops a mismatched or malformed entry', () => {
    const fp = createHash('sha256').update(Buffer.from(root.publicKeyHex, 'hex')).digest('hex');
    expect(parseCalibrationTrustRoots(JSON.stringify([{ rootId: 'r', subject: 's', publicKeyHex: root.publicKeyHex }]))[0].fingerprintSha256).toBe(fp);
    expect(parseCalibrationTrustRoots(JSON.stringify([{ rootId: 'r', subject: 's', publicKeyHex: root.publicKeyHex, fingerprintSha256: fp }]))).toHaveLength(1);
    expect(parseCalibrationTrustRoots(JSON.stringify([{ rootId: 'r', subject: 's', publicKeyHex: root.publicKeyHex, fingerprintSha256: 'a'.repeat(64) }]))).toHaveLength(0);
    expect(parseCalibrationTrustRoots(JSON.stringify([{ rootId: 'r', subject: 's', publicKeyHex: 'not-hex' }]))).toHaveLength(0);
    expect(parseCalibrationTrustRoots(JSON.stringify([{ rootId: 'r', subject: 's', fingerprintSha256: fp }]))[0].publicKeyHex).toBeUndefined();
    expect(parseCalibrationTrustRoots('<owner public key here>')).toEqual([]);
  });

  it('the content id is a CIDv1 raw sha2-256 of the canonical JSON and ignores key order', () => {
    const cert = signCert(root) as CalibrationAttestationArtifactV1;
    const reordered = JSON.parse(JSON.stringify({ signature: cert.signature, attestation: cert.attestation, issuer: cert.issuer, calibration: cert.calibration, subject: cert.subject, artifactId: cert.artifactId, schemaVersion: cert.schemaVersion }));
    const cid = calibrationCertificateCid(cert);
    expect(cid).toMatch(/^b[a-z2-7]{58}$/);
    expect(calibrationCertificateCid(reordered)).toBe(cid);
    // Multibase 'b' + base32("\x01\x55\x12\x20" + digest): the raw-codec CIDv1 prefix is "bafkrei".
    expect(cid.startsWith('bafkrei')).toBe(true);
  });

  it('the CLI converts a raw id to the same alias the backend computes', () => {
    expect(stationAliasOf(RAW_STATION)).toBe(ALIAS);
    expect(stationAliasOf(ALIAS)).toBe(ALIAS);
  });
});

const pgUrl = process.env.BACKFILL_TEST_PG_URL;
(pgUrl ? describe : describe.skip)('calibration certificates against real PostgreSQL (migration 0038)', () => {
  const schema = `calibration_cert_test_${process.pid}`;
  const pool = new Pool({ connectionString: pgUrl, options: `-c search_path=${schema}` });
  const store = createPgCalibrationCertificateStore((sql, params) => pool.query(sql, params as any[]));
  const up = readFileSync('drizzle/migrations/0038_calibration_certificates.sql', 'utf8');

  beforeAll(async () => {
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(up);
  }, 60000);
  afterAll(async () => {
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
  });

  test('stores, deduplicates, detects clones, orders by issuance and records the first revocation only', async () => {
    const cert = signCert(root, { artifactId: 'pg-1' }) as CalibrationAttestationArtifactV1;
    const row = { cid: calibrationCertificateCid(cert), artifactId: 'pg-1', stationAlias: ALIAS, artifact: cert, issuedAt: cert.attestation.issuedAt, expiresAt: cert.attestation.expiresAt };
    expect(await store.insertCertificate(row)).toBe('inserted');
    expect(await store.insertCertificate(row)).toBe('duplicate');
    const clone = signCert(root, { artifactId: 'pg-1', calibration: { sensor: 'x' } }) as CalibrationAttestationArtifactV1;
    expect(await store.insertCertificate({ ...row, cid: calibrationCertificateCid(clone), artifact: clone })).toBe('artifact_conflict');
    const newer = signCert(root, { artifactId: 'pg-2', issuedAt: T0 }) as CalibrationAttestationArtifactV1;
    expect(await store.insertCertificate({ cid: calibrationCertificateCid(newer), artifactId: 'pg-2', stationAlias: ALIAS, artifact: newer, issuedAt: newer.attestation.issuedAt, expiresAt: newer.attestation.expiresAt })).toBe('inserted');

    const rows = await store.certificatesForStation(ALIAS, 10);
    expect(rows.map(r => r.artifactId)).toEqual(['pg-2', 'pg-1']);
    // The stored JSON round-trips to the same content id (jsonb does not change what was signed).
    expect(calibrationCertificateCid(rows[1].artifact)).toBe(row.cid);
    expect((await store.certificateByArtifactId('pg-1'))?.cid).toBe(row.cid);

    const revocation = signRevocation(root, 'pg-1');
    expect(await store.insertRevocation({ artifactId: 'pg-1', reason: 'sensor_replaced', revokedAt: revocation.revokedAt, rootId: 'r', revocation })).toBe(true);
    expect(await store.insertRevocation({ artifactId: 'pg-1', reason: 'other', revokedAt: revocation.revokedAt, rootId: 'r', revocation })).toBe(false);
    const found = await store.revocationsFor(['pg-1', 'pg-2']);
    expect([...found.keys()]).toEqual(['pg-1']);
    expect(found.get('pg-1')?.reason).toBe('sensor_replaced');
  });

  test('the schema refuses a raw station id and a non-CID key', async () => {
    const cert = signCert(root, { artifactId: 'pg-raw' }) as CalibrationAttestationArtifactV1;
    await expect(store.insertCertificate({ cid: calibrationCertificateCid(cert), artifactId: 'pg-raw', stationAlias: RAW_STATION, artifact: cert, issuedAt: cert.attestation.issuedAt, expiresAt: cert.attestation.expiresAt })).rejects.toThrow();
    await expect(store.insertCertificate({ cid: 'Qm-not-a-v1-cid', artifactId: 'pg-raw2', stationAlias: ALIAS, artifact: cert, issuedAt: cert.attestation.issuedAt, expiresAt: cert.attestation.expiresAt })).rejects.toThrow();
  });

  test('migration 0038 is reversible: the documented down drops its tables and the up re-applies', async () => {
    const down = /-- Down \(reversible\): (.*)$/m.exec(up)?.[1];
    expect(down).toBe('DROP TABLE calibration_certificate_revocations; DROP TABLE calibration_certificates;');
    await pool.query(down as string);
    const left = await pool.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1`, [schema]);
    expect(left.rows[0].n).toBe(0);
    await pool.query(up);
    const back = await pool.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1`, [schema]);
    expect(back.rows[0].n).toBe(2);
  });
});
