export interface BridgeFeeQuote {
  baseFeeRate: number;
  gasFee: number;
  estimatedMinutes: number;
}

export const BRIDGE_FEE_ESTIMATE_SCHEDULE: Record<string, BridgeFeeQuote> = {
  axelar: { baseFeeRate: 0.003, gasFee: 12.5, estimatedMinutes: 5.2 },
  layerzero: { baseFeeRate: 0.0025, gasFee: 8.75, estimatedMinutes: 3.8 },
  wormhole: { baseFeeRate: 0.005, gasFee: 15.2, estimatedMinutes: 6.1 },
  'chainlink-ccip': { baseFeeRate: 0.004, gasFee: 18.5, estimatedMinutes: 4.5 },
  chainflip: { baseFeeRate: 0.008, gasFee: 22.1, estimatedMinutes: 8.2 },
  'celer-cbridge': { baseFeeRate: 0.0015, gasFee: 9.2, estimatedMinutes: 4.8 },
  thorchain: { baseFeeRate: 0.006, gasFee: 16.8, estimatedMinutes: 7.3 },
  'near-rainbow': { baseFeeRate: 0.007, gasFee: 11.4, estimatedMinutes: 9.1 },
  optimism: { baseFeeRate: 0.002, gasFee: 5.2, estimatedMinutes: 12.5 },
  base: { baseFeeRate: 0.0018, gasFee: 4.8, estimatedMinutes: 2.8 },
  'cosmos-ibc': { baseFeeRate: 0.0035, gasFee: 3.2, estimatedMinutes: 6.8 },
  interledger: { baseFeeRate: 0.012, gasFee: 2.1, estimatedMinutes: 15.2 },
  'polkadot-xcmp': { baseFeeRate: 0.0028, gasFee: 7.3, estimatedMinutes: 5.9 },
};

export function getBridgeFeeQuote(bridgeId: string): BridgeFeeQuote {
  return (
    BRIDGE_FEE_ESTIMATE_SCHEDULE[bridgeId] || {
      baseFeeRate: 0.003,
      gasFee: 10,
      estimatedMinutes: 6,
    }
  );
}

export function computeBridgeFeeEstimate(bridgeId: string, amount: number) {
  const quote = getBridgeFeeQuote(bridgeId);
  const bridgeFee = amount * quote.baseFeeRate;
  const gasFee = quote.gasFee;
  const totalFee = bridgeFee + gasFee;

  return {
    bridgeFee: bridgeFee.toFixed(6),
    bridgeFeeRate: `${(quote.baseFeeRate * 100).toFixed(4)}%`,
    gasFee: `$${gasFee.toFixed(2)}`,
    totalFee: `$${totalFee.toFixed(2)}`,
    estimatedTime: `${quote.estimatedMinutes.toFixed(1)} min`,
  };
}
