/**
 * Live `/api/stats` builder (backend#1145).
 *
 * Replaces the `MOCK_DATA_GENERATORS.getStatsData` random generator the live
 * entrypoint served. Every number here is read from core4 (the same three
 * routes `GET /api/blockchain/status` proxies) or from the `weather_stations`
 * table. A figure with no real source is not estimated: it is omitted from
 * `data` and listed under `unavailable` with the reason, so a client can tell
 * "unknown" from "zero".
 *
 * Dependencies are injected so the builder is unit-testable without core4 or
 * Postgres.
 */

const NO_SOURCE = Object.freeze({
  totalUsers: 'no user registry is exposed by the testnet API',
  activeValidators:
    'core4 /transactions/stake/metrics is Reader-gated; GET /api/blockchain/status reports it when WRFCOIN_READER_TOKEN is configured',
  networkHashRate: 'core4 does not report a network hashrate',
  totalSupply: 'no supply accounting endpoint is wired',
  circulatingSupply: 'no supply accounting endpoint is wired',
  marketCap: 'no exchange or market feed is wired',
  price: 'no exchange or market feed is wired',
  totalStaked: 'no staking aggregate is exposed without Reader auth',
  stakingRewards: 'no staking aggregate is exposed without Reader auth',
  networkUptime: 'no uptime accounting is wired',
  totalEarnings: 'no earnings aggregate is wired',
});

/**
 * @param {object} deps
 * @param {(path: string, options?: object) => Promise<{ok: boolean, status?: number, payload?: unknown}>} deps.fetchCore4Json
 * @param {(payload: unknown) => any} deps.extractCore4Data
 * @param {(value: unknown) => any} deps.toNullable
 * @param {() => Promise<number>} deps.countActiveStations
 * @returns {Promise<{ok: true, data: object} | {ok: false, status: number, message: string, details: object}>}
 */
async function buildLiveStats({ fetchCore4Json, extractCore4Data, toNullable, countActiveStations }) {
  const [blockchainResponse, networkResponse, miningResponse] = await Promise.all([
    fetchCore4Json('/blockchain'),
    fetchCore4Json('/network/info'),
    fetchCore4Json('/mining/stats'),
  ]);

  const failed = [
    ['/blockchain', blockchainResponse],
    ['/network/info', networkResponse],
    ['/mining/stats', miningResponse],
  ].filter(([, response]) => !response || !response.ok);

  if (failed.length > 0) {
    return {
      ok: false,
      status: 503,
      message: 'Blockchain node unavailable',
      details: {
        code: 'CORE4_UNAVAILABLE',
        failedRoutes: failed.map(([route, response]) => ({
          route,
          status: response && typeof response.status === 'number' ? response.status : null,
        })),
      },
    };
  }

  const blockchain = extractCore4Data(blockchainResponse.payload) || {};
  const network = extractCore4Data(networkResponse.payload) || {};
  const mining = extractCore4Data(miningResponse.payload) || {};

  const unavailable = { ...NO_SOURCE };

  let weatherStations = null;
  try {
    const count = await countActiveStations();
    weatherStations = Number.isFinite(count) && count >= 0 ? count : null;
    if (weatherStations === null) {
      unavailable.weatherStations = 'weather_stations count did not return a number';
    }
  } catch (error) {
    unavailable.weatherStations = `weather_stations query failed: ${error instanceof Error ? error.message : String(error)}`;
  }

  return {
    ok: true,
    data: {
      currentBlockHeight: toNullable(blockchain.height ?? mining.chain_height),
      totalTransactions: toNullable(mining.total_transactions),
      pendingTransactions: toNullable(blockchain.pending_transactions),
      peerCount: toNullable(network.peer_count),
      chainId: toNullable(network.chain_id),
      syncStatus: toNullable(network.sync_status ?? 'unknown'),
      avgBlockTimeSecs: toNullable(mining.avg_block_time_secs),
      difficulty: toNullable(mining.difficulty),
      weatherStations,
      unavailable,
      source: {
        chain: 'core4 /blockchain, /network/info, /mining/stats',
        weatherStations: weatherStations === null ? null : 'weather_stations WHERE is_active',
      },
      lastUpdate: new Date().toISOString(),
    },
  };
}

module.exports = { buildLiveStats, NO_SOURCE };
