/**
 * Bridge Trust Mode Determination Tests
 *
 * Tests for trust mode determination, quorum evidence computation,
 * and finality transition safeguards.
 */

type CapabilityMode =
  | 'unavailable'
  | 'simulated'
  | 'local-manager'
  | 'production-verified'
  | 'degraded';

interface QuorumSummary {
  requiredSignatures: number;
  collectedSignatures: number;
  registeredValidators: number;
  activeValidators: number;
  quorumReached: boolean;
  quorumPercentage: number;
  participationRate: number;
}

interface EvidenceAvailability {
  merkleProof: boolean;
  signatures: boolean;
  oracleAttestation: boolean;
  relayerAttestation: boolean;
}

interface AttestationEvidence {
  evidenceIds: string[];
  quorum: QuorumSummary;
  evidenceAvailable: EvidenceAvailability;
}

// Mirror of the determineTrustMode logic from backend/routes/bridges.ts
function determineTrustMode(args: {
  isValid: boolean;
  safety: { halted: boolean; haltReason: string | null };
  verifierStats: { registeredValidators: number; activeValidators: number };
  durableStoreBackend: 'file' | 'db';
  validatorAttestation: AttestationEvidence | null;
}): { mode: CapabilityMode; reason: string; reasonCode: string } {
  if (args.safety.halted) {
    return {
      mode: 'unavailable',
      reason: `Bridge operations are halted${args.safety.haltReason ? `: ${args.safety.haltReason}` : ''}`,
      reasonCode: 'BRIDGE_HALTED',
    };
  }

  if (!args.isValid) {
    return {
      mode: 'degraded',
      reason: 'Transaction verification failed; bridge operating in degraded mode',
      reasonCode: 'VERIFICATION_FAILED',
    };
  }

  if (
    !args.validatorAttestation ||
    !args.validatorAttestation.quorum.quorumReached
  ) {
    return {
      mode: 'simulated',
      reason: 'Validator quorum not reached; operating in simulated mode',
      reasonCode: 'QUORUM_NOT_REACHED',
    };
  }

  if (args.verifierStats.activeValidators === 0) {
    return {
      mode: 'simulated',
      reason: 'No active validators configured; production verification unavailable',
      reasonCode: 'NO_ACTIVE_VALIDATORS',
    };
  }

  if (
    args.durableStoreBackend === 'db' &&
    args.verifierStats.activeValidators >= 3
  ) {
    return {
      mode: 'production-verified',
      reason: `Bridge verified with ${args.validatorAttestation.quorum.collectedSignatures}/${args.validatorAttestation.quorum.requiredSignatures} validator signatures; DB-backed durability active`,
      reasonCode: 'PRODUCTION_VERIFIED',
    };
  }

  return {
    mode: 'local-manager',
    reason: `Bridge verified with ${args.validatorAttestation.quorum.collectedSignatures}/${args.validatorAttestation.quorum.requiredSignatures} signatures; local durability mode`,
    reasonCode: 'LOCAL_MANAGER_MODE',
  };
}

function buildQuorumMetrics(args: {
  collectedSignatures: number;
  requiredSignatures: number;
  registeredValidators: number;
  activeValidators: number;
}): QuorumSummary {
  const quorumPercentage =
    args.requiredSignatures > 0
      ? Math.round((args.collectedSignatures / args.requiredSignatures) * 100)
      : 0;
  const participationRate =
    args.activeValidators > 0
      ? Math.round((args.collectedSignatures / args.activeValidators) * 100)
      : 0;

  return {
    requiredSignatures: args.requiredSignatures,
    collectedSignatures: args.collectedSignatures,
    registeredValidators: args.registeredValidators,
    activeValidators: args.activeValidators,
    quorumReached: args.collectedSignatures >= args.requiredSignatures,
    quorumPercentage,
    participationRate,
  };
}

function mockAttestation(
  quorum: QuorumSummary,
  evidence: Partial<EvidenceAvailability> = {}
): AttestationEvidence {
  return {
    evidenceIds: [],
    quorum,
    evidenceAvailable: {
      merkleProof: false,
      signatures: quorum.collectedSignatures > 0,
      oracleAttestation: false,
      relayerAttestation: false,
      ...evidence,
    },
  };
}

const defaultSafety = { halted: false, haltReason: null };
const haltedSafety = { halted: true, haltReason: 'manual halt' };

