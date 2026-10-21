import { describe, it } from '@jest/globals';

describe('real oracle earn-loop integration (#908)', () => {
  // Core4 #2474 currently stops at a signer/attester skeleton: it has no
  // pending-reading discovery or HTTP submission loop. Core4 #2476 detects
  // late quorum but deliberately does not settle it. Backend #853 still lacks
  // the durable coordinator that must hold reveal material until quorum.
  //
  // Keep this skipped instead of recreating those missing processes with mocks.
  // Removing `.skip` is the RED control: the body fails with the exact missing
  // production seams rather than manufacturing quorum or an account credit.
  it.skip(
    'backend #908: proves a real reward after #2474 HTTP discovery and #2476 settlement exist',
    () => {
      throw new Error(
        [
          'backend #908 remains RED: no real-binary earn-loop harness exists.',
          'Core4 #2474 lacks pending-reading discovery and HTTP submission.',
          'Core4 #2476 detects late quorum but does not settle the reward.',
          'Backend #853 lacks the durable pre-reveal coordinator.',
          'Required proof: commit, two independent attestations, mined quorum,',
          'reveal or deterministic late settlement, account delta, restart, and peer replay.',
        ].join(' ')
      );
    }
  );
});
