/**
 * CommonJS-compatible Wormhole Solana adapter shim.
 * Provides constructor compatibility used by backend tests.
 */

class SolanaAdapter {
  constructor(rpcUrl, coreBridgeProgramId, tokenBridgeProgramId) {
    this.rpcUrl = rpcUrl;
    this.coreBridgeProgramId = coreBridgeProgramId;
    this.tokenBridgeProgramId = tokenBridgeProgramId;
  }

  async verifyVAA(_vaaBytes) {
    return true;
  }
}

module.exports = {
  SolanaAdapter,
  default: SolanaAdapter,
};
