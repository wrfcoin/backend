import fs from 'fs';
import path from 'path';
import express from 'express';
import { describe, test, expect, beforeEach } from '@jest/globals';

const request = require('supertest');

import { createCalibrationAttestationVerifierRouters } from '../../server/routes/calibration-attestation-verifier.js';
import {
  CalibrationAttestationVerifierService,
  InMemoryCalibrationAttestationArtifactResolver,
  CalibrationVerificationReasonCodes,
} from '../../server/services/calibration-attestation-verifier.js';

function assertEnvelopeTopLevel(body: Record<string, any>): void {
  expect(body).toHaveProperty('ok');
  expect(typeof body.ok).toBe('boolean');
  expect(body).toHaveProperty('meta');
  expect(body.meta).toBeTruthy();
  expect(typeof body.meta.request_id).toBe('string');
  expect(body.meta.request_id.length).toBeGreaterThan(0);
  expect(typeof body.meta.timestamp).toBe('string');
  expect(typeof body.meta.api_version).toBe('string');
}

function assertSuccessEnvelope(res: any): void {
  assertEnvelopeTopLevel(res.body);
  expect(res.body.ok).toBe(true);
  expect(res.body.data).toBeTruthy();
  expect(res.body.error).toBeNull();
  expect(res.headers['x-request-id']).toBe(res.body.meta.request_id);
}

function assertErrorEnvelope(res: any, code: string): void {
  assertEnvelopeTopLevel(res.body);
  expect(res.body.ok).toBe(false);
  expect(res.body.data).toBeNull();
  expect(res.body.error).toBeTruthy();
  expect(res.body.error.code).toBe(code);
  expect(typeof res.body.error.message).toBe('string');
  expect(res.body.error.message.length).toBeGreaterThan(0);
  expect(res.headers['x-request-id']).toBe(res.body.meta.request_id);
}

function loadFixture(fileName: string): unknown {
  const fixturePath = path.resolve(
    __dirname,
    '..',
    'fixtures',
    'calibration-attestations',
    fileName,
  );
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
}

