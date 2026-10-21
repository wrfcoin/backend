import crypto from 'crypto';
import { describe, expect, it } from '@jest/globals';
import {
  rollbackCoordinator,
  RollbackReason,
} from '../shared/bridge-rollback-coordinator.js';

const rollbackSigningKeyPair = crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: {
    type: 'spki',
    format: 'pem',
  },
  privateKeyEncoding: {
    type: 'pkcs8',
    format: 'pem',
  },
});

describe('Bridge Rollback Signature', () => {
  it('creates a signed rollback message that verifies with the matching public key', () => {
    const signedMessage = rollbackCoordinator.createSignedRollbackMessage(
      'rollback-123',
      '0xtxhash',
      RollbackReason.DESTINATION_MINT_FAILED,
      rollbackSigningKeyPair.privateKey
    );

    expect(signedMessage.signature).not.toBe(`0x${'00'.repeat(64)}`);
    expect(
      rollbackCoordinator.verifyRollbackSignature(
        signedMessage,
        rollbackSigningKeyPair.publicKey
      )
    ).toBe(true);
  });

  it('rejects tampered rollback messages', () => {
    const signedMessage = rollbackCoordinator.createSignedRollbackMessage(
      'rollback-456',
      '0xoriginal',
      RollbackReason.FRAUD_DETECTED,
      rollbackSigningKeyPair.privateKey
    );

    expect(
      rollbackCoordinator.verifyRollbackSignature(
        {
          ...signedMessage,
          transactionHash: '0xtampered',
        },
        rollbackSigningKeyPair.publicKey
      )
    ).toBe(false);

    expect(
      rollbackCoordinator.verifyRollbackSignature(
        {
          ...signedMessage,
          reason: RollbackReason.MANUAL_INTERVENTION,
        },
        rollbackSigningKeyPair.publicKey
      )
    ).toBe(false);
  });

  it('rejects legacy placeholder signatures and mismatched hashes', () => {
    const signedMessage = rollbackCoordinator.createSignedRollbackMessage(
      'rollback-789',
      '0xrollback',
      RollbackReason.SIGNATURE_TIMEOUT,
      rollbackSigningKeyPair.privateKey
    );

    expect(
      rollbackCoordinator.verifyRollbackSignature(
        {
          ...signedMessage,
          signature: `0x${'00'.repeat(65)}`,
        },
        rollbackSigningKeyPair.publicKey
      )
    ).toBe(false);

    expect(
      rollbackCoordinator.verifyRollbackSignature(
        {
          ...signedMessage,
          messageHash: `0x${'ab'.repeat(32)}`,
        },
        rollbackSigningKeyPair.publicKey
      )
    ).toBe(false);
  });
});
