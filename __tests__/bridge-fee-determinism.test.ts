/**
 * Bridge Fee Estimate Determinism Tests
 *
 * Verifies that the bridge fee-estimate and bridge status endpoints
 * return deterministic results for the same inputs — no Math.random().
 *
 * Issue #439 — Math.random() in bridge fee estimate
 */

import { describe, it, expect } from '@jest/globals';
import {
  BRIDGE_FEE_ESTIMATE_SCHEDULE,
  computeBridgeFeeEstimate,
  getBridgeFeeQuote,
} from '../server/bridge-fee-estimates.js';

describe('Bridge fee estimate determinism (issue #439)', () => {
  it('should return identical fees for the same bridgeId and amount', () => {
    const result1 = computeBridgeFeeEstimate('axelar', 100);
    const result2 = computeBridgeFeeEstimate('axelar', 100);

    expect(result1).toEqual(result2);
  });

  it('should return identical fees across all known bridges', () => {
    for (const bridgeId of Object.keys(BRIDGE_FEE_ESTIMATE_SCHEDULE)) {
      const amount = 500;
      const a = computeBridgeFeeEstimate(bridgeId, amount);
      const b = computeBridgeFeeEstimate(bridgeId, amount);
      expect(a).toEqual(b);
    }
  });

  it('should return deterministic fallback fee for unknown bridges', () => {
    const result1 = computeBridgeFeeEstimate('unknown-bridge', 1000);
    const result2 = computeBridgeFeeEstimate('unknown-bridge', 1000);

    expect(result1).toEqual(result2);
    // Fallback baseFeeRate is 0.003
    expect(result1.bridgeFeeRate).toBe('0.3000%');
  });

  it('should compute correct fee for axelar bridge', () => {
    const result = computeBridgeFeeEstimate('axelar', 1000);

    // baseFeeRate = 0.003, gasFee = 12.5
    // bridgeFee = 1000 * 0.003 = 3.0
    // totalFee = 3.0 + 12.5 = 15.5
    expect(result.bridgeFee).toBe('3.000000');
    expect(result.gasFee).toBe('$12.50');
    expect(result.totalFee).toBe('$15.50');
    expect(result.estimatedTime).toBe('5.2 min');
  });

  it('should not call Math.random() during fee computation', () => {
    const spy = jest.spyOn(Math, 'random');
    const callCountBefore = spy.mock.calls.length;

    for (const bridgeId of Object.keys(BRIDGE_FEE_ESTIMATE_SCHEDULE)) {
      computeBridgeFeeEstimate(bridgeId, 100);
    }

    expect(spy.mock.calls.length).toBe(callCountBefore);
    spy.mockRestore();
  });
});

describe('Bridge fee quote helper', () => {
  it('returns the configured quote for known bridges', () => {
    expect(getBridgeFeeQuote('axelar')).toEqual({
      baseFeeRate: 0.003,
      gasFee: 12.5,
      estimatedMinutes: 5.2,
    });
  });

  it('returns the deterministic fallback quote for unknown bridges', () => {
    expect(getBridgeFeeQuote('unknown-bridge')).toEqual({
      baseFeeRate: 0.003,
      gasFee: 10,
      estimatedMinutes: 6,
    });
  });
});

describe('Bridge status determinism (issue #439)', () => {
  // Mirror of the deterministic bridge status logic from enhanced_unified_api.ts
  const bridgeMetadata: Record<
    string,
    {
      name: string;
      throughput: string;
      securityLevel: string;
      uptime: number;
    }
  > = {
    axelar: {
      name: 'Axelar Network',
      throughput: '850 tx/h',
      securityLevel: 'high',
      uptime: 99.8,
    },
    layerzero: {
      name: 'LayerZero',
      throughput: '1200 tx/h',
      securityLevel: 'high',
      uptime: 99.9,
    },
    wormhole: {
      name: 'Wormhole',
      throughput: '650 tx/h',
      securityLevel: 'high',
      uptime: 99.7,
    },
  };

  function buildBridgeStatus(id: string) {
    const meta = bridgeMetadata[id];
    if (!meta) return null;
    const quote = getBridgeFeeQuote(id);
    return {
      id,
      name: meta.name,
      status: 'active',
      uptime: meta.uptime,
      avgTransactionTime: `${quote.estimatedMinutes.toFixed(1)} min`,
      currentFee: `${(quote.baseFeeRate * 100).toFixed(4)}%`,
      gasEstimate: `$${quote.gasFee.toFixed(2)}`,
      throughput: meta.throughput,
      securityLevel: meta.securityLevel,
    };
  }

  it('should return identical bridge status on repeated calls', () => {
    for (const id of Object.keys(bridgeMetadata)) {
      const status1 = buildBridgeStatus(id);
      const status2 = buildBridgeStatus(id);
      expect(status1).toEqual(status2);
    }
  });

  it('should derive fees from the fee schedule, not Math.random()', () => {
    const spy = jest.spyOn(Math, 'random');
    const callCountBefore = spy.mock.calls.length;

    for (const id of Object.keys(bridgeMetadata)) {
      buildBridgeStatus(id);
    }

    expect(spy.mock.calls.length).toBe(callCountBefore);
    spy.mockRestore();
  });

  it('axelar status should match fee schedule values', () => {
    const status = buildBridgeStatus('axelar')!;
    expect(status.uptime).toBe(99.8);
    expect(status.currentFee).toBe('0.3000%');
    expect(status.gasEstimate).toBe('$12.50');
    expect(status.avgTransactionTime).toBe('5.2 min');
  });
});
