'use strict';

const { Pool } = require('pg');

const sharedPools = new Map();

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeSslConfig(ssl) {
  if (!ssl || typeof ssl !== 'object' || Array.isArray(ssl)) {
    return ssl ?? false;
  }

  return Object.keys(ssl)
    .sort()
    .reduce((result, key) => {
      result[key] = ssl[key];
      return result;
    }, {});
}

function normalizePoolConfig(config = {}) {
  return {
    ...config,
    ssl: normalizeSslConfig(config.ssl),
    max: parsePositiveInt(
      config.max,
      parsePositiveInt(process.env.DB_POOL_SIZE, 20)
    ),
    idleTimeoutMillis: parsePositiveInt(config.idleTimeoutMillis, 30000),
    connectionTimeoutMillis: parsePositiveInt(
      config.connectionTimeoutMillis,
      10000
    ),
  };
}

function createPoolKey(config) {
  return JSON.stringify(
    Object.keys(config)
      .sort()
      .reduce((result, key) => {
        result[key] = config[key];
        return result;
      }, {})
  );
}

function getSharedPgPool(config = {}, options = {}) {
  const normalizedConfig =
    typeof config === 'string'
      ? normalizePoolConfig({ connectionString: config })
      : normalizePoolConfig(config);
  const cacheKey = createPoolKey(normalizedConfig);
  const existingPool = sharedPools.get(cacheKey);

  if (existingPool) {
    return existingPool;
  }

  const pool = new Pool(normalizedConfig);

  pool.on('error', error => {
    if (typeof options.onError === 'function') {
      options.onError(error);
    }
  });

  sharedPools.set(cacheKey, pool);
  return pool;
}

async function closeSharedPgPools() {
  const pools = Array.from(sharedPools.values());
  sharedPools.clear();

  await Promise.all(
    pools.map(pool =>
      pool.end().catch(() => {})
    )
  );
}

function getSharedPgPoolStats() {
  return Array.from(sharedPools.values()).map(pool => ({
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
  }));
}

module.exports = {
  getSharedPgPool,
  closeSharedPgPools,
  getSharedPgPoolStats,
};