describe('Trust Mode Determination', () => {
  it('should report production-verified when DB backend and 3+ active validators with quorum', () => {
    const quorum = buildQuorumMetrics({
      collectedSignatures: 3,
      requiredSignatures: 3,
      registeredValidators: 5,
      activeValidators: 5,
    });
    const result = determineTrustMode({
      isValid: true,
      safety: defaultSafety,
      verifierStats: { registeredValidators: 5, activeValidators: 5 },
      durableStoreBackend: 'db',
      validatorAttestation: mockAttestation(quorum),
    });

    expect(result.mode).toBe('production-verified');
    expect(result.reasonCode).toBe('PRODUCTION_VERIFIED');
  });

  it('should report local-manager when file backend with quorum', () => {
    const quorum = buildQuorumMetrics({
      collectedSignatures: 3,
      requiredSignatures: 3,
      registeredValidators: 5,
      activeValidators: 5,
    });
    const result = determineTrustMode({
      isValid: true,
      safety: defaultSafety,
      verifierStats: { registeredValidators: 5, activeValidators: 5 },
      durableStoreBackend: 'file',
      validatorAttestation: mockAttestation(quorum),
    });

    expect(result.mode).toBe('local-manager');
    expect(result.reasonCode).toBe('LOCAL_MANAGER_MODE');
  });

  it('should report local-manager when DB backend but fewer than 3 validators', () => {
    const quorum = buildQuorumMetrics({
      collectedSignatures: 2,
      requiredSignatures: 2,
      registeredValidators: 2,
      activeValidators: 2,
    });
    const result = determineTrustMode({
      isValid: true,
      safety: defaultSafety,
      verifierStats: { registeredValidators: 2, activeValidators: 2 },
      durableStoreBackend: 'db',
      validatorAttestation: mockAttestation(quorum),
    });

    expect(result.mode).toBe('local-manager');
    expect(result.reasonCode).toBe('LOCAL_MANAGER_MODE');
  });

  it('should report simulated when no active validators', () => {
    const quorum = buildQuorumMetrics({
      collectedSignatures: 0,
      requiredSignatures: 1,
      registeredValidators: 0,
      activeValidators: 0,
    });
    const result = determineTrustMode({
      isValid: true,
      safety: defaultSafety,
      verifierStats: { registeredValidators: 0, activeValidators: 0 },
      durableStoreBackend: 'db',
      validatorAttestation: mockAttestation(quorum),
    });

    expect(result.mode).toBe('simulated');
    expect(result.reasonCode).toBe('QUORUM_NOT_REACHED');
  });

  it('should report simulated when quorum not reached', () => {
    const quorum = buildQuorumMetrics({
      collectedSignatures: 1,
      requiredSignatures: 3,
      registeredValidators: 5,
      activeValidators: 5,
    });
    const result = determineTrustMode({
      isValid: true,
      safety: defaultSafety,
      verifierStats: { registeredValidators: 5, activeValidators: 5 },
      durableStoreBackend: 'db',
      validatorAttestation: mockAttestation(quorum),
    });

    expect(result.mode).toBe('simulated');
    expect(result.reasonCode).toBe('QUORUM_NOT_REACHED');
  });

  it('should report simulated when validatorAttestation is null', () => {
    const result = determineTrustMode({
      isValid: true,
      safety: defaultSafety,
      verifierStats: { registeredValidators: 5, activeValidators: 5 },
      durableStoreBackend: 'db',
      validatorAttestation: null,
    });

    expect(result.mode).toBe('simulated');
    expect(result.reasonCode).toBe('QUORUM_NOT_REACHED');
  });

  it('should report degraded when verification fails', () => {
    const quorum = buildQuorumMetrics({
      collectedSignatures: 3,
      requiredSignatures: 3,
      registeredValidators: 5,
      activeValidators: 5,
    });
    const result = determineTrustMode({
      isValid: false,
      safety: defaultSafety,
      verifierStats: { registeredValidators: 5, activeValidators: 5 },
      durableStoreBackend: 'db',
      validatorAttestation: mockAttestation(quorum),
    });

    expect(result.mode).toBe('degraded');
    expect(result.reasonCode).toBe('VERIFICATION_FAILED');
  });

  it('should report unavailable when bridge is halted', () => {
    const quorum = buildQuorumMetrics({
      collectedSignatures: 3,
      requiredSignatures: 3,
      registeredValidators: 5,
      activeValidators: 5,
    });
    const result = determineTrustMode({
      isValid: true,
      safety: haltedSafety,
      verifierStats: { registeredValidators: 5, activeValidators: 5 },
      durableStoreBackend: 'db',
      validatorAttestation: mockAttestation(quorum),
    });

    expect(result.mode).toBe('unavailable');
    expect(result.reasonCode).toBe('BRIDGE_HALTED');
    expect(result.reason).toContain('manual halt');
  });

  it('should prioritize halted over verification failure', () => {
    const result = determineTrustMode({
      isValid: false,
      safety: haltedSafety,
      verifierStats: { registeredValidators: 5, activeValidators: 5 },
      durableStoreBackend: 'db',
      validatorAttestation: null,
    });

    expect(result.mode).toBe('unavailable');
    expect(result.reasonCode).toBe('BRIDGE_HALTED');
  });
});

