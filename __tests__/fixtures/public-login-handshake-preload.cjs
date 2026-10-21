// Preload for the public-login-handshake mount-order regression test.
//
// Boots the real enhanced_unified_api_optimized.ts entrypoint against stubbed
// Redis/Postgres so the login-handshake endpoints can be exercised through the
// genuine Express middleware stack. Modeled on r20-degraded-mount-preload.cjs.
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const originalLoad = Module._load;
const preloadSentinel = '__WRFCOIN_LOGIN_HANDSHAKE_PRELOAD_READY__';

// Minimal in-memory stand-in for ioredis, including atomic nonce issuance.
// Real Lua concurrency/expiry is covered by the isolated Redis regression run.
class FakeRedis extends EventEmitter {
  constructor() {
    super();
    this.store = new Map();
    this.nonceQuotas = new Map();
  }
  async connect() {
    this.emit('connect');
    this.emit('ready');
  }
  async set(key, value) {
    this.store.set(key, value);
    return 'OK';
  }
  async eval(script, keyCount, quota, challenge, limit, ttl, value) {
    if (!script.startsWith('-- wallet_nonce_issuance_v2') || keyCount !== 2) {
      throw new Error('unsupported Redis script in login fixture');
    }
    const now = Date.now();
    let bucket = this.nonceQuotas.get(quota);
    if (!bucket || bucket.expires <= now) bucket = { count: 0, expires: now + Number(ttl) * 1000 };
    if (bucket.count >= Number(limit)) return [0, Math.max(1, Math.ceil((bucket.expires - now) / 1000))];
    if (this.store.has(challenge)) return [-1, 0];
    bucket.count += 1;
    this.nonceQuotas.set(quota, bucket);
    await this.set(challenge, value);
    return [1, Number(ttl)];
  }
  async get(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }
  async del(key) {
    return this.store.delete(key) ? 1 : 0;
  }
  async exists(key) {
    return this.store.has(key) ? 1 : 0;
  }
  pipeline() {
    const responses = [];
    const pipeline = {
      zremrangebyscore: () => {
        responses.push([null, 0]);
        return pipeline;
      },
      zadd: () => {
        responses.push([null, 1]);
        return pipeline;
      },
      zcard: () => {
        // Each HTTP request gets an isolated synthetic limiter observation.
        // This test exercises middleware ordering, not limiter persistence.
        responses.push([null, 1]);
        return pipeline;
      },
      expire: () => {
        responses.push([null, 1]);
        return pipeline;
      },
      exec: async () => responses,
    };
    return pipeline;
  }
  async ttl() {
    return -1;
  }
  async incr(key) {
    const next = Number(this.store.get(key) || 0) + 1;
    this.store.set(key, next);
    return next;
  }
  async setex(key, _ttl, value) {
    this.store.set(key, value);
    return 'OK';
  }
  async config() {
    return ['maxmemory-policy', 'noeviction'];
  }
  async quit() {
    return 'OK';
  }
  disconnect() {}
}

function fakeRedisClient() {
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

let sentinelWritten = false;

Module._load = function loginHandshakeLoad(request, parent, isMain) {
  // ioredis is imported as a default export (`import Redis from 'ioredis'`).
  // Provide both shapes so CJS and ESM-interop consumers resolve the stub.
  if (request === 'ioredis') {
    return Object.assign(FakeRedis, {
      default: FakeRedis,
      Redis: FakeRedis,
      __esModule: true,
    });
  }

  const loaded = originalLoad.call(this, request, parent, isMain);

  if (request.includes('utils/create-redis')) {
    return { ...loaded, createRedisClient: () => fakeRedisClient() };
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

  if (!sentinelWritten && request.includes('wrfsentinel-crosspost-routes')) {
    sentinelWritten = true;
    process.stdout.write(`${preloadSentinel}\n`);
  }

  return loaded;
};
