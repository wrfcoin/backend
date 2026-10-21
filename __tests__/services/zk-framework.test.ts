/**
 * Unit tests for ZK framework verification stubs
 *
 * Issue #511 — tests for verifyRangeProof, ring-signature verify, ZKP verify,
 * and decryptAmount across ZK_STUB_MODE=true and ZK_STUB_MODE unset paths.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Existing unit tests intentionally exercise the stub implementation, so the
// helper enables the outer feature gate unless a test explicitly overrides it.
function loadFramework(
  stubMode: 'true' | 'false' | undefined,
  privacyEnabled: 'true' | 'false' | undefined = 'true'
) {
  jest.resetModules();
  if (stubMode === undefined) {
    delete process.env.ZK_STUB_MODE;
  } else {
    process.env.ZK_STUB_MODE = stubMode;
  }
  if (privacyEnabled === undefined) {
    delete process.env.ZK_PRIVACY_ENABLED;
  } else {
    process.env.ZK_PRIVACY_ENABLED = privacyEnabled;
  }
  return require('../../server/privacy/zk_framework');
}

afterEach(() => {
  delete process.env.ZK_STUB_MODE;
  delete process.env.ZK_PRIVACY_ENABLED;
});

describe('ZK privacy feature gate', () => {
  it('blocks all four unimplemented operations even when stub mode is enabled', () => {
    const {
      ZeroKnowledgeProofSystem,
      RingSignatureSystem,
      ConfidentialTransactionSystem,
    } = loadFramework('true', 'false');
    const zk = new ZeroKnowledgeProofSystem();
    const ring = new RingSignatureSystem();
    const confidential = new ConfidentialTransactionSystem();
    const statement = { type: 'balance_proof' };

    expect(() =>
      zk.verifyProof({ hash: 'a'.repeat(64), statement }, statement)
    ).toThrow('ZK privacy is disabled');
    expect(() =>
      ring.verifySignature(
        {
          hash: 'b'.repeat(64),
          keyImageHash: 'c'.repeat(64),
          ringSize: 1,
        },
        'message',
        ['public-key']
      )
    ).toThrow('ZK privacy is disabled');
    expect(() =>
      confidential.verifyConfidentialTransaction({
        commitment: 'commitment',
        amountRangeProof: 'range-proof',
      })
    ).toThrow('ZK privacy is disabled');
    expect(() =>
      confidential.decryptAmount(
        { encryptedAmount: '616263' },
        'shared-secret'
      )
    ).toThrow('ZK privacy is disabled');
  });

  it('blocks simulated privacy generation but leaves STANDARD transactions available', () => {
    const { PrivacyFramework, PRIVACY_LEVELS } = loadFramework(
      'true',
      'false'
    );
    const framework = new PrivacyFramework();
    const transaction = {
      id: 'tx-gated',
      amount: 10,
      sender: 'sender',
      recipient: 'recipient',
    };

    expect(() =>
      framework.applyPrivacyProtections(
        transaction,
        PRIVACY_LEVELS.BASIC,
        null,
        {}
      )
    ).toThrow('ZK privacy is disabled');
    expect(
      framework.applyPrivacyProtections(
        transaction,
        PRIVACY_LEVELS.STANDARD,
        null,
        {}
      ).privacyLevel
    ).toBe(PRIVACY_LEVELS.STANDARD);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ZeroKnowledgeProofSystem — verifyProof
// ─────────────────────────────────────────────────────────────────────────────
describe('ZeroKnowledgeProofSystem.verifyProof', () => {
  describe('ZK_STUB_MODE=true', () => {
    let zkSystem: any;

    beforeEach(() => {
      const { ZeroKnowledgeProofSystem } = loadFramework('true');
      zkSystem = new ZeroKnowledgeProofSystem();
    });

    afterEach(() => {
      delete process.env.ZK_STUB_MODE;
    });

    it('returns verified:false with stub_implementation reason for a well-formed proof', () => {
      const statement = { type: 'balance_proof', sender: '0xabc' };
      const proof = {
        hash: 'a'.repeat(64),
        statement,
      };

      const result = zkSystem.verifyProof(proof, statement);

      expect(result.verified).toBe(false);
      expect(result.reason).toBe('stub_implementation');
    });

    it('returns verified:false with statement_mismatch when statements differ', () => {
      const proof = {
        hash: 'a'.repeat(64),
        statement: { type: 'balance_proof', sender: '0xabc' },
      };
      const differentStatement = { type: 'ownership_proof', sender: '0xabc' };

      const result = zkSystem.verifyProof(proof, differentStatement);

      expect(result.verified).toBe(false);
      expect(result.reason).toBe('statement_mismatch');
    });

    it('returns verified:false with invalid_proof_structure when proof has no hash', () => {
      const statement = { type: 'balance_proof' };
      const malformedProof = { statement };

      const result = zkSystem.verifyProof(malformedProof, statement);

      expect(result.verified).toBe(false);
      expect(result.reason).toBe('invalid_proof_structure');
    });

    it('returns verified:false with invalid_proof_structure for null proof', () => {
      const result = zkSystem.verifyProof(null, { type: 'x' });

      expect(result.verified).toBe(false);
      expect(result.reason).toBe('invalid_proof_structure');
    });

    it('returns verified:false with invalid_proof_structure for empty object', () => {
      const result = zkSystem.verifyProof({}, { type: 'x' });

      expect(result.verified).toBe(false);
      expect(result.reason).toBe('invalid_proof_structure');
    });
  });

  describe('ZK_STUB_MODE not set (production path)', () => {
    let zkSystem: any;

    beforeEach(() => {
      const { ZeroKnowledgeProofSystem } = loadFramework(undefined);
      zkSystem = new ZeroKnowledgeProofSystem();
    });

    afterEach(() => {
      delete process.env.ZK_STUB_MODE;
    });

    it('throws for a structurally valid proof when stub mode is disabled', () => {
      const statement = { type: 'balance_proof' };
      const proof = { hash: 'a'.repeat(64), statement };

      expect(() => zkSystem.verifyProof(proof, statement)).toThrow(
        'Not implemented'
      );
    });

    it('still returns invalid_proof_structure (no throw) for malformed proof even without stub mode', () => {
      // Structural validation fires before the stub-mode guard
      const result = zkSystem.verifyProof(null, { type: 'x' });

      expect(result.verified).toBe(false);
      expect(result.reason).toBe('invalid_proof_structure');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ZeroKnowledgeProofSystem — generateProof
// ─────────────────────────────────────────────────────────────────────────────
describe('ZeroKnowledgeProofSystem.generateProof', () => {
  afterEach(() => {
    delete process.env.ZK_STUB_MODE;
  });

  it('returns a proof object with hash, statement, proofSize, and timestamp', () => {
    const { ZeroKnowledgeProofSystem } = loadFramework('true');
    const zk = new ZeroKnowledgeProofSystem();

    const data = { amount: 100 };
    const witness = { privateKey: 'secret' };
    const statement = { type: 'range_proof' };

    const proof = zk.generateProof(data, witness, statement);

    expect(proof).toHaveProperty('hash');
    expect(typeof proof.hash).toBe('string');
    expect(proof.hash.length).toBe(64); // sha256 hex
    expect(proof.statement).toEqual(statement);
    expect(proof.proofSize).toBeGreaterThanOrEqual(10);
    expect(proof.proofSize).toBeLessThanOrEqual(50);
    expect(new Date(proof.timestamp).getTime()).not.toBeNaN();
  });

  it('produces different hashes for different input data (nonce ensures non-determinism)', () => {
    const { ZeroKnowledgeProofSystem } = loadFramework('true');
    const zk = new ZeroKnowledgeProofSystem();

    const statement = { type: 'range_proof' };
    const p1 = zk.generateProof({ amount: 100 }, { privateKey: 'k' }, statement);
    const p2 = zk.generateProof({ amount: 100 }, { privateKey: 'k' }, statement);

    // Due to random nonce, hashes should differ (extremely unlikely to collide)
    expect(p1.hash).not.toBe(p2.hash);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RingSignatureSystem — verifySignature
// ─────────────────────────────────────────────────────────────────────────────
describe('RingSignatureSystem.verifySignature', () => {
  describe('ZK_STUB_MODE=true', () => {
    let ringSystem: any;

    beforeEach(() => {
      const { RingSignatureSystem } = loadFramework('true');
      ringSystem = new RingSignatureSystem();
    });

    afterEach(() => {
      delete process.env.ZK_STUB_MODE;
    });

    it('returns verified:false with stub_implementation for a valid-structure signature', () => {
      const publicKeys = ['pub1', 'pub2', 'pub3'];
      const sig = {
        type: 'ring-signature',
        hash: 'b'.repeat(64),
        keyImageHash: 'c'.repeat(64),
        ringSize: 3,
      };

      const result = ringSystem.verifySignature(sig, 'message', publicKeys);

      expect(result.verified).toBe(false);
      expect(result.reason).toBe('stub_implementation');
    });

    it('returns verified:false with ring_size_mismatch when ringSize != publicKeys.length', () => {
      const sig = {
        hash: 'b'.repeat(64),
        keyImageHash: 'c'.repeat(64),
        ringSize: 5, // mismatch
      };

      const result = ringSystem.verifySignature(sig, 'msg', ['pub1', 'pub2']);

      expect(result.verified).toBe(false);
      expect(result.reason).toBe('ring_size_mismatch');
    });

    it('returns verified:false with invalid_signature_structure when hash missing', () => {
      const sig = { keyImageHash: 'c'.repeat(64), ringSize: 1 };

      const result = ringSystem.verifySignature(sig, 'msg', ['pub1']);

      expect(result.verified).toBe(false);
      expect(result.reason).toBe('invalid_signature_structure');
    });

    it('returns verified:false with invalid_signature_structure when keyImageHash missing', () => {
      const sig = { hash: 'b'.repeat(64), ringSize: 1 };

      const result = ringSystem.verifySignature(sig, 'msg', ['pub1']);

      expect(result.verified).toBe(false);
      expect(result.reason).toBe('invalid_signature_structure');
    });

    it('returns verified:false with invalid_signature_structure for null signature', () => {
      const result = ringSystem.verifySignature(null, 'msg', ['pub1']);

      expect(result.verified).toBe(false);
      expect(result.reason).toBe('invalid_signature_structure');
    });
  });

  describe('ZK_STUB_MODE not set (production path)', () => {
    let ringSystem: any;

    beforeEach(() => {
      const { RingSignatureSystem } = loadFramework(undefined);
      ringSystem = new RingSignatureSystem();
    });

    afterEach(() => {
      delete process.env.ZK_STUB_MODE;
    });

    it('throws for a valid-structure signature when stub mode is disabled', () => {
      const sig = {
        hash: 'b'.repeat(64),
        keyImageHash: 'c'.repeat(64),
        ringSize: 1,
      };

      expect(() => ringSystem.verifySignature(sig, 'msg', ['pub1'])).toThrow(
        'Not implemented'
      );
    });

    it('still returns invalid_signature_structure for null signature without throwing', () => {
      const result = ringSystem.verifySignature(null, 'msg', []);

      expect(result.verified).toBe(false);
      expect(result.reason).toBe('invalid_signature_structure');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RingSignatureSystem — generateSignature
// ─────────────────────────────────────────────────────────────────────────────
describe('RingSignatureSystem.generateSignature', () => {
  afterEach(() => {
    delete process.env.ZK_STUB_MODE;
  });

  it('returns a signature with hash, keyImageHash, and correct ringSize', () => {
    const { RingSignatureSystem } = loadFramework('true');
    const ring = new RingSignatureSystem();

    const publicKeys = ['pk1', 'pk2', 'pk3'];
    const sig = ring.generateSignature('hello', 'private-key', publicKeys);

    expect(sig.type).toBe('ring-signature');
    expect(typeof sig.hash).toBe('string');
    expect(sig.hash.length).toBe(64);
    expect(typeof sig.keyImageHash).toBe('string');
    expect(sig.ringSize).toBe(publicKeys.length);
  });

  it('key image is deterministic for the same private key', () => {
    const { RingSignatureSystem } = loadFramework('true');
    const ring = new RingSignatureSystem();

    const sig1 = ring.generateSignature('msg', 'same-key', ['pk1']);
    const sig2 = ring.generateSignature('msg', 'same-key', ['pk1']);

    expect(sig1.keyImageHash).toBe(sig2.keyImageHash);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ConfidentialTransactionSystem — verifyConfidentialTransaction (range proof)
// ─────────────────────────────────────────────────────────────────────────────
describe('ConfidentialTransactionSystem.verifyConfidentialTransaction', () => {
  describe('ZK_STUB_MODE=true', () => {
    let cts: any;

    beforeEach(() => {
      const { ConfidentialTransactionSystem } = loadFramework('true');
      cts = new ConfidentialTransactionSystem();
    });

    afterEach(() => {
      delete process.env.ZK_STUB_MODE;
    });

    it('returns verified:false with stub_implementation for a valid confidential tx', () => {
      const tx = {
        commitment: 'commit-hash',
        amountRangeProof: 'range-proof-hash',
      };

      const result = cts.verifyConfidentialTransaction(tx);

      expect(result.verified).toBe(false);
      expect(result.reason).toBe('stub_implementation');
    });

    it('returns verified:false with invalid_proof_structure when commitment missing', () => {
      const result = cts.verifyConfidentialTransaction({ amountRangeProof: 'x' });

      expect(result.verified).toBe(false);
      expect(result.reason).toBe('invalid_proof_structure');
    });

    it('returns verified:false with invalid_proof_structure when amountRangeProof missing', () => {
      const result = cts.verifyConfidentialTransaction({ commitment: 'x' });

      expect(result.verified).toBe(false);
      expect(result.reason).toBe('invalid_proof_structure');
    });

    it('returns verified:false with invalid_proof_structure for empty object', () => {
      const result = cts.verifyConfidentialTransaction({});

      expect(result.verified).toBe(false);
      expect(result.reason).toBe('invalid_proof_structure');
    });
  });

  describe('ZK_STUB_MODE not set (production path)', () => {
    let cts: any;

    beforeEach(() => {
      const { ConfidentialTransactionSystem } = loadFramework(undefined);
      cts = new ConfidentialTransactionSystem();
    });

    afterEach(() => {
      delete process.env.ZK_STUB_MODE;
    });

    it('throws for a valid confidential tx when stub mode is disabled', () => {
      const tx = { commitment: 'c', amountRangeProof: 'r' };

      expect(() => cts.verifyConfidentialTransaction(tx)).toThrow('Not implemented');
    });

    it('still returns invalid_proof_structure for incomplete tx without throwing', () => {
      const result = cts.verifyConfidentialTransaction({});

      expect(result.verified).toBe(false);
      expect(result.reason).toBe('invalid_proof_structure');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ConfidentialTransactionSystem — decryptAmount
// ─────────────────────────────────────────────────────────────────────────────
describe('ConfidentialTransactionSystem.decryptAmount', () => {
  afterEach(() => {
    delete process.env.ZK_STUB_MODE;
  });

  it('returns null when transaction has no encryptedAmount (both modes)', () => {
    const { ConfidentialTransactionSystem } = loadFramework('true');
    const cts = new ConfidentialTransactionSystem();

    expect(cts.decryptAmount({}, 'shared-secret')).toBeNull();
  });

  it('returns stub marker object in stub mode when encryptedAmount is present', () => {
    const { ConfidentialTransactionSystem } = loadFramework('true');
    const cts = new ConfidentialTransactionSystem();

    const result = cts.decryptAmount({ encryptedAmount: '616263' }, 'shared');

    expect(result).not.toBeNull();
    expect(result.decrypted).toBe(false);
    expect(result.reason).toBe('stub_implementation');
  });

  it('throws when encryptedAmount is present and stub mode is disabled', () => {
    const { ConfidentialTransactionSystem } = loadFramework(undefined);
    const cts = new ConfidentialTransactionSystem();

    expect(() =>
      cts.decryptAmount({ encryptedAmount: '616263' }, 'shared')
    ).toThrow('Not implemented');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PrivacyFramework — verifyTransaction
// ─────────────────────────────────────────────────────────────────────────────
describe('PrivacyFramework.verifyTransaction', () => {
  afterEach(() => {
    delete process.env.ZK_STUB_MODE;
  });

  it('returns true for a STANDARD transaction (no privacy features to verify)', () => {
    const { PrivacyFramework, PRIVACY_LEVELS } = loadFramework('true');
    const fw = new PrivacyFramework();

    expect(fw.verifyTransaction({ privacyLevel: PRIVACY_LEVELS.STANDARD }, {})).toBe(true);
  });

  it('returns true for a transaction with no privacyLevel field', () => {
    const { PrivacyFramework } = loadFramework('true');
    const fw = new PrivacyFramework();

    expect(fw.verifyTransaction({}, {})).toBe(true);
  });

  it('returns stub result for a HIGH-privacy transaction in stub mode', () => {
    const { PrivacyFramework, PRIVACY_LEVELS } = loadFramework('true');
    const fw = new PrivacyFramework();

    const tx = {
      privacyLevel: PRIVACY_LEVELS.HIGH,
      commitment: 'commit',
      amountRangeProof: 'range',
      rangeProof: 'a'.repeat(64),
      zkpMetadata: { proofType: 'STARK' },
    };

    const result = fw.verifyTransaction(tx, {});

    expect(result.verified).toBe(false);
    expect(result.reason).toBe('stub_implementation');
    expect(Array.isArray(result.components)).toBe(true);
  });

  it('throws for a non-STANDARD privacy transaction when stub mode is disabled', () => {
    const { PrivacyFramework, PRIVACY_LEVELS } = loadFramework(undefined);
    const fw = new PrivacyFramework();

    const tx = { privacyLevel: PRIVACY_LEVELS.BASIC };

    expect(() => fw.verifyTransaction(tx, {})).toThrow('Not implemented');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PrivacyFramework — applyPrivacyProtections (smoke tests)
// ─────────────────────────────────────────────────────────────────────────────
describe('PrivacyFramework.applyPrivacyProtections', () => {
  afterEach(() => {
    delete process.env.ZK_STUB_MODE;
  });

  it('attaches privacyLevel to the transaction for STANDARD level', () => {
    const { PrivacyFramework, PRIVACY_LEVELS } = loadFramework('true');
    const fw = new PrivacyFramework();

    const tx = { id: 'tx-1', amount: 50, sender: '0xA', recipient: '0xB' };
    const result = fw.applyPrivacyProtections(tx, PRIVACY_LEVELS.STANDARD, null, {});

    expect(result.privacyLevel).toBe(PRIVACY_LEVELS.STANDARD);
    expect(result.id).toBe('tx-1');
  });

  it('adds rangeProof and zkpMetadata for HIGH level', () => {
    const { PrivacyFramework, PRIVACY_LEVELS } = loadFramework('true');
    const fw = new PrivacyFramework();

    const tx = { id: 'tx-2', amount: 100, nonce: 1, timestamp: Date.now(), sender: '0xA', recipient: '0xB' };
    const result = fw.applyPrivacyProtections(tx, PRIVACY_LEVELS.HIGH, null, {});

    expect(result.rangeProof).toBeDefined();
    expect(result.zkpMetadata).toBeDefined();
    expect(result.signature?.type).toBe('ring-signature');
    expect(result.commitment).toBeDefined();
    expect(result.amountRangeProof).toBeDefined();
    expect(result.privacyLevel).toBe(PRIVACY_LEVELS.HIGH);
  });
});