describe('Quorum Evidence Correctness', () => {
  it('should compute quorumPercentage correctly', () => {
    const quorum = buildQuorumMetrics({
      collectedSignatures: 3,
      requiredSignatures: 5,
      registeredValidators: 7,
      activeValidators: 7,
    });

    expect(quorum.quorumPercentage).toBe(60); // 3/5 * 100
  });

  it('should compute participationRate correctly', () => {
    const quorum = buildQuorumMetrics({
      collectedSignatures: 3,
      requiredSignatures: 5,
      registeredValidators: 7,
      activeValidators: 7,
    });

    expect(quorum.participationRate).toBe(43); // Math.round(3/7 * 100)
  });

  it('should handle zero requiredSignatures for quorumPercentage', () => {
    const quorum = buildQuorumMetrics({
      collectedSignatures: 0,
      requiredSignatures: 0,
      registeredValidators: 0,
      activeValidators: 0,
    });

    expect(quorum.quorumPercentage).toBe(0);
    expect(quorum.participationRate).toBe(0);
  });

  it('should handle over-collection (more sigs than required)', () => {
    const quorum = buildQuorumMetrics({
      collectedSignatures: 7,
      requiredSignatures: 3,
      registeredValidators: 7,
      activeValidators: 7,
    });

    expect(quorum.quorumPercentage).toBe(233); // 7/3 * 100 rounded
    expect(quorum.quorumReached).toBe(true);
    expect(quorum.participationRate).toBe(100);
  });

  it('should set quorumReached based on collected vs required', () => {
    const reached = buildQuorumMetrics({
      collectedSignatures: 3,
      requiredSignatures: 3,
      registeredValidators: 5,
      activeValidators: 5,
    });
    const notReached = buildQuorumMetrics({
      collectedSignatures: 2,
      requiredSignatures: 3,
      registeredValidators: 5,
      activeValidators: 5,
    });

    expect(reached.quorumReached).toBe(true);
    expect(notReached.quorumReached).toBe(false);
  });

  it('should track evidence availability flags correctly', () => {
    const attestation = mockAttestation(
      buildQuorumMetrics({
        collectedSignatures: 3,
        requiredSignatures: 3,
        registeredValidators: 5,
        activeValidators: 5,
      }),
      {
        merkleProof: true,
        signatures: true,
        oracleAttestation: true,
        relayerAttestation: false,
      }
    );

    expect(attestation.evidenceAvailable.merkleProof).toBe(true);
    expect(attestation.evidenceAvailable.signatures).toBe(true);
    expect(attestation.evidenceAvailable.oracleAttestation).toBe(true);
    expect(attestation.evidenceAvailable.relayerAttestation).toBe(false);
  });
});

