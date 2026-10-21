const fs = require('node:fs');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const originalLoad = Module._load;
const countsPath = process.env.WRFCOIN_R20_COUNTS_FILE;
const preloadSentinel = '__WRFCOIN_R20_PRELOAD_READY__';
const counts = { soil: 0, ocean: 0, hydrology: 0 };

function writeCounts() {
  if (countsPath) fs.writeFileSync(countsPath, JSON.stringify(counts));
}

function fakeRedis() {
  const client = new EventEmitter();
  client.connect = async () => {
    client.emit('connect');
    client.emit('ready');
  };
  client.config = async () => ['maxmemory-policy', 'noeviction'];
  client.exists = async () => 0;
  client.quit = async () => undefined;
  client.disconnect = () => undefined;
  return client;
}

Module._load = function r20Load(request, parent, isMain) {
  if (
    request === './routes/environment-reports-routes' &&
    parent?.filename?.endsWith('server/enhanced_unified_api_optimized.ts')
  ) {
    process.stdout.write(`${preloadSentinel}\n`);
    if (process.env.WRFCOIN_R20_SKIP_MOUNT_FAILURE !== '1') {
      throw new Error('R20 test: forced environment-router mount failure');
    }
  }

  const loaded = originalLoad.call(this, request, parent, isMain);

  if (request.includes('utils/create-redis')) {
    return { ...loaded, createRedisClient: () => fakeRedis() };
  }

  if (request.includes('database/connection')) {
    return {
      ...loaded,
      connectWithRetry: async () => undefined,
      executeQuery: async () => ({ rows: [] }),
    };
  }

  if (request.includes('environmental-risk-bootstrap')) {
    loaded.ensureEnvironmentalRiskBaseline = async () => ({ status: 'skipped-test' });
  }

  if (request.includes('schema-verify')) {
    loaded.verifySchemaIntegrity = async () => undefined;
  }

  if (request.includes('services/redis-session-service')) {
    loaded.sessionService.validateSession = async (sessionId) => ({
      userId: 'r20-test-user',
      roles: ['user'],
      permissions: [],
      sessionId,
      createdAt: new Date(),
      lastActivity: new Date(),
    });
    loaded.sessionService.updateSessionActivity = async () => true;
  }

  if (request.includes('services/environment-phase2-reports-service')) {
    for (const [domain, method] of Object.entries({
      soil: 'ingestSoil',
      ocean: 'ingestOcean',
      hydrology: 'ingestHydrology',
    })) {
      const service = loaded.environmentPhase2ReportsService;
      const originalMethod = service[method].bind(service);
      service[method] = (...args) => {
        counts[domain] += 1;
        writeCounts();
        return originalMethod(...args);
      };
    }
  }

  return loaded;
};

process.on('exit', writeCounts);
