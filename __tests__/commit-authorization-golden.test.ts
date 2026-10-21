/**
 * #1284: golden vector for the commit-authorization preimage a phone signs.
 *
 * Pinned from core4 `shared-protocol/tests/fixtures/golden/signing_preimage_v2.json`
 * (case `commit_authorization_v2`, core4 origin/main c4d0a1190), which core4
 * generates from `commit_authorization_message_with_domain` and signs with the
 * seed-900101 test key. The preimage must match byte-for-byte, the golden
 * signature must verify over it, and the tampered twin must change the bytes
 * and fail the signature — so an implementation that echoes a constant or
 * ignores a field cannot pass.
 */
import crypto from 'node:crypto';
import { describe, expect, it } from '@jest/globals';
import {
  buildCommitAuthorizationMessage,
  COMMIT_AUTH_DOMAIN,
} from '../shared/commit-authorization';

const GOLDEN = {
  input: {
    chainId: 'wrfcoin-testnet',
    networkId: 'testnet',
    stationId: 'station-gv-1',
    commitId: 'commit-gv-auth-1',
    contributionType: 'weather',
  },
  tamperedInput: {
    chainId: 'wrfcoin-testnet',
    networkId: 'testnet',
    stationId: 'station-gv-1',
    commitId: 'commit-gv-auth-2',
    contributionType: 'weather',
  },
  preimageHex:
    '777266636f696e5f636f6d6d69745f617574685f76320f000000777266636f696e2d746573746e657407000000746573746e65740c00000073746174696f6e2d67762d3110000000636f6d6d69742d67762d617574682d310700000077656174686572',
  publicKeyHex: '87d795e0f67a76f42590f20b9a9a2495513962ebc798f94ccc697b3d5e833abf',
  signatureHex:
    'e7d9e3d36719c67da9c110d6ab3544b5d19232c11ba0a94eab319104e655f3c53a6ba9c1625f0c01ce2228fd3ab3dc360b14dc4cd02bb8812f2a467febafbb04',
};

function ed25519PublicKey(rawHex: string): crypto.KeyObject {
  // SPKI DER prefix for a raw 32-byte ed25519 public key.
  const der = Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'),
    Buffer.from(rawHex, 'hex'),
  ]);
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}

describe('commit authorization preimage (core4 commit_authorization_message_with_domain)', () => {
  it('uses the core4 v2 domain tag', () => {
    expect(COMMIT_AUTH_DOMAIN).toBe('wrfcoin_commit_auth_v2');
  });

  it('reproduces the core4 golden preimage byte-for-byte', () => {
    expect(buildCommitAuthorizationMessage(GOLDEN.input).toString('hex')).toBe(
      GOLDEN.preimageHex
    );
  });

  it('the core4 golden signature verifies over the built preimage', () => {
    const ok = crypto.verify(
      null,
      buildCommitAuthorizationMessage(GOLDEN.input),
      ed25519PublicKey(GOLDEN.publicKeyHex),
      Buffer.from(GOLDEN.signatureHex, 'hex')
    );
    expect(ok).toBe(true);
  });

  it('the tampered twin changes the preimage and fails the golden signature', () => {
    const tampered = buildCommitAuthorizationMessage(GOLDEN.tamperedInput);
    expect(tampered.toString('hex')).not.toBe(GOLDEN.preimageHex);
    const ok = crypto.verify(
      null,
      tampered,
      ed25519PublicKey(GOLDEN.publicKeyHex),
      Buffer.from(GOLDEN.signatureHex, 'hex')
    );
    expect(ok).toBe(false);
  });

  it('length-prefixes every field, so moving bytes between fields changes the preimage', () => {
    const a = buildCommitAuthorizationMessage({ ...GOLDEN.input, stationId: 'ab', commitId: 'c' });
    const b = buildCommitAuthorizationMessage({ ...GOLDEN.input, stationId: 'a', commitId: 'bc' });
    expect(a.equals(b)).toBe(false);
  });

  it('counts UTF-8 bytes, not UTF-16 code units, in the u32-LE length prefix', () => {
    const msg = buildCommitAuthorizationMessage({ ...GOLDEN.input, stationId: 'é' });
    const tagLen = Buffer.byteLength(COMMIT_AUTH_DOMAIN);
    const chainLen = 4 + Buffer.byteLength(GOLDEN.input.chainId);
    const netLen = 4 + Buffer.byteLength(GOLDEN.input.networkId);
    expect(msg.readUInt32LE(tagLen + chainLen + netLen)).toBe(2);
  });
});
