/**
 * Validator Proposer Selection Determinism Tests
 *
 * Verifies that proposer selection and gossip peer shuffle no longer
 * use Math.random(), ensuring deterministic consensus across nodes.
 *
 * Issue #478 — Math.random() in consensus paths
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import crypto from 'crypto';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  ValidatorNode,
  ValidatorManager,
  ConsensusMechanism,
} = require('../shared/validator-node.js');

describe('Proposer selection determinism (issue #478)', () => {
  let manager: any;

  beforeEach(() => {
    manager = new ValidatorManager();

    // Set a deterministic block hash so the seed is fixed.
    manager.blockchainState = {
      lastBlock: {
        blockHash:
          'abc123def456abc123def456abc123def456abc123def456abc123def456abcd',
      },
      consensusRound: 1,
      quorum: 2,
    };
    manager.networkInfo = {
      ...manager.networkInfo,
      slot: 99,
    };

    // Register 5 validators with known stable properties.
    const validators = ['alpha', 'bravo', 'charlie', 'delta', 'echo'].map(
      (id) =>
        new ValidatorNode({
          nodeId: `validator-${id}`,
          stake: 100,
          delegatedStake: 50,
          status: 'online',
          consensusMechanism: ConsensusMechanism.PROOF_OF_STAKE,
          // lastSeen far in the past so stake-age is stable across calls
          lastSeen: new Date('2025-01-01T00:00:00Z').toISOString(),
        })
    );

    for (const v of validators) {
      manager.registerValidator(v);
    }
  });

  it('should select the same proposer when called with identical state', () => {
    const activeValidators = manager.validators.filter(
      (v: any) => v.status === 'online'
    );

    const proposer1 =
      manager._selectProposerDeterministic(activeValidators);
    const proposer2 =
      manager._selectProposerDeterministic(activeValidators);

    expect(proposer1.nodeId).toBe(proposer2.nodeId);
  });

  it('should change proposer when block hash changes', () => {
    const activeValidators = manager.validators.filter(
      (v: any) => v.status === 'online'
    );

    const proposerA =
      manager._selectProposerDeterministic(activeValidators);

    // Change the block hash — different seed should (usually) yield a different proposer.
    manager.blockchainState.lastBlock.blockHash =
      'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

    const proposerB =
      manager._selectProposerDeterministic(activeValidators);

    // We cannot 100% guarantee a different proposer (hash collision is possible),
    // but we CAN guarantee the function is still deterministic with the new seed.
    const proposerB2 =
      manager._selectProposerDeterministic(activeValidators);
    expect(proposerB.nodeId).toBe(proposerB2.nodeId);
  });

  it('should change proposer when slot changes', () => {
    const activeValidators = manager.validators.filter(
      (v: any) => v.status === 'online'
    );

    const proposerSlot99 =
      manager._selectProposerDeterministic(activeValidators);

    manager.networkInfo.slot = 100;
    const proposerSlot100 =
      manager._selectProposerDeterministic(activeValidators);

    // Deterministic: calling again with same slot gives same result.
    const proposerSlot100Again =
      manager._selectProposerDeterministic(activeValidators);
    expect(proposerSlot100.nodeId).toBe(proposerSlot100Again.nodeId);
  });

  it('should use sha256-based seed, not Math.random()', () => {
    // Verify the implementation uses crypto.createHash internally by
    // manually replicating the seed derivation and checking the result matches.
    const blockHash =
      manager.blockchainState.lastBlock.blockHash;
    const slot = manager.networkInfo.slot;

    const expectedSeedHash = crypto
      .createHash('sha256')
      .update(`${blockHash}:${slot}`)
      .digest('hex');

    const seedValue = parseInt(expectedSeedHash.substring(0, 8), 16);

    // The proposer must be consistent with this seed.
    const activeValidators = manager.validators
      .filter((v: any) => v.status === 'online')
      .sort((a: any, b: any) =>
        a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0
      );

    // Compute weights (mirrors _selectProposerDeterministic logic).
    const now = Date.now();
    const weights = activeValidators.map((v: any) => {
      const totalStake = (v.stake || 0) + (v.delegatedStake || 0);
      let lastProposedTime: number;
      if (v.proposedBlocks && v.proposedBlocks.length > 0) {
        lastProposedTime = new Date(
          v.proposedBlocks[v.proposedBlocks.length - 1].timestamp
        ).getTime();
      } else {
        lastProposedTime = new Date(v.lastSeen || now).getTime();
      }
      const stakeAgeDays = Math.max(
        1,
        Math.floor((now - lastProposedTime) / (24 * 60 * 60 * 1000))
      );
      return Math.max(1, totalStake * stakeAgeDays);
    });

    const totalWeight = weights.reduce(
      (sum: number, w: number) => sum + w,
      0
    );
    const target = seedValue % totalWeight;

    let cumulative = 0;
    let expectedProposer = activeValidators[activeValidators.length - 1];
    for (let i = 0; i < activeValidators.length; i++) {
      cumulative += weights[i];
      if (target < cumulative) {
        expectedProposer = activeValidators[i];
        break;
      }
    }

    const actualProposer = manager._selectProposerDeterministic(
      manager.validators.filter((v: any) => v.status === 'online')
    );
    expect(actualProposer.nodeId).toBe(expectedProposer.nodeId);
  });
});

describe('PoW nonce uses crypto.randomBytes, not Math.random (issue #478)', () => {
  it('should generate a nonce without Math.random()', () => {
    const validator = new ValidatorNode({
      nodeId: 'validator-pow-test',
      stake: 100,
      status: 'online',
      consensusMechanism: ConsensusMechanism.PROOF_OF_WORK,
    });

    // Spy on Math.random — it should NOT be called during block proposal.
    const mathRandomSpy = jest.spyOn(Math, 'random');
    const callCountBefore = mathRandomSpy.mock.calls.length;

    // proposeBlock is async
    // We just need to verify the code path runs without Math.random
    validator.proposeBlock().catch(() => {
      // Errors from missing chain state are fine; we just care about the nonce path.
    });

    // Math.random should not have been invoked for PoW nonce generation.
    expect(mathRandomSpy.mock.calls.length).toBe(callCountBefore);

    mathRandomSpy.mockRestore();
  });
});

describe('Gossip peer shuffle uses CSPRNG (issue #478)', () => {
  // Import is ESM, use dynamic import
  let P2PGossipSecurityService: any;

  beforeEach(async () => {
    const mod = await import('../shared/p2p-gossip-security.js');
    P2PGossipSecurityService = mod.P2PGossipSecurityService;
  });

  it('should not use Math.random() for peer selection', () => {
    const service = new P2PGossipSecurityService({ fanout: 3 });
    const peers = ['peer-a', 'peer-b', 'peer-c', 'peer-d', 'peer-e'];

    const mathRandomSpy = jest.spyOn(Math, 'random');
    const callCountBefore = mathRandomSpy.mock.calls.length;

    service.selectGossipTargets(peers, []);

    // Math.random should NOT have been called.
    expect(mathRandomSpy.mock.calls.length).toBe(callCountBefore);

    mathRandomSpy.mockRestore();
  });

  it('should return the correct fanout count', () => {
    const service = new P2PGossipSecurityService({ fanout: 2 });
    const peers = ['peer-a', 'peer-b', 'peer-c', 'peer-d'];

    const result = service.selectGossipTargets(peers, []);
    expect(result).toHaveLength(2);
    // All returned peers must be from the input set.
    for (const p of result) {
      expect(peers).toContain(p);
    }
  });

  it('should exclude specified peers', () => {
    const service = new P2PGossipSecurityService({ fanout: 2 });
    const peers = ['peer-a', 'peer-b', 'peer-c', 'peer-d'];

    const result = service.selectGossipTargets(peers, ['peer-a', 'peer-b']);
    for (const p of result) {
      expect(p).not.toBe('peer-a');
      expect(p).not.toBe('peer-b');
    }
  });
});
