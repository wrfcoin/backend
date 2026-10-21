const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const mockCrosschainLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

const bridgeValidatorsActiveGauge = {
  set: jest.fn(),
};

jest.mock('express', () => {
  const createRouter = () => ({
    stack: [],
    get(routePath, handler) {
      this.stack.push({
        route: {
          path: routePath,
          methods: { get: true },
          stack: [{ handle: handler }],
        },
      });
      return this;
    },
    post(routePath, handler) {
      this.stack.push({
        route: {
          path: routePath,
          methods: { post: true },
          stack: [{ handle: handler }],
        },
      });
      return this;
    },
    use() {
      return this;
    },
  });

  const express = () => createRouter();
  express.Router = () => createRouter();
  return express;
}, { virtual: true });

jest.mock('../security/enterprise-hsm-service', () => {
  return jest.fn().mockImplementation(() => ({}));
});

jest.mock('../shared/route-durable-store', () => {
  const state = {
    bridges: {
      transactions: {},
      verificationResults: {},
      safety: {
        halted: false,
        haltedAt: null,
        haltReason: null,
        anomalyFailuresInWindow: 0,
        anomalyFailureThreshold: 5,
      },
    },
  };

  const routeDurableStore = {
    getConsistencyState: () => ({
      health: 'healthy',
      readMode: 'legacy-only',
      backend: 'file',
      issues: [],
    }),
    getBridgeSafety: async () => state.bridges.safety,
    write: async (writer) => writer(state),
  };

  return { routeDurableStore };
});

jest.mock('../shared/bridge-verification-orchestrator', () => {
  class MockBridgeVerificationOrchestrator {
    constructor() {
      this.registerValidator = jest.fn();
      this.getStatistics = jest.fn(() => ({
        registeredValidators: 0,
        activeValidators: 0,
      }));
    }
  }

  return {
    BridgeVerificationOrchestrator: MockBridgeVerificationOrchestrator,
  };
});

jest.mock('../shared/bridge-chain-adapters/index', () => ({
  chainRegistry: {
    getSupportedChains: () => ['ethereum', 'polygon'],
    getAllChains: () => [],
  },
}));

jest.mock('../server/utils/logger.js', () => ({
  crosschainLogger: mockCrosschainLogger,
}));

jest.mock('../server/utils/metrics.js', () => ({
  serviceHealthGauge: {
    set: jest.fn(),
  },
  bridgeValidatorsActiveGauge,
}));

