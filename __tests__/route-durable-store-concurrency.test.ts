import {
  ConcurrencyConflictError,
  RouteDurableStore,
  type RouteDurableState,
} from '../shared/route-durable-store.js';

function makeDefaultState(): RouteDurableState {
  return {
    governance: {
      proposals: {},
      votes: {},
    },
    weather: {
      records: {},
    },
    bridges: {
      transactions: {},
      verificationResults: {},
      safety: {
        halted: false,
        haltedAt: null,
        haltReason: null,
        globalExposure: '0',
        routeExposure: {},
        globalExposureCap: '1000000000000',
        routeExposureCap: '250000000000',
        anomalyWindowStartedAt: new Date(0).toISOString(),
        anomalyFailuresInWindow: 0,
        anomalyFailureThreshold: 5,
        challengeWindowSeconds: 1800,
      },
    },
    idempotency: {
      entries: {},
      order: [],
    },
  };
}

describe('RouteDurableStore OCC retries', () => {
  let setTimeoutSpy: jest.SpyInstance;
  let consoleLogSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function makeDbStoreWithPersistMock(
    persistImpl: jest.Mock<Promise<void>, [RouteDurableState]>
  ): RouteDurableStore {
    const store = new RouteDurableStore('/tmp/test-store-140.json', 'db');
    (store as any).loadStateFromDb = jest
      .fn()
      .mockImplementation(async () => structuredClone(makeDefaultState()));
    (store as any).persistStateToDb = persistImpl;
    return store;
  }

  it('retries conflicts with exponential backoff and full jitter until write succeeds', async () => {
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const persistStateToDb = jest
      .fn<Promise<void>, [RouteDurableState]>()
      .mockRejectedValueOnce(
        new ConcurrencyConflictError('wrfcoin-route-state-v1', 1, 2)
      )
      .mockRejectedValueOnce(
        new ConcurrencyConflictError('wrfcoin-route-state-v1', 2, 3)
      )
      .mockRejectedValueOnce(
        new ConcurrencyConflictError('wrfcoin-route-state-v1', 3, 4)
      )
      .mockResolvedValue(undefined);
    const store = makeDbStoreWithPersistMock(persistStateToDb);

    const writePromise = store.write(state => {
      state.weather.records.weather_140 = {
        id: 'weather_140',
        stationId: 'station-140',
        timestamp: '2026-03-11T00:00:00.000Z',
        temperature: 21.5,
        submittedAt: '2026-03-11T00:00:00.000Z',
      };
      return state.weather.records.weather_140.id;
    });

    await jest.runAllTimersAsync();

    await expect(writePromise).resolves.toBe('weather_140');
    expect(persistStateToDb).toHaveBeenCalledTimes(4);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(3);
    expect(setTimeoutSpy).toHaveBeenNthCalledWith(1, expect.any(Function), 12.5);
    expect(setTimeoutSpy).toHaveBeenNthCalledWith(2, expect.any(Function), 25);
    expect(setTimeoutSpy).toHaveBeenNthCalledWith(3, expect.any(Function), 50);
    expect(consoleLogSpy).toHaveBeenCalledTimes(3);
    expect(
      consoleLogSpy.mock.calls
        .map(call => call.join(' '))
        .some(message => message.includes('retrying after concurrency conflict'))
    ).toBe(true);

    randomSpy.mockRestore();
  });

  it('caps backoff growth at 800ms and rethrows after exhausting the retry budget', async () => {
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(1);
    const conflict = new ConcurrencyConflictError('wrfcoin-route-state-v1', 9, 10);
    const persistStateToDb = jest
      .fn<Promise<void>, [RouteDurableState]>()
      .mockRejectedValue(conflict);
    const store = makeDbStoreWithPersistMock(persistStateToDb);

    const writePromise = store.write(state => {
      state.weather.records.weather_140 = {
        id: 'weather_140',
        stationId: 'station-140',
        timestamp: '2026-03-11T00:00:00.000Z',
        humidity: 48,
        submittedAt: '2026-03-11T00:00:00.000Z',
      };
      return 'never';
    });
    const rejection = expect(writePromise).rejects.toBe(conflict);

    await jest.runAllTimersAsync();

    await rejection;
    expect(persistStateToDb).toHaveBeenCalledTimes(7);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(6);
    expect(setTimeoutSpy).toHaveBeenNthCalledWith(1, expect.any(Function), 25);
    expect(setTimeoutSpy).toHaveBeenNthCalledWith(2, expect.any(Function), 50);
    expect(setTimeoutSpy).toHaveBeenNthCalledWith(3, expect.any(Function), 100);
    expect(setTimeoutSpy).toHaveBeenNthCalledWith(4, expect.any(Function), 200);
    expect(setTimeoutSpy).toHaveBeenNthCalledWith(5, expect.any(Function), 400);
    expect(setTimeoutSpy).toHaveBeenNthCalledWith(6, expect.any(Function), 800);

    randomSpy.mockRestore();
  });

  it('does not retry non-conflict persistence failures', async () => {
    const persistError = new Error('database offline');
    const persistStateToDb = jest
      .fn<Promise<void>, [RouteDurableState]>()
      .mockRejectedValue(persistError);
    const store = makeDbStoreWithPersistMock(persistStateToDb);

    await expect(
      store.write(state => {
        state.weather.records.weather_140 = {
          id: 'weather_140',
          stationId: 'station-140',
          timestamp: '2026-03-11T00:00:00.000Z',
          pressure: 1012.4,
          submittedAt: '2026-03-11T00:00:00.000Z',
        };
        return 'never';
      })
    ).rejects.toThrow('database offline');

    expect(persistStateToDb).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });
});
