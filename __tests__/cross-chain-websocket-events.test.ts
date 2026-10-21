import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { EventEmitter } from 'events';

const ORIGINAL_ENV = { ...process.env };

type ServerModule = {
  __testHooks: {
    resetSecurityStateForTests: () => void;
    cleanupCanonicalSources: () => void;
    addTestClient: (subscriptions?: string[]) => any;
    getChannelSubscriberCount: (channel: string) => number;
    handleClientMessage: (ws: any, payload: Record<string, unknown>) => void;
    normalizeClientMessage: (payload: Record<string, unknown>) => {
      action: string;
      channels: string[];
    };
    broadcast: (channel: string, event: string, data: Record<string, unknown>) => {
      skipped: boolean;
      reason: string | null;
      subscriberCount: number;
      delivered: number;
    };
    emitSyntheticDemoEvents: () => {
      enabled: boolean;
      emitted: number;
      results?: unknown[];
    };
    getEventPipelineConfig: () => {
      syntheticEventsFlag: boolean;
      syntheticEventsEnabled: boolean;
      canonicalOnlyInProduction: boolean;
    };
    CHANNELS: {
      GLOBAL: string;
      BLOCKCHAIN: string;
      CROSS_CHAIN: string;
      MINING: string;
    };
  };
};

function loadServerModule(
  envOverrides: Record<string, string | undefined> = {}
): ServerModule {
  jest.resetModules();
  jest.doMock(
    'express',
    () => {
      const createApp = () => ({
        use: jest.fn(),
        get: jest.fn(),
        post: jest.fn(),
      });
      createApp.json = jest.fn(() => (_req: unknown, _res: unknown, next: () => void) => next());
      return createApp;
    },
    { virtual: true }
  );
  jest.doMock(
    'ws',
    () => {
      class MockWebSocketServer {
        clients = new Set<any>();
        on = jest.fn();
        close = jest.fn((callback?: () => void) => callback?.());
        handleUpgrade = jest.fn();
      }

      return {
        OPEN: 1,
        Server: MockWebSocketServer,
      };
    },
    { virtual: true }
  );
  jest.doMock(
    'cors',
    () => jest.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
    { virtual: true }
  );
  jest.doMock(
    'helmet',
    () => jest.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
    { virtual: true }
  );
  jest.doMock(
    'express-rate-limit',
    () => jest.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
    { virtual: true }
  );
  jest.doMock(
    'uuid',
    () => ({
      v4: jest.fn(() => 'test-client-id'),
    }),
    { virtual: true }
  );
  jest.doMock('../server/utils/otel-setup.js', () => ({
    initializeOTel: jest.fn(async () => {}),
  }));
  jest.doMock('../server/utils/logger.js', () => ({
    blockchainLogger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
  }));
  jest.doMock('../server/middleware/create-health-middleware', () => ({
    createHealthMiddleware: jest.fn(() => ({
      router: (_req: unknown, _res: unknown, next: () => void) => next(),
    })),
  }));
  jest.doMock('../server/utils/graceful-shutdown', () => ({
    registerGracefulShutdown: jest.fn(),
  }));
  jest.doMock('../server/events/cross-chain-event-bus.js', () => {
    const crossChainEventBus = new EventEmitter();
    return {
      crossChainEventBus,
      CROSS_CHAIN_EVENT_TYPES: {
        BRIDGE_TRANSACTION: 'BRIDGE_TRANSACTION',
      },
    };
  });
  process.env = {
    ...ORIGINAL_ENV,
    JWT_SECRET: 'test-jwt-secret-key-for-cross-chain-websocket-events-12345',
    WS_DISABLE_AUTO_LISTEN: 'true',
    WS_DISABLE_BACKGROUND_TASKS: 'true',
    OTEL_ENABLED: 'false',
    LOG_LEVEL: 'error',
    SILENT_LOGS: 'true',
    DISABLE_FILE_LOG_TRANSPORTS: 'true',
    ...envOverrides,
  };

  const loaded = require('../server/cross_chain_websocket_server.js') as ServerModule;
  loaded.__testHooks.resetSecurityStateForTests();
  return loaded;
}

