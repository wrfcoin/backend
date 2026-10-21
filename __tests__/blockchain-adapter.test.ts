const mockPublishEvent = jest.fn();
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

const wsInstances: MockWebSocket[] = [];

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  public readyState = MockWebSocket.OPEN;
  public listeners: Record<string, Array<(...args: any[]) => void>> = {};
  public terminate = jest.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
  });
  public removeAllListeners = jest.fn((event: string) => {
    this.listeners[event] = [];
  });

  constructor(public readonly url: string) {
    wsInstances.push(this);
  }

  on(event: string, listener: (...args: any[]) => void): this {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event].push(listener);
    return this;
  }

  emit(event: string, ...args: any[]): void {
    for (const listener of this.listeners[event] ?? []) {
      listener(...args);
    }
  }
}

jest.mock('../graphql/resolvers/subscription-resolvers.js', () => ({
  publishEvent: mockPublishEvent,
}));

jest.mock('../server/utils/logger.js', () => ({
  blockchainLogger: mockLogger,
}));

jest.mock(
  'axios',
  () => ({
    get: jest.fn(),
    create: jest.fn(() => ({
      get: jest.fn(),
    })),
  }),
  { virtual: true }
);

jest.mock('ws', () => MockWebSocket, { virtual: true });

describe('blockchain adapter websocket bridge', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.useFakeTimers();
    wsInstances.length = 0;
  });

  afterEach(async () => {
    const adapter = require('../server/blockchain_adapter.js');
    await adapter.cleanup();
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('publishes validated new block events with schema-compatible fields', () => {
    const adapter = require('../server/blockchain_adapter.js');

    adapter.handleBlockchainEvent({
      type: 'NewBlock',
      payload: {
        height: 42,
        hash: 'block-hash-42',
        timestamp: '2026-03-08T06:00:00.000Z',
        transactions: ['0xabc', '', '0xdef'],
        producer: '0x0000000000000000000000000000000000000042',
      },
    });

    expect(mockPublishEvent).toHaveBeenCalledWith('NEW_BLOCK', {
      newBlock: {
        id: 'block-hash-42',
        height: 42,
        hash: 'block-hash-42',
        timestamp: '2026-03-08T06:00:00.000Z',
        transactions: ['0xabc', '0xdef'],
        producer: '0x0000000000000000000000000000000000000042',
      },
    });
  });

  it('drops malformed blockchain events instead of publishing undefined fields', () => {
    const adapter = require('../server/blockchain_adapter.js');

    adapter.handleBlockchainEvent({ type: 'NewBlock', payload: { hash: 'missing-height' } });
    adapter.handleBlockchainEvent({ type: 'BridgeLock', payload: { amount: 99 } });
    adapter.handleBlockchainEvent({ type: 'SystemStatus', payload: 'invalid' });
    adapter.handleBlockchainEvent({ nope: true });

    expect(mockPublishEvent).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('uses exponential reconnect backoff and prevents stale sockets from scheduling reconnects', () => {
    const adapter = require('../server/blockchain_adapter.js');

    adapter.connectWebSocket();
    expect(wsInstances).toHaveLength(1);

    const firstSocket = wsInstances[0];
    adapter.connectWebSocket();
    expect(firstSocket.removeAllListeners).toHaveBeenCalledWith('close');
    expect(firstSocket.terminate).toHaveBeenCalledTimes(1);
    expect(wsInstances).toHaveLength(2);

    firstSocket.emit('close');
    jest.advanceTimersByTime(60000);
    expect(wsInstances).toHaveLength(2);

    const secondSocket = wsInstances[1];
    secondSocket.emit('close');
    jest.advanceTimersByTime(4999);
    expect(wsInstances).toHaveLength(2);
    jest.advanceTimersByTime(1);
    expect(wsInstances).toHaveLength(3);
  });

  it('reports websocket contract health transitions for core4 connections', async () => {
    const adapter = require('../server/blockchain_adapter.js');
    const axios = require('axios');
    adapter.isCore4 = true;
    adapter.useMockData = false;
    axios.get
      .mockRejectedValueOnce(new Error('core4 api not reachable'))
      .mockResolvedValueOnce({ status: 200, data: { status: 'ok' } })
      .mockResolvedValueOnce({ status: 200, data: { status: 'ok' } })
      .mockRejectedValueOnce(new Error('core4 api down'));

    expect(await adapter.getHealthStatus()).toMatchObject({
      status: 'unhealthy',
      services: {
        blockchain: {
          status: 'unhealthy',
          api: {
            status: 'down',
            reachable: false,
          },
          websocket: {
            status: 'down',
            expected: true,
            connected: false,
            reconnectPending: false,
          },
        },
      },
    });

    adapter.connectWebSocket();
    expect(await adapter.getHealthStatus()).toMatchObject({
      status: 'unhealthy',
      services: {
        blockchain: {
          websocket: {
            status: 'down',
            connected: false,
          },
        },
      },
    });

    const socket = wsInstances[0];
    socket.emit('open');

    const healthyStatus = await adapter.refreshHealthStatus();

    expect(healthyStatus).toMatchObject({
      status: 'healthy',
      services: {
        blockchain: {
          status: 'healthy',
          api: {
            status: 'up',
            reachable: true,
            httpStatus: 200,
          },
          websocket: {
            status: 'up',
            expected: true,
            connected: true,
            reconnectPending: false,
          },
        },
      },
    });

    socket.emit('error', new Error('core4 websocket failed'));
    socket.emit('close');

    const unhealthyStatus = await adapter.refreshHealthStatus();

    expect(unhealthyStatus).toMatchObject({
      status: 'unhealthy',
      services: {
        blockchain: {
          status: 'unhealthy',
          api: {
            status: 'down',
            reachable: false,
            lastError: 'core4 api down',
          },
          websocket: {
            status: 'down',
            connected: false,
            reconnectPending: true,
            lastError: 'core4 websocket failed',
          },
        },
      },
    });
  });
});
