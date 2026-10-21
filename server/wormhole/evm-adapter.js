/**
 * CommonJS-compatible Wormhole EVM adapter shim.
 * Provides constructor + structural VAA verification for test/runtime compatibility.
 */

const { ethers } = require('ethers');

class EvmAdapter {
  constructor(rpcUrl, coreBridgeAddress, tokenBridgeAddress) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.coreBridgeAddress = coreBridgeAddress;
    this.tokenBridgeAddress = tokenBridgeAddress;
  }

  async verifyVAA(vaaBytes) {
    try {
      if (!vaaBytes || vaaBytes.length < 6) {
        return false;
      }
      const version = vaaBytes[0];
      if (version !== 1) {
        return false;
      }
      const signatureCount = vaaBytes[5];
      const expectedMinLength = 6 + signatureCount * 66 + 51;
      return vaaBytes.length >= expectedMinLength;
    } catch {
      return false;
    }
  }

  async getMessageFee() {
    return 0n;
  }
}

module.exports = {
  EvmAdapter,
  default: EvmAdapter,
};