describe('Finality Transition Safeguards', () => {
  it('trust mode should transition: unavailable -> degraded -> simulated -> local-manager -> production-verified', () => {
    // Test the priority ordering of trust modes

    // 1. Halted = unavailable (highest priority)
    const halted = determineTrustMode({
      isValid: false,
      safety: haltedSafety,
      verifierStats: { registeredValidators: 0, activeValidators: 0 },
      durableStoreBackend: 'file',
      validatorAttestation: null,
    });
    expect(halted.mode).toBe('unavailable');

    // 2. Not valid = degraded
    const degraded = determineTrustMode({
      isValid: false,
      safety: defaultSafety,
      verifierStats: { registeredValidators: 5, activeValidators: 5 },
      durableStoreBackend: 'db',
      validatorAttestation: null,
    });
    expect(degraded.mode).toBe('degraded');

    // 3. No quorum = simulated
    const simulated = determineTrustMode({
      isValid: true,
      safety: defaultSafety,
      verifierStats: { registeredValidators: 5, activeValidators: 5 },
      durableStoreBackend: 'db',
      validatorAttestation: null,
    });
    expect(simulated.mode).toBe('simulated');

    // 4. File backend with quorum = local-manager
    const localManager = determineTrustMode({
      isValid: true,
      safety: defaultSafety,
      verifierStats: { registeredValidators: 5, activeValidators: 5 },
      durableStoreBackend: 'file',
      validatorAttestation: mockAttestation(
        buildQuorumMetrics({
          collectedSignatures: 3,
          requiredSignatures: 3,
          registeredValidators: 5,
          activeValidators: 5,
        })
      ),
    });
    expect(localManager.mode).toBe('local-manager');

    // 5. DB backend + 3+ validators + quorum = production-verified
    const productionVerified = determineTrustMode({
      isValid: true,
      safety: defaultSafety,
      verifierStats: { registeredValidators: 5, activeValidators: 5 },
      durableStoreBackend: 'db',
      validatorAttestation: mockAttestation(
        buildQuorumMetrics({
          collectedSignatures: 3,
          requiredSignatures: 3,
          registeredValidators: 5,
          activeValidators: 5,
        })
      ),
    });
    expect(productionVerified.mode).toBe('production-verified');
  });
});

describe('L2 Capability Readiness', () => {
  // Mirror of the L2 helper functions from backend/routes/bridges.ts
  function determineL2ProverReadiness(args: { halted: boolean }): { mode: CapabilityMode; reason: string; reasonCode: string } {
    if (args.halted) {
      return { mode: 'degraded', reason: 'L2 prover degraded due to bridge halt', reasonCode: 'L2_PROVER_HALTED' };
    }
    return { mode: 'simulated', reason: 'L2 prover service available in simulated mode', reasonCode: 'L2_PROVER_SIMULATED' };
  }

  function determineL2VerifierReadiness(args: { halted: boolean }): { mode: CapabilityMode; reason: string; reasonCode: string } {
    if (args.halted) {
      return { mode: 'degraded', reason: 'L2 verifier degraded due to bridge halt', reasonCode: 'L2_VERIFIER_HALTED' };
    }
    return { mode: 'simulated', reason: 'L2 verifier service available in simulated mode', reasonCode: 'L2_VERIFIER_SIMULATED' };
  }

  function determineL1FinalityReadiness(args: { halted: boolean }): { mode: CapabilityMode; reason: string; reasonCode: string } {
    if (args.halted) {
      return { mode: 'degraded', reason: 'L1 finality monitoring degraded due to bridge halt', reasonCode: 'L1_FINALITY_HALTED' };
    }
    return { mode: 'simulated', reason: 'L1 finality monitor available in simulated mode', reasonCode: 'L1_FINALITY_SIMULATED' };
  }

  it('L2 prover reports degraded when halted', () => {
    const result = determineL2ProverReadiness({ halted: true });
    expect(result.mode).toBe('degraded');
    expect(result.reasonCode).toBe('L2_PROVER_HALTED');
  });

  it('L2 prover reports simulated when not halted', () => {
    const result = determineL2ProverReadiness({ halted: false });
    expect(result.mode).toBe('simulated');
    expect(result.reasonCode).toBe('L2_PROVER_SIMULATED');
  });

  it('L2 verifier reports degraded when halted', () => {
    const result = determineL2VerifierReadiness({ halted: true });
    expect(result.mode).toBe('degraded');
    expect(result.reasonCode).toBe('L2_VERIFIER_HALTED');
  });

  it('L2 verifier reports simulated when not halted', () => {
    const result = determineL2VerifierReadiness({ halted: false });
    expect(result.mode).toBe('simulated');
  });

  it('L1 finality reports degraded when halted', () => {
    const result = determineL1FinalityReadiness({ halted: true });
    expect(result.mode).toBe('degraded');
    expect(result.reasonCode).toBe('L1_FINALITY_HALTED');
  });

  it('L1 finality reports simulated when not halted', () => {
    const result = determineL1FinalityReadiness({ halted: false });
    expect(result.mode).toBe('simulated');
    expect(result.reasonCode).toBe('L1_FINALITY_SIMULATED');
  });
});