describe('Bridges capability readiness route', () => {
  let readinessHandler;
  let routeDurableStore;
  let tempStorePath;

  const previousStorePath = process.env.WRFCOIN_ROUTE_STORE_PATH;
  const previousStoreBackend = process.env.WRFCOIN_ROUTE_STORE_BACKEND;
  const previousValidators = process.env.BRIDGE_VALIDATORS;

  beforeAll(async () => {
    tempStorePath = path.join(
      os.tmpdir(),
      `wrfcoin-bridge-capability-readiness-${Date.now()}-${Math.random()
        .toString(16)
        .slice(2)}.json`
    );

    process.env.WRFCOIN_ROUTE_STORE_PATH = tempStorePath;
    process.env.WRFCOIN_ROUTE_STORE_BACKEND = 'file';
    process.env.BRIDGE_VALIDATORS = '[]';

    const bridgesModule = require('../server/routes/bridges.js');
    const storeModule = require('../shared/route-durable-store');
    routeDurableStore = storeModule.routeDurableStore;
    const router = bridgesModule.default || bridgesModule;
    const readinessLayer = router.stack.find(
      (layer) =>
        layer.route &&
        layer.route.path === '/capabilities/readiness' &&
        layer.route.methods &&
        layer.route.methods.get
    );

    if (!readinessLayer) {
      throw new Error('Readiness route handler was not registered');
    }

    readinessHandler = readinessLayer.route.stack[0].handle;
  });

  beforeEach(async () => {
    await routeDurableStore.write((state) => {
      state.bridges.transactions = {};
      state.bridges.verificationResults = {};
      state.bridges.safety.halted = false;
      state.bridges.safety.haltedAt = null;
      state.bridges.safety.haltReason = null;
      state.bridges.safety.anomalyFailuresInWindow = 0;
      state.bridges.safety.anomalyFailureThreshold = 5;
      return state;
    });
  });

  afterAll(async () => {
    if (typeof previousStorePath === 'string') {
      process.env.WRFCOIN_ROUTE_STORE_PATH = previousStorePath;
    } else {
      delete process.env.WRFCOIN_ROUTE_STORE_PATH;
    }

    if (typeof previousStoreBackend === 'string') {
      process.env.WRFCOIN_ROUTE_STORE_BACKEND = previousStoreBackend;
    } else {
      delete process.env.WRFCOIN_ROUTE_STORE_BACKEND;
    }

    if (typeof previousValidators === 'string') {
      process.env.BRIDGE_VALIDATORS = previousValidators;
    } else {
      delete process.env.BRIDGE_VALIDATORS;
    }

    await fs.rm(tempStorePath, { force: true });
  });

  it('returns capability readiness for bridge transfer and verification', async () => {
    const req = {};
    const res = {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        return this;
      },
    };

    await readinessHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.modes).toEqual(
      expect.arrayContaining([
        'unavailable',
        'simulated',
        'local-manager',
        'production-verified',
        'degraded',
      ])
    );
    expect(res.body.capabilities['bridge.transfer']).toMatchObject({
      capabilityId: 'bridge.transfer',
      mode: 'degraded',
      reasonCode: 'NO_ACTIVE_VALIDATORS',
    });
    expect(res.body.capabilities['bridge.verification']).toMatchObject({
      capabilityId: 'bridge.verification',
      mode: 'degraded',
      reasonCode: 'NO_ACTIVE_VALIDATORS',
    });
    expect(res.body.capabilities['route.store']).toMatchObject({
      capabilityId: 'route.store',
      mode: 'production-verified',
    });
    expect(bridgeValidatorsActiveGauge.set).toHaveBeenCalledWith(
      { bridge: 'bridge.transfer' },
      0
    );
    expect(mockCrosschainLogger.warn).toHaveBeenCalledWith(
      'No active bridge validators configured at startup; bridge verification is unsafe until BRIDGE_VALIDATORS is populated',
      expect.objectContaining({
        service: 'bridges',
        bridge: 'bridge.transfer',
        validatorConfigSource: 'configured',
        allowSimulatedMode: false,
      })
    );
  });

  it('treats malformed BRIDGE_VALIDATORS as invalid without crashing startup', async () => {
    const previousValidators = process.env.BRIDGE_VALIDATORS;
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      process.env.BRIDGE_VALIDATORS = '{bad json';
      mockCrosschainLogger.warn.mockClear();
      bridgeValidatorsActiveGauge.set.mockClear();
      jest.resetModules();

      const bridgesModule = require('../server/routes/bridges.js');
      const router = bridgesModule.default || bridgesModule;
      const readinessLayer = router.stack.find(
        (layer) =>
          layer.route &&
          layer.route.path === '/capabilities/readiness' &&
          layer.route.methods &&
          layer.route.methods.get
      );

      if (!readinessLayer) {
        throw new Error('Readiness route handler was not registered');
      }

      const malformedReadinessHandler = readinessLayer.route.stack[0].handle;
      const req = {};
      const res = {
        statusCode: 200,
        body: null,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(payload) {
          this.body = payload;
          return this;
        },
      };

      await malformedReadinessHandler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.signals.validatorConfigSource).toBe('invalid');
      expect(res.body.capabilities['bridge.verification']).toMatchObject({
        mode: 'degraded',
        reasonCode: 'NO_ACTIVE_VALIDATORS',
      });
      expect(errorSpy).toHaveBeenCalledWith(
        'Invalid BRIDGE_VALIDATORS JSON; using empty validator list',
        expect.objectContaining({
          error: expect.stringContaining('JSON'),
        })
      );
      expect(bridgeValidatorsActiveGauge.set).toHaveBeenCalledWith(
        { bridge: 'bridge.transfer' },
        0
      );
      expect(mockCrosschainLogger.warn).toHaveBeenCalledWith(
        'No active bridge validators configured at startup; bridge verification is unsafe until BRIDGE_VALIDATORS is populated',
        expect.objectContaining({
          service: 'bridges',
          bridge: 'bridge.transfer',
          validatorConfigSource: 'invalid',
          allowSimulatedMode: false,
        })
      );
    } finally {
      errorSpy.mockRestore();

      if (typeof previousValidators === 'string') {
        process.env.BRIDGE_VALIDATORS = previousValidators;
      } else {
        delete process.env.BRIDGE_VALIDATORS;
      }

      jest.resetModules();
    }
  });

  it('reports degraded transfer readiness when bridge safety is halted', async () => {
    await routeDurableStore.write((state) => {
      state.bridges.safety.halted = true;
      state.bridges.safety.haltedAt = new Date().toISOString();
      state.bridges.safety.haltReason = 'test halt';
      return state;
    });

    const req = {};
    const res = {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        return this;
      },
    };

    await readinessHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.capabilities['bridge.transfer'].mode).toBe('degraded');
    expect(res.body.capabilities['bridge.transfer'].reasonCode).toBe(
      'BRIDGE_HALTED'
    );
    expect(res.body.overallMode).toBe('degraded');
  });
});
