jest.mock('../server/cache/cache-manager.js', () => {
  const cacheManager = {
    delete: jest.fn().mockResolvedValue(true),
    invalidate: jest.fn().mockResolvedValue(undefined),
    set: jest.fn().mockResolvedValue(true),
  };

  return { cacheManager };
});

const reorgsDetectedTotal = {
  inc: jest.fn(),
};

jest.mock('../server/utils/metrics.js', () => ({
  reorgsDetectedTotal,
}));

import { BridgeFinalityMonitor } from '../shared/bridge-finality-monitor.js';
import { cacheManager } from '../server/cache/cache-manager.js';

describe('BridgeFinalityMonitor reorg cache hooks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('invalidates stale tx caches and refreshes canonical state on reorg', async () => {
    const monitor = new BridgeFinalityMonitor();
    const tx = await monitor.monitorTransaction(
      '0xreorgedtx',
      'ethereum',
      100,
      '0xoldblock'
    );

    (monitor as any).getCurrentBlockNumber = jest.fn(async () => 100);
    (monitor as any).getBlockHash = jest.fn(async () => '0xnewblock');

    await (monitor as any).checkForReorg(tx);
    await new Promise(resolve => setImmediate(resolve));

    expect(cacheManager.delete).toHaveBeenCalledWith(
      'tx:0xreorgedtx',
      'cross_chain'
    );
    expect(cacheManager.delete).toHaveBeenCalledWith(
      'bridge:tx:0xreorgedtx',
      'cross_chain'
    );
    expect(cacheManager.invalidate).toHaveBeenCalledWith('bridge_reorg', {
      key: '0xreorgedtx',
    });
    expect(cacheManager.set).toHaveBeenCalledWith(
      'tx:0xreorgedtx',
      expect.objectContaining({
        hash: '0xreorgedtx',
        reorgDetected: true,
      }),
      expect.objectContaining({
        cacheType: 'cross_chain',
        policyName: 'crossChainTx',
      })
    );
    expect(cacheManager.set).toHaveBeenCalledWith(
      'bridge:tx:0xreorgedtx',
      expect.objectContaining({
        hash: '0xreorgedtx',
        reorgDetected: true,
      }),
      expect.objectContaining({
        cacheType: 'cross_chain',
        policyName: 'crossChainTx',
      })
    );
    expect(reorgsDetectedTotal.inc).toHaveBeenCalledWith({
      chain: 'ethereum',
      bridge: 'cross-chain',
    });

    (monitor as any).stopMonitoring('0xreorgedtx');
  });
});
