/**
 * #931 — real cryptographic verification of calibration attestations.
 *
 * Keypairs are generated at test time (no static key material in the repo).
 * The load-bearing suite is the ASYMMETRIC control demanded on the issue:
 * a pristine artifact VERIFIES, and corrupting only the signature — or only
 * the payload under an intact signature — flips it to rejected. #947's blunt
 * reject-everything guard cannot pass these tests.
 */

import { createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'crypto';
import {
  CalibrationAttestationVerifierService,
  CalibrationVerificationReasonCodes,
  CALIBRATION_SIGNATURE_ALGORITHM,
  computeCalibrationSignedDigest,
  InMemoryCalibrationAttestationArtifactResolver,
} from '../../server/services/calibration-attestation-verifier.js';

const NOW = new Date('2026-07-31T12:00:00.000Z');

function rawEd25519PublicKeyHex(publicKey: KeyObject): string {
  // SPKI DER for ed25519 is a fixed 12-byte prefix + the 32 raw key bytes.
  const der = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return der.subarray(der.length - 32).toString('hex');
}

function makeSignedFixture() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const signerPublicKey = rawEd25519PublicKeyHex(publicKey);
  const fingerprint = createHash('sha256')
    .update(Buffer.from(signerPublicKey, 'hex'))
    .digest('hex');

  const artifact = {
    schemaVersion: 'wrf-calibration-attestation/v1' as const,
    artifactId: 'artifact-real-sig-1',
    subject: { stationId: 'station-real' },
    issuer: {
      issuerId: 'WRF Calibration Lab',
      certificateChain: [
        {
          certId: 'cert-lab-1',
          subject: 'WRF Calibration Lab',
          issuer: 'WRF Calibration Lab',
          notBefore: '2026-01-01T00:00:00.000Z',
          notAfter: '2027-01-01T00:00:00.000Z',
          fingerprintSha256: fingerprint,
        },
      ],
    },
    attestation: {
      issuedAt: '2026-07-01T00:00:00.000Z',
      expiresAt: '2026-12-31T00:00:00.000Z',
    },
    signature: {
      algorithm: CALIBRATION_SIGNATURE_ALGORITHM,
      value: '',
      signerPublicKey,
    },
  };

  const digest = computeCalibrationSignedDigest(artifact as never);
  artifact.signature.value = cryptoSign(null, digest, privateKey).toString('hex');

  const trustRoots = [
    {
      rootId: 'wrf-cal-lab-root',
      subject: 'WRF Calibration Lab',
      fingerprintSha256: fingerprint,
      active: true,
    },
  ];

  return { artifact, trustRoots, privateKey, signerPublicKey };
}

function makeService(artifact: unknown, trustRoots: unknown[]) {
  const resolver = new InMemoryCalibrationAttestationArtifactResolver();
  const cid = 'arweave:rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr';
  resolver.registerFixture(cid, artifact);
  const service = new CalibrationAttestationVerifierService({
    artifactResolver: resolver,
    trustRoots: trustRoots as never,
    revokedCertificates: [],
    now: () => new Date(NOW.toISOString()),
  });
  return { service, cid };
}

async function verify(artifact: unknown, trustRoots: unknown[], stationId = 'station-real') {
  const { service, cid } = makeService(artifact, trustRoots);
  return service.verifyCalibrationAttestation({
    commitId: 'commit-real-1',
    stationId,
    calibrationAttestationCid: cid,
  });
}

describe('#931 real signature verification — asymmetric control', () => {
  it('a pristine, correctly signed artifact VERIFIES with CAL_OK', async () => {
    const { artifact, trustRoots } = makeSignedFixture();
    const summary = await verify(artifact, trustRoots);
    expect(summary.status).toBe('verified');
    expect(summary.reasonCodes).toEqual([CalibrationVerificationReasonCodes.OK]);
    expect(summary.trustRootId).toBe('wrf-cal-lab-root');
  });

  it('corrupting ONLY the signature flips verified -> rejected (CAL_SIGNATURE_INVALID)', async () => {
    const { artifact, trustRoots } = makeSignedFixture();
    const corrupted = JSON.parse(JSON.stringify(artifact));
    const sig = corrupted.signature.value.split('');
    sig[0] = sig[0] === 'a' ? 'b' : 'a';
    corrupted.signature.value = sig.join('');
    const summary = await verify(corrupted, trustRoots);
    expect(summary.status).toBe('rejected');
    expect(summary.reasonCodes).toContain(
      CalibrationVerificationReasonCodes.SIGNATURE_INVALID,
    );
  });

  it('corrupting ONLY a payload field under an intact signature flips verified -> rejected', async () => {
    const { artifact, trustRoots } = makeSignedFixture();
    const tampered = JSON.parse(JSON.stringify(artifact));
    tampered.artifactId = 'artifact-real-sig-1-TAMPERED';
    const summary = await verify(tampered, trustRoots);
    expect(summary.status).toBe('rejected');
    expect(summary.reasonCodes).toContain(
      CalibrationVerificationReasonCodes.SIGNATURE_INVALID,
    );
  });

  it('a signature from a DIFFERENT key over the same payload rejects', async () => {
    const { artifact, trustRoots } = makeSignedFixture();
    const { privateKey: otherKey } = generateKeyPairSync('ed25519');
    const forged = JSON.parse(JSON.stringify(artifact));
    const digest = computeCalibrationSignedDigest(forged);
    forged.signature.value = cryptoSign(null, digest, otherKey).toString('hex');
    const summary = await verify(forged, trustRoots);
    expect(summary.status).toBe('rejected');
    expect(summary.reasonCodes).toContain(
      CalibrationVerificationReasonCodes.SIGNATURE_INVALID,
    );
  });
});