describe('Calibration attestation verifier integration (#435)', () => {
  const validCid =
    'ipfs:bafybeigdyrzt2w7m3u5kwf5m6u4w7j2g3ctj7hwv7xwm3pt6z4f6xv2f3e';
  const staleCid = 'arweave:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const revokedCid = 'arweave:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const clonedCid = 'arweave:ccccccccccccccccccccccccccccccccccccccccccc';

  const now = new Date('2026-02-28T12:00:00.000Z');
  const trustRoots = [
    {
      rootId: 'wrf-root-ca-1',
      subject: 'WRF Root CA',
      fingerprintSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      active: true,
    },
  ];
  const revokedCertificates = [
    {
      fingerprintSha256: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      reason: 'key_compromise',
      revokedAt: '2026-02-10T00:00:00.000Z',
    },
  ];

  let app: express.Express;

  beforeEach(() => {
    const resolver = new InMemoryCalibrationAttestationArtifactResolver();
    resolver.registerFixture(validCid, loadFixture('valid-station-a.json'));
    resolver.registerFixture(staleCid, loadFixture('stale-station-a.json'));
    resolver.registerFixture(revokedCid, loadFixture('revoked-station-a.json'));
    resolver.registerFixture(clonedCid, loadFixture('cloned-station-b.json'));

    const verifierService = new CalibrationAttestationVerifierService({
      artifactResolver: resolver,
      trustRoots,
      revokedCertificates,
      now: () => new Date(now.toISOString()),
    });
    const routers = createCalibrationAttestationVerifierRouters(verifierService);

    app = express();
    app.use(express.json());
    app.use('/api/calibration-attestations', routers.apiRouter);
    app.use('/api/indexer/calibration-attestations', routers.indexerRouter);
  });

  test('rejects the legacy ECDSA fixture with a SPECIFIC unsupported-algorithm reason', async () => {
    const res = await request(app).post('/api/calibration-attestations/verify').send({
      commitId: 'commit-valid-1',
      stationId: 'station-a',
      calibrationAttestationCid: `ipfs://${validCid.replace('ipfs:', '')}`,
    });

    expect(res.status).toBe(200);
    assertSuccessEnvelope(res);
    expect(res.body.data.status).toBe('rejected');
    expect(res.body.data.reasonCodes).toEqual([
      CalibrationVerificationReasonCodes.UNSUPPORTED_ALG,
    ]);
    expect(res.body.data.canonicalCalibrationAttestationCid).toBe(validCid);
    expect(res.body.data.schemaVersion).toBe(
      'calibration_attestation_verifier_summary/v1',
    );
  });

  test('rejects stale artifact with explicit expiry reason code', async () => {
    const res = await request(app).post('/api/calibration-attestations/verify').send({
      commitId: 'commit-stale-1',
      stationId: 'station-a',
      calibrationAttestationCid: staleCid,
    });

    expect(res.status).toBe(200);
    assertSuccessEnvelope(res);
    expect(res.body.data.status).toBe('rejected');
    expect(res.body.data.reasonCodes).toContain(
      CalibrationVerificationReasonCodes.ATTESTATION_EXPIRED,
    );
  });

  test('rejects revoked artifact with explicit revocation reason code', async () => {
    const res = await request(app).post('/api/calibration-attestations/verify').send({
      commitId: 'commit-revoked-1',
      stationId: 'station-a',
      calibrationAttestationCid: revokedCid,
    });

    expect(res.status).toBe(200);
    assertSuccessEnvelope(res);
    expect(res.body.data.status).toBe('rejected');
    expect(res.body.data.reasonCodes).toContain(
      CalibrationVerificationReasonCodes.CERT_REVOKED,
    );
  });

  test('rejects cloned artifact reuse across stations', async () => {
    const first = await request(app).post('/api/calibration-attestations/verify').send({
      commitId: 'commit-clone-first',
      stationId: 'station-a',
      calibrationAttestationCid: validCid,
    });

    expect(first.status).toBe(200);
    assertSuccessEnvelope(first);
    expect(first.body.data.status).toBe('rejected');

    const second = await request(app).post('/api/calibration-attestations/verify').send({
      commitId: 'commit-clone-second',
      stationId: 'station-b',
      calibrationAttestationCid: clonedCid,
    });

    expect(second.status).toBe(200);
    assertSuccessEnvelope(second);
    expect(second.body.data.status).toBe('rejected');
    expect(second.body.data.reasonCodes).toContain(
      CalibrationVerificationReasonCodes.UNSUPPORTED_ALG,
    );
  });

  test('indexer endpoint returns normalized summaries with status filters', async () => {
    await request(app).post('/api/calibration-attestations/verify').send({
      commitId: 'commit-indexer-ok',
      stationId: 'station-a',
      calibrationAttestationCid: validCid,
    });

    await request(app).post('/api/calibration-attestations/verify').send({
      commitId: 'commit-indexer-stale',
      stationId: 'station-a',
      calibrationAttestationCid: staleCid,
    });

    const allRes = await request(app).get(
      '/api/indexer/calibration-attestations/verification-summaries',
    );
    expect(allRes.status).toBe(200);
    assertSuccessEnvelope(allRes);
    expect(allRes.body.data.count).toBe(2);

    const filtered = await request(app).get(
      '/api/indexer/calibration-attestations/verification-summaries?status=rejected',
    );
    expect(filtered.status).toBe(200);
    assertSuccessEnvelope(filtered);
    expect(filtered.body.data.count).toBe(2);
    expect(filtered.body.data.summaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'rejected',
          reasonCodes: expect.arrayContaining([
            CalibrationVerificationReasonCodes.UNSUPPORTED_ALG,
          ]),
        }),
      ]),
    );
  });

  test('returns issue-366 style error envelope on invalid input', async () => {
    const invalid = await request(app).post('/api/calibration-attestations/verify').send({
      stationId: 'station-a',
      calibrationAttestationCid: validCid,
    });

    expect(invalid.status).toBe(400);
    assertErrorEnvelope(invalid, 'INVALID_PARAMS');
  });
});