describe('cross-chain websocket event pipeline', () => {
  afterEach(() => {
    try {
      const loaded = require('../server/cross_chain_websocket_server.js') as ServerModule;
      loaded.__testHooks.cleanupCanonicalSources();
      loaded.__testHooks.resetSecurityStateForTests();
    } catch {
      // ignore cleanup errors after module resets
    }
    process.env = { ...ORIGINAL_ENV };
    jest.resetModules();
  });

  it('disables synthetic broadcasts by default', () => {
    const mod = loadServerModule({
      NODE_ENV: 'development',
      WS_ENABLE_SYNTHETIC_EVENTS: undefined,
    });

    const config = mod.__testHooks.getEventPipelineConfig();
    expect(config.syntheticEventsFlag).toBe(false);
    expect(config.syntheticEventsEnabled).toBe(false);
  });

  it('enables synthetic broadcasts only with explicit local development flag', () => {
    const mod = loadServerModule({
      NODE_ENV: 'development',
      WS_ENABLE_SYNTHETIC_EVENTS: 'true',
    });

    const config = mod.__testHooks.getEventPipelineConfig();
    expect(config.syntheticEventsFlag).toBe(true);
    expect(config.syntheticEventsEnabled).toBe(true);
  });

  it('keeps synthetic broadcasts disabled in production even when flag is true', () => {
    const mod = loadServerModule({
      NODE_ENV: 'production',
      WRFCOIN_ENV: 'production',
      CORS_ORIGIN: 'https://wrfcoin-testnet.example', // backend#1236
      WS_ENABLE_SYNTHETIC_EVENTS: 'true',
    });

    const config = mod.__testHooks.getEventPipelineConfig();
    expect(config.syntheticEventsFlag).toBe(true);
    expect(config.syntheticEventsEnabled).toBe(false);
    expect(config.canonicalOnlyInProduction).toBe(true);
  });

  it('skips channel broadcast work when there are no subscribers', () => {
    const mod = loadServerModule();
    const { CHANNELS } = mod.__testHooks;

    const result = mod.__testHooks.broadcast(CHANNELS.BLOCKCHAIN, 'NEW_BLOCK', {
      blockHeight: 123,
      hash: '0xabc',
      transactions: 2,
    });

    expect(mod.__testHooks.getChannelSubscriberCount(CHANNELS.BLOCKCHAIN)).toBe(0);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('no-subscribers');
    expect(result.delivered).toBe(0);
  });

  it('emits no random synthetic payloads in default runtime config', () => {
    const mod = loadServerModule({
      NODE_ENV: 'development',
      WS_ENABLE_SYNTHETIC_EVENTS: undefined,
    });
    const { CHANNELS } = mod.__testHooks;

    const client = mod.__testHooks.addTestClient([
      CHANNELS.BLOCKCHAIN,
      CHANNELS.CROSS_CHAIN,
      CHANNELS.MINING,
    ]);
    client.send = jest.fn();

    const result = mod.__testHooks.emitSyntheticDemoEvents();
    expect(result.enabled).toBe(false);
    expect(result.emitted).toBe(0);
    expect(client.send).not.toHaveBeenCalled();
  });

  it('broadcasts canonical bridge payloads that match data contract', () => {
    const mod = loadServerModule({
      NODE_ENV: 'production',
      WRFCOIN_ENV: 'production',
      CORS_ORIGIN: 'https://wrfcoin-testnet.example', // backend#1236
    });
    const { CHANNELS } = mod.__testHooks;

    const client = mod.__testHooks.addTestClient([CHANNELS.CROSS_CHAIN]);
    client.send = jest.fn();

    const { crossChainEventBus, CROSS_CHAIN_EVENT_TYPES } = require('../server/events/cross-chain-event-bus.js');
    crossChainEventBus.emit(CROSS_CHAIN_EVENT_TYPES.BRIDGE_TRANSACTION, {
      transaction: {
        tx_id: 'bridge-123',
        status: 'PROCESSING',
        from_chain: 'ethereum',
        to_chain: 'wrfcoin',
        amount: 42,
        source_tx_hash: '0xsource',
        destination_tx_hash: '0xdest',
      },
      message: 'bridge update',
    });

    expect(client.send).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(client.send.mock.calls[0][0]);
    expect(payload.channel).toBe(CHANNELS.CROSS_CHAIN);
    expect(payload.event).toBe('BRIDGE_TRANSFER');
    expect(payload.data).toMatchObject({
      transferId: 'bridge-123',
      fromChain: 'ethereum',
      toChain: 'wrfcoin',
      amount: '42',
      token: 'WRF',
      status: 'processing',
      sourceTxHash: '0xsource',
      destinationTxHash: '0xdest',
    });
  });

  it('normalizes legacy and canonical subscription message shapes', () => {
    const mod = loadServerModule();

    expect(
      mod.__testHooks.normalizeClientMessage({
        action: 'subscribe',
        channels: ['blockchain'],
      })
    ).toEqual({
      action: 'subscribe',
      channels: ['blockchain'],
    });

    expect(
      mod.__testHooks.normalizeClientMessage({
        type: 'subscribe',
        channel: 'ignored',
        channels: ['mining'],
      })
    ).toEqual({
      action: 'subscribe',
      channels: ['mining'],
    });

    expect(
      mod.__testHooks.normalizeClientMessage({
        event: 'SUBSCRIBE',
        data: { channels: ['cross-chain'] },
      })
    ).toEqual({
      action: 'subscribe',
      channels: ['cross-chain'],
    });
  });

  it('accepts action-based subscribe messages and emits canonical updates', () => {
    const mod = loadServerModule();
    const { CHANNELS } = mod.__testHooks;
    const client = mod.__testHooks.addTestClient([CHANNELS.GLOBAL]);
    client.send = jest.fn();

    mod.__testHooks.handleClientMessage(client, {
      action: 'subscribe',
      channels: [CHANNELS.BLOCKCHAIN],
    });

    expect(client.send).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(client.send.mock.calls[0][0]);
    expect(payload.channel).toBe(CHANNELS.GLOBAL);
    expect(payload.event).toBe('SUBSCRIPTION_UPDATED');
    expect(payload.data.subscriptions).toContain(CHANNELS.BLOCKCHAIN);
  });
});