describe('#931 specific failure modes (not a blanket guard)', () => {
  it('unknown algorithm -> CAL_UNSUPPORTED_ALG, specifically', async () => {
    const { artifact, trustRoots } = makeSignedFixture();
    const modified = JSON.parse(JSON.stringify(artifact));
    modified.signature.algorithm = 'ECDSA_P256_SHA256';
    const summary = await verify(modified, trustRoots);
    expect(summary.status).toBe('rejected');
    expect(summary.reasonCodes).toContain(
      CalibrationVerificationReasonCodes.UNSUPPORTED_ALG,
    );
  });

  it('malformed signer key -> CAL_SIGNER_KEY_INVALID', async () => {
    const { artifact, trustRoots } = makeSignedFixture();
    const modified = JSON.parse(JSON.stringify(artifact));
    modified.signature.signerPublicKey = 'zz-not-hex';
    const summary = await verify(modified, trustRoots);
    expect(summary.status).toBe('rejected');
    expect(summary.reasonCodes).toContain(
      CalibrationVerificationReasonCodes.SIGNER_KEY_INVALID,
    );
  });

  it('a signer key not bound to the certificate chain -> CAL_SIGNER_NOT_BOUND_TO_CHAIN', async () => {
    const { artifact, trustRoots } = makeSignedFixture();
    const other = makeSignedFixture(); // different key, self-consistent artifact
    const swapped = JSON.parse(JSON.stringify(artifact));
    // Present the OTHER key (and its valid-for-that-key signature) against
    // THIS artifact's chain fingerprint.
    swapped.signature.signerPublicKey = other.artifact.signature.signerPublicKey;
    const digest = computeCalibrationSignedDigest(swapped);
    swapped.signature.value = cryptoSign(null, digest, other.privateKey).toString('hex');
    const summary = await verify(swapped, trustRoots);
    expect(summary.status).toBe('rejected');
    expect(summary.reasonCodes).toContain(
      CalibrationVerificationReasonCodes.SIGNER_NOT_BOUND_TO_CHAIN,
    );
  });

  it('chain depth > 1 -> CAL_CHAIN_DEPTH_UNSUPPORTED (stated, not silently accepted)', async () => {
    const { artifact, trustRoots } = makeSignedFixture();
    const deep = JSON.parse(JSON.stringify(artifact));
    deep.issuer.certificateChain.push({
      certId: 'cert-intermediate',
      subject: 'WRF Intermediate',
      issuer: 'WRF Intermediate',
      notBefore: '2026-01-01T00:00:00.000Z',
      notAfter: '2027-01-01T00:00:00.000Z',
      fingerprintSha256: 'ee'.repeat(32),
    });
    // keep artifact self-consistent for chain-link structure
    deep.issuer.certificateChain[0].issuer = 'WRF Intermediate';
    const digest = computeCalibrationSignedDigest(deep);
    const { privateKey } = generateKeyPairSync('ed25519');
    void privateKey; // signature invalid anyway; depth check fires first
    const summary = await verify(deep, trustRoots);
    expect(summary.status).toBe('rejected');
    expect(summary.reasonCodes).toContain(
      CalibrationVerificationReasonCodes.CHAIN_DEPTH_UNSUPPORTED,
    );
    void digest;
  });

  it('an untrusted root still rejects even with a valid signature (trust != validity)', async () => {
    const { artifact } = makeSignedFixture();
    const otherRoots = [
      {
        rootId: 'unrelated-root',
        subject: 'Somebody Else',
        fingerprintSha256: 'ff'.repeat(32),
        active: true,
      },
    ];
    const summary = await verify(artifact, otherRoots);
    expect(summary.status).toBe('rejected');
    expect(summary.reasonCodes).toContain(
      CalibrationVerificationReasonCodes.ISSUER_UNTRUSTED_ROOT,
    );
  });
});