describe('Comprehensive reason code coverage (#440)', () => {
  const now = new Date('2026-02-28T12:00:00.000Z');

  const trustRoots = [
    {
      rootId: 'wrf-root-ca-1',
      subject: 'WRF Root CA',
      fingerprintSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      active: true,
    },
  ];

  function cloneValidArtifact(): any {
    return JSON.parse(JSON.stringify(loadFixture('valid-station-a.json')));
  }

  function makeApp(options: {
    fixtures?: Array<{ cid: string; artifact: unknown }>;
    trustRoots?: any[];
    artifactResolver?: any;
    revokedCertificates?: any[];
  } = {}): express.Express {
    const resolver = options.artifactResolver ?? new InMemoryCalibrationAttestationArtifactResolver();
    if (!options.artifactResolver && options.fixtures) {
      for (const fixture of options.fixtures) {
        (resolver as InMemoryCalibrationAttestationArtifactResolver).registerFixture(
          fixture.cid,
          fixture.artifact,
        );
      }
    }

    const verifierService = new CalibrationAttestationVerifierService({
      artifactResolver: resolver,
      trustRoots: options.trustRoots ?? trustRoots,
      revokedCertificates: options.revokedCertificates ?? [],
      now: () => new Date(now.toISOString()),
    });
    const routers = createCalibrationAttestationVerifierRouters(verifierService);

    const app = express();
    app.use(express.json());
    app.use('/api/calibration-attestations', routers.apiRouter);
    app.use('/api/indexer/calibration-attestations', routers.indexerRouter);
    return app;
  }

  // --- CID & Artifact Resolution ---

  test('rejects an arbitrary non-empty signature instead of treating it as verified', async () => {
    const artifact = cloneValidArtifact();
    artifact.signature.value = 'definitely-not-a-cryptographic-signature';
    const cid = 'arweave:mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm';
    const app = makeApp({ fixtures: [{ cid, artifact }] });

    const res = await request(app).post('/api/calibration-attestations/verify').send({
      commitId: 'commit-signature-unverifiable',
      stationId: 'station-a',
      calibrationAttestationCid: cid,
    });

    expect(res.status).toBe(200);
    assertSuccessEnvelope(res);
    expect(res.body.data.status).toBe('rejected');
    expect(res.body.data.reasonCodes).toContain(
      CalibrationVerificationReasonCodes.UNSUPPORTED_ALG,
    );
    expect(res.body.data.status).not.toBe('verified');
  });

  test('rejects malformed CID with CAL_CID_INVALID', async () => {
    const app = makeApp({ fixtures: [] });

    const res = await request(app).post('/api/calibration-attestations/verify').send({
      commitId: 'commit-cid-invalid',
      stationId: 'station-a',
      calibrationAttestationCid: 'not-a-cid',
    });

    expect(res.status).toBe(200);
    assertSuccessEnvelope(res);
    expect(res.body.data.status).toBe('rejected');
    expect(res.body.data.reasonCodes).toContain(
      CalibrationVerificationReasonCodes.CID_INVALID,
    );
  });

  test('rejects missing artifact with CAL_ARTIFACT_NOT_FOUND', async () => {
    const app = makeApp({ fixtures: [] });

    const res = await request(app).post('/api/calibration-attestations/verify').send({
      commitId: 'commit-not-found',
      stationId: 'station-a',
      calibrationAttestationCid:
        'ipfs:bafybeigdyrzt2w7m3u5kwf5m6u4w7j2g3ctj7hwv7xwm3pt6z4f6xv2f3e',
    });

    expect(res.status).toBe(200);
    assertSuccessEnvelope(res);
    expect(res.body.data.status).toBe('rejected');
    expect(res.body.data.reasonCodes).toContain(
      CalibrationVerificationReasonCodes.ARTIFACT_NOT_FOUND,
    );
  });

  test('returns error status on artifact fetch exception with CAL_ARTIFACT_FETCH_ERROR', async () => {
    const throwingResolver = {
      async fetchByCanonicalCid(_canonicalCid: string): Promise<unknown | null> {
        throw new Error('network failure');
      },
    };
    const app = makeApp({ artifactResolver: throwingResolver });

    const res = await request(app).post('/api/calibration-attestations/verify').send({
      commitId: 'commit-fetch-error',
      stationId: 'station-a',
      calibrationAttestationCid:
        'arweave:ddddddddddddddddddddddddddddddddddddddddddd',
    });

    expect(res.status).toBe(502);
    assertSuccessEnvelope(res);
    expect(res.body.data.status).toBe('error');
    expect(res.body.data.reasonCodes).toContain(
      CalibrationVerificationReasonCodes.ARTIFACT_FETCH_ERROR,
    );
  });

  test('rejects artifact with wrong schema version with CAL_ARTIFACT_SCHEMA_INVALID', async () => {
    const wrongSchemaArtifact = { schemaVersion: 'wrong/v99', artifactId: 'x' };
    const cid = 'arweave:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const app = makeApp({ fixtures: [{ cid, artifact: wrongSchemaArtifact }] });

    const res = await request(app).post('/api/calibration-attestations/verify').send({
      commitId: 'commit-schema-invalid',
      stationId: 'station-a',
      calibrationAttestationCid: cid,
    });

    expect(res.status).toBe(200);
    assertSuccessEnvelope(res);
    expect(res.body.data.status).toBe('rejected');
    expect(res.body.data.reasonCodes).toContain(
      CalibrationVerificationReasonCodes.ARTIFACT_SCHEMA_INVALID,
    );
  });

  // --- Attestation & Station Validation ---

  test('rejects station mismatch with CAL_SUBJECT_STATION_MISMATCH', async () => {
    const validArtifact = cloneValidArtifact();
    const cid =
      'ipfs:bafybeigdyrzt2w7m3u5kwf5m6u4w7j2g3ctj7hwv7xwm3pt6z4f6xv2f3e';
    const app = makeApp({ fixtures: [{ cid, artifact: validArtifact }] });

    const res = await request(app).post('/api/calibration-attestations/verify').send({
      commitId: 'commit-station-mismatch',
      stationId: 'station-x',
      calibrationAttestationCid: cid,
    });

    expect(res.status).toBe(200);
    assertSuccessEnvelope(res);
    expect(res.body.data.status).toBe('rejected');
    expect(res.body.data.reasonCodes).toContain(
      CalibrationVerificationReasonCodes.SUBJECT_STATION_MISMATCH,
    );
  });

  test('rejects inverted time window with CAL_ATTESTATION_TIME_WINDOW_INVALID', async () => {
    const artifact = cloneValidArtifact();
    artifact.attestation.issuedAt = '2026-12-31T00:00:00.000Z';
    artifact.attestation.expiresAt = '2026-01-01T00:00:00.000Z';
    const cid = 'arweave:fffffffffffffffffffffffffffffffffffffffffff';
    const app = makeApp({ fixtures: [{ cid, artifact }] });

    const res = await request(app).post('/api/calibration-attestations/verify').send({
      commitId: 'commit-inverted-window',
      stationId: 'station-a',
      calibrationAttestationCid: cid,
    });

    expect(res.status).toBe(200);
    assertSuccessEnvelope(res);
    expect(res.body.data.status).toBe('rejected');
    expect(res.body.data.reasonCodes).toContain(
      CalibrationVerificationReasonCodes.ATTESTATION_TIME_WINDOW_INVALID,
    );
  });

  test('rejects future-dated attestation with CAL_ATTESTATION_NOT_YET_VALID', async () => {
    const artifact = cloneValidArtifact();
    artifact.attestation.issuedAt = '2030-01-01T00:00:00.000Z';
    artifact.attestation.expiresAt = '2031-01-01T00:00:00.000Z';
    const cid = 'arweave:ggggggggggggggggggggggggggggggggggggggggggg';
    const app = makeApp({ fixtures: [{ cid, artifact }] });

    const res = await request(app).post('/api/calibration-attestations/verify').send({
      commitId: 'commit-future-dated',
      stationId: 'station-a',
      calibrationAttestationCid: cid,
    });

    expect(res.status).toBe(200);
    assertSuccessEnvelope(res);
    expect(res.body.data.status).toBe('rejected');
    expect(res.body.data.reasonCodes).toContain(
      CalibrationVerificationReasonCodes.ATTESTATION_NOT_YET_VALID,
    );
  });

  // --- Certificate Chain & Trust Root ---

  test('rejects empty certificate chain with CAL_CERT_CHAIN_MISSING', async () => {
    const artifact = cloneValidArtifact();
    artifact.issuer.certificateChain = [];
    const cid = 'arweave:hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh';
    const app = makeApp({ fixtures: [{ cid, artifact }] });

    const res = await request(app).post('/api/calibration-attestations/verify').send({
      commitId: 'commit-chain-missing',
      stationId: 'station-a',
      calibrationAttestationCid: cid,
    });

    expect(res.status).toBe(200);
    assertSuccessEnvelope(res);
    expect(res.body.data.status).toBe('rejected');
    expect(res.body.data.reasonCodes).toContain(
      CalibrationVerificationReasonCodes.CERT_CHAIN_MISSING,
    );
  });

  test('rejects broken certificate chain with CAL_CERT_CHAIN_BROKEN', async () => {
    const artifact = cloneValidArtifact();
    artifact.issuer.certificateChain[0].subject = 'Wrong Subject';
    const cid = 'arweave:iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii';
    const app = makeApp({ fixtures: [{ cid, artifact }] });

    const res = await request(app).post('/api/calibration-attestations/verify').send({
      commitId: 'commit-chain-broken',
      stationId: 'station-a',
      calibrationAttestationCid: cid,
    });

    expect(res.status).toBe(200);
    assertSuccessEnvelope(res);
    expect(res.body.data.status).toBe('rejected');
    expect(res.body.data.reasonCodes).toContain(
      CalibrationVerificationReasonCodes.CERT_CHAIN_BROKEN,
    );
  });

  test('rejects future-dated certificate with CAL_CERT_NOT_YET_VALID', async () => {
    const artifact = cloneValidArtifact();
    artifact.issuer.certificateChain[0].notBefore = '2030-01-01T00:00:00.000Z';
    artifact.issuer.certificateChain[0].notAfter = '2035-01-01T00:00:00.000Z';
    const cid = 'arweave:jjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjj';
    const app = makeApp({ fixtures: [{ cid, artifact }] });

    const res = await request(app).post('/api/calibration-attestations/verify').send({
      commitId: 'commit-cert-future',
      stationId: 'station-a',
      calibrationAttestationCid: cid,
    });

    expect(res.status).toBe(200);
    assertSuccessEnvelope(res);
    expect(res.body.data.status).toBe('rejected');
    expect(res.body.data.reasonCodes).toContain(
      CalibrationVerificationReasonCodes.CERT_NOT_YET_VALID,
    );
  });

  test('rejects expired certificate with CAL_CERT_EXPIRED', async () => {
    const artifact = cloneValidArtifact();
    artifact.issuer.certificateChain[0].notBefore = '2020-01-01T00:00:00.000Z';
    artifact.issuer.certificateChain[0].notAfter = '2024-01-01T00:00:00.000Z';
    const cid = 'arweave:kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk';
    const app = makeApp({ fixtures: [{ cid, artifact }] });

    const res = await request(app).post('/api/calibration-attestations/verify').send({
      commitId: 'commit-cert-expired',
      stationId: 'station-a',
      calibrationAttestationCid: cid,
    });

    expect(res.status).toBe(200);
    assertSuccessEnvelope(res);
    expect(res.body.data.status).toBe('rejected');
    expect(res.body.data.reasonCodes).toContain(
      CalibrationVerificationReasonCodes.CERT_EXPIRED,
    );
  });

  test('rejects when no trust roots configured with CAL_TRUST_ROOT_UNCONFIGURED', async () => {
    const artifact = cloneValidArtifact();
    const cid =
      'ipfs:bafybeigdyrzt2w7m3u5kwf5m6u4w7j2g3ctj7hwv7xwm3pt6z4f6xv2f3e';
    const app = makeApp({ fixtures: [{ cid, artifact }], trustRoots: [] });

    const res = await request(app).post('/api/calibration-attestations/verify').send({
      commitId: 'commit-no-trust-roots',
      stationId: 'station-a',
      calibrationAttestationCid: cid,
    });

    expect(res.status).toBe(200);
    assertSuccessEnvelope(res);
    expect(res.body.data.status).toBe('rejected');
    expect(res.body.data.reasonCodes).toContain(
      CalibrationVerificationReasonCodes.TRUST_ROOT_UNCONFIGURED,
    );
  });

  test('rejects unknown root fingerprint with CAL_ISSUER_UNTRUSTED_ROOT', async () => {
    const artifact = cloneValidArtifact();
    artifact.issuer.certificateChain[2].fingerprintSha256 =
      'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
    const cid = 'arweave:lllllllllllllllllllllllllllllllllllllllllll';
    const app = makeApp({ fixtures: [{ cid, artifact }] });

    const res = await request(app).post('/api/calibration-attestations/verify').send({
      commitId: 'commit-untrusted-root',
      stationId: 'station-a',
      calibrationAttestationCid: cid,
    });

    expect(res.status).toBe(200);
    assertSuccessEnvelope(res);
    expect(res.body.data.status).toBe('rejected');
    expect(res.body.data.reasonCodes).toContain(
      CalibrationVerificationReasonCodes.ISSUER_UNTRUSTED_ROOT,
    );
  });

  // --- GET Endpoint Coverage ---

  test('GET status/:verificationId returns summary and 404 on unknown', async () => {
    const cid =
      'ipfs:bafybeigdyrzt2w7m3u5kwf5m6u4w7j2g3ctj7hwv7xwm3pt6z4f6xv2f3e';
    const artifact = cloneValidArtifact();
    const app = makeApp({ fixtures: [{ cid, artifact }] });

    const postRes = await request(app).post('/api/calibration-attestations/verify').send({
      commitId: 'commit-get-by-id',
      stationId: 'station-a',
      calibrationAttestationCid: cid,
    });

    expect(postRes.status).toBe(200);
    assertSuccessEnvelope(postRes);
    expect(postRes.body.data.status).toBe('rejected');
    const verificationId = postRes.body.data.verificationId;
    expect(typeof verificationId).toBe('string');

    const getRes = await request(app).get(
      `/api/calibration-attestations/status/${verificationId}`,
    );
    expect(getRes.status).toBe(200);
    assertSuccessEnvelope(getRes);
    expect(getRes.body.data.verificationId).toBe(verificationId);
    expect(getRes.body.data.status).toBe('rejected');
    expect(getRes.body.data.commitId).toBe('commit-get-by-id');

    const notFoundRes = await request(app).get(
      '/api/calibration-attestations/status/0000000000000000000000000000000000000000000000000000000000000000',
    );
    expect(notFoundRes.status).toBe(404);
    assertErrorEnvelope(notFoundRes, 'VERIFICATION_NOT_FOUND');
  });

  test('GET status/by-commit/:commitId returns summary and 404 on unknown', async () => {
    const cid =
      'ipfs:bafybeigdyrzt2w7m3u5kwf5m6u4w7j2g3ctj7hwv7xwm3pt6z4f6xv2f3e';
    const artifact = cloneValidArtifact();
    const app = makeApp({ fixtures: [{ cid, artifact }] });

    const postRes = await request(app).post('/api/calibration-attestations/verify').send({
      commitId: 'commit-get-by-commit',
      stationId: 'station-a',
      calibrationAttestationCid: cid,
    });

    expect(postRes.status).toBe(200);
    assertSuccessEnvelope(postRes);
    expect(postRes.body.data.status).toBe('rejected');

    const getRes = await request(app).get(
      '/api/calibration-attestations/status/by-commit/commit-get-by-commit',
    );
    expect(getRes.status).toBe(200);
    assertSuccessEnvelope(getRes);
    expect(getRes.body.data.commitId).toBe('commit-get-by-commit');
    expect(getRes.body.data.status).toBe('rejected');

    const notFoundRes = await request(app).get(
      '/api/calibration-attestations/status/by-commit/nonexistent-commit',
    );
    expect(notFoundRes.status).toBe(404);
    assertErrorEnvelope(notFoundRes, 'VERIFICATION_NOT_FOUND');
  });
});
