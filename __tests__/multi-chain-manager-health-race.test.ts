import { MultiChainProviderManager } from '../blockchain/providers/multi-chain-manager';

describe('MultiChainProviderManager health monitoring', () => {
  const HEALTH_CHECK_INTERVAL = 30_000;

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(async () => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('does not overlap health sweeps when a previous sweep is still running', async () => {
    const manager = new MultiChainProviderManager();
    const performHealthChecks = jest.spyOn(
      manager as unknown as { performHealthChecks: () => Promise<void> },
      'performHealthChecks'
    );

    let resolveFirstSweep: (() => void) | undefined;
    let callCount = 0;

    performHealthChecks.mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return new Promise<void>((resolve) => {
          resolveFirstSweep = resolve;
        });
      }
      return Promise.resolve();
    });

    await manager.initialize();

    await jest.advanceTimersByTimeAsync(HEALTH_CHECK_INTERVAL);
    expect(performHealthChecks).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(HEALTH_CHECK_INTERVAL * 3);
    expect(performHealthChecks).toHaveBeenCalledTimes(1);

    resolveFirstSweep?.();
    await Promise.resolve();

    await jest.advanceTimersByTimeAsync(HEALTH_CHECK_INTERVAL);
    expect(performHealthChecks).toHaveBeenCalledTimes(2);

    await manager.shutdown();
  });
});
