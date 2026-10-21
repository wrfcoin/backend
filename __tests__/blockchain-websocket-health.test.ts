type HealthResponse = {
  statusCode: number;
  body: any;
  status(code: number): HealthResponse;
  json(payload: unknown): HealthResponse;
};

// backend#1224: detailed probe bodies are served only to an operator/reader
// bearer token; these tests exercise that detailed contract.
process.env.WRFCOIN_READER_TOKEN = 'test-reader-token';
const READER_REQ: any = { headers: { authorization: 'Bearer test-reader-token' } };

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

jest.mock('express', () => ({ Router: () => ({ get: jest.fn() }) }), {
  virtual: true,
});

jest.mock('ws', () => MockWebSocket, { virtual: true });

describe('blockchain websocket health contract', () => {
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

  function createResponse(): HealthResponse {
    return {
      statusCode: 200,
      body: undefined,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: unknown) {
        this.body = payload;
        return this;
      },
    };
  }

  function createBlockchainProbe(adapter: any) {
    const { createHealthMiddleware } = require('../server/middleware/create-health-middleware');

    return createHealthMiddleware('main-api-server', {
      blockchain: {
        critical: true,
        check: async () => {
          const blockchainHealth = await adapter.refreshHealthStatus();
          return {
            status: blockchainHealth.status === 'healthy' ? 'up' : 'down',
            services: blockchainHealth.services,
          };
        },
      },
    });
  }

  it('marks /health unhealthy when the core4 websocket contract is down', async () => {
    const adapter = require('../server/blockchain_adapter.js');
    const axios = require('axios');
    axios.get.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    adapter.isCore4 = true;
    adapter.useMockData = false;
    adapter.connectWebSocket();

    const probes = createBlockchainProbe(adapter);
    const healthResponse = createResponse();
    const readinessResponse = createResponse();

    await probes.healthHandler(READER_REQ, healthResponse);
    await probes.readinessHandler(READER_REQ, readinessResponse);

    expect(healthResponse.statusCode).toBe(503);
    expect(healthResponse.body).toMatchObject({
      status: 'unhealthy',
      dependencies: {
        blockchain: {
          status: 'down',
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
        },
      },
    });

    expect(readinessResponse.statusCode).toBe(503);
    expect(readinessResponse.body.status).toBe('not_ready');
  });

  it('returns healthy again only after the websocket opens', async () => {
    const adapter = require('../server/blockchain_adapter.js');
    const axios = require('axios');
    axios.get.mockResolvedValueOnce({ status: 200, data: { status: 'ok' } });
    adapter.isCore4 = true;
    adapter.useMockData = false;
    adapter.connectWebSocket();
    wsInstances[0].emit('open');

    const probes = createBlockchainProbe(adapter);
    const response = createResponse();

    await probes.healthHandler(READER_REQ, response);

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      status: 'healthy',
      dependencies: {
        blockchain: {
          status: 'up',
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
        },
      },
    });
  });

  it('marks /health unhealthy when core4 HTTP is down even if websocket is connected', async () => {
    const adapter = require('../server/blockchain_adapter.js');
    const axios = require('axios');
    axios.get.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    adapter.isCore4 = true;
    adapter.useMockData = false;
    adapter.connectWebSocket();
    wsInstances[0].emit('open');

    const probes = createBlockchainProbe(adapter);
    const response = createResponse();

    await probes.healthHandler(READER_REQ, response);

    expect(response.statusCode).toBe(503);
    expect(response.body).toMatchObject({
      status: 'unhealthy',
      dependencies: {
        blockchain: {
          status: 'down',
          services: {
            blockchain: {
              status: 'unhealthy',
              api: {
                status: 'down',
                reachable: false,
                lastError: 'connect ECONNREFUSED',
              },
              websocket: {
                status: 'up',
                expected: true,
                connected: true,
                reconnectPending: false,
              },
            },
          },
        },
      },
    });
  });

  it('keeps health unhealthy while reconnect is pending after websocket failure', async () => {
    const adapter = require('../server/blockchain_adapter.js');
    const axios = require('axios');
    axios.get.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    adapter.isCore4 = true;
    adapter.useMockData = false;
    adapter.connectWebSocket();
    wsInstances[0].emit('open');
    wsInstances[0].emit('error', new Error('core4 websocket failed'));
    wsInstances[0].emit('close');

    const probes = createBlockchainProbe(adapter);
    const response = createResponse();

    await probes.healthHandler(READER_REQ, response);

    expect(response.statusCode).toBe(503);
    expect(response.body).toMatchObject({
      status: 'unhealthy',
      dependencies: {
        blockchain: {
          status: 'down',
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
                reconnectPending: true,
                lastError: 'core4 websocket failed',
              },
            },
          },
        },
      },
    });
  });
});
