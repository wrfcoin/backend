/**
 * Axelar GMP API Client
 *
 * Real HTTP client for the axelarscan.io GMP API.
 * All calls are gated behind the ENABLE_REAL_BRIDGES feature flag.
 *
 * Production exports use the process environment and the real axios, exactly as
 * before. Tests and other isolated consumers build a client with
 * `createAxelarApiClient({ http, config })` and hand it its HTTP surface
 * directly, so they never have to substitute `axios` through Jest's module
 * registry (backend#1017 — see the note in
 * `__tests__/bridge-real-api-clients.test.ts`).
 *
 * Env vars:
 *   AXELAR_API_URL      — base URL (default: https://api.axelarscan.io)
 *   ENABLE_REAL_BRIDGES — set to "true" to activate real calls
 */

const axios = require('axios');
const { crossChainLogger: logger } = require('../utils/logger.js');

const DEFAULT_AXELAR_API_URL = 'https://api.axelarscan.io';

/**
 * Returns the configured Axelar API base URL (no trailing slash).
 *
 * Read from the environment on every call, deliberately: production callers
 * set these after import, and snapshotting them at module scope would make this
 * module's answer depend on WHEN it was loaded — the very coupling #1017 is
 * about.
 *
 * @returns {string}
 */
function getAxelarApiUrl() {
  const raw = process.env.AXELAR_API_URL || DEFAULT_AXELAR_API_URL;
  return raw.replace(/\/$/, '');
}

/**
 * Returns true when real bridge API calls are enabled.
 * @returns {boolean}
 */
function isRealBridgesEnabled() {
  return process.env.ENABLE_REAL_BRIDGES === 'true';
}

/**
 * Normalise Axelar GMP status strings to uppercase constants.
 * @param {string|undefined} status
 * @returns {string}
 */
function normaliseAxelarStatus(status) {
  if (!status) return 'UNKNOWN';
  const s = String(status).toUpperCase();
  const map = {
    CALLED: 'PENDING',
    APPROVED: 'PENDING',
    EXECUTING: 'PENDING',
    EXECUTED: 'EXECUTED',
    CONFIRMED: 'EXECUTED',
    ERROR: 'FAILED',
    FAILED: 'FAILED',
  };
  return map[s] || s;
}

/**
 * @typedef {Object} AxelarHttpClient
 * @property {(url: string, config?: Object) => Promise<{status: number, data: any}>} get
 *   The subset of the Axios surface these integrations use.
 */

/**
 * @typedef {Object} AxelarApiConfig
 * @property {boolean} enabled  — the ENABLE_REAL_BRIDGES decision, already made
 * @property {string}  apiUrl   — base URL, no trailing slash
 */

/**
 * Construct an Axelar API client from explicit dependencies.
 *
 * Config is copied at construction so later mutation by a caller cannot alter
 * an in-flight client's behaviour.
 *
 * @param {{http: AxelarHttpClient, config: AxelarApiConfig}} deps
 */
function createAxelarApiClient({ http, config }) {
  const capturedConfig = Object.freeze({ ...config });
  const baseUrl = String(capturedConfig.apiUrl || DEFAULT_AXELAR_API_URL).replace(/\/$/, '');

  /**
   * Query the status of a GMP message by source transaction hash.
   *
   * When the client is not enabled, returns null so callers can fall back to
   * stub behavior.
   *
   * @param {string} txHash — source-chain transaction hash
   * @returns {Promise<Object|null>}
   */
  async function queryGMPStatus(txHash) {
    if (!capturedConfig.enabled) {
      logger.debug('[Axelar API] Real bridges disabled — skipping GMP status query');
      return null;
    }

    const url = `${baseUrl}/gmp/searchGMP?txHash=${encodeURIComponent(txHash)}`;
    logger.info(`[Axelar API] Querying GMP status: ${url}`);

    const response = await http.get(url, { timeout: 15000 });

    if (response.status !== 200) {
      throw new Error(`Axelar GMP status query failed with HTTP ${response.status}`);
    }

    const data = response.data;

    // The API returns { data: [...] } or similar; normalise to a single record.
    const records = Array.isArray(data.data) ? data.data : (Array.isArray(data) ? data : []);
    if (records.length === 0) {
      logger.warn(`[Axelar API] No GMP records found for txHash ${txHash}`);
      return null;
    }

    const record = records[0];
    return {
      id: record.id || txHash,
      txHash: record.call?.transactionHash || txHash,
      status: normaliseAxelarStatus(record.status),
      sourceChain: record.call?.chain || null,
      destinationChain: record.call?.returnValues?.destinationChain || null,
      sender: record.call?.returnValues?.sender || null,
      recipient: record.call?.returnValues?.destinationContractAddress || null,
      asset: record.call?.returnValues?.symbol || null,
      amount: record.call?.returnValues?.amount || null,
      createdAt: record.call?.blockTimestamp
        ? new Date(record.call.blockTimestamp * 1000).toISOString()
        : null,
      executedAt: record.executed?.blockTimestamp
        ? new Date(record.executed.blockTimestamp * 1000).toISOString()
        : null,
      sourceTransactionHash: record.call?.transactionHash || txHash,
      destinationTransactionHash: record.executed?.transactionHash || null,
      gasUsed: record.gas_paid?.returnValues?.gasFeeAmount
        ? parseInt(record.gas_paid.returnValues.gasFeeAmount, 10)
        : null,
      error: record.error ? String(record.error) : null,
      raw: record,
    };
  }

  /**
   * Estimate bridge fees for a cross-chain token transfer.
   *
   * When the client is not enabled, returns null so callers can fall back to
   * stub behavior.
   *
   * @param {string} sourceChain
   * @param {string} destChain
   * @param {string} symbol   — token symbol (e.g. "axlUSDC")
   * @param {string|number} amount — token amount
   * @returns {Promise<Object|null>}
   */
  async function estimateFees(sourceChain, destChain, symbol, amount) {
    if (!capturedConfig.enabled) {
      logger.debug('[Axelar API] Real bridges disabled — skipping fee estimation');
      return null;
    }

    const params = new URLSearchParams({
      sourceChain,
      destinationChain: destChain,
      symbol,
      amount: String(amount),
    });
    const url = `${baseUrl}/gmp/getFees?${params.toString()}`;
    logger.info(`[Axelar API] Estimating fees: ${url}`);

    const response = await http.get(url, { timeout: 15000 });

    if (response.status !== 200) {
      throw new Error(`Axelar fee estimation failed with HTTP ${response.status}`);
    }

    const data = response.data;

    return {
      sourceChain,
      destinationChain: destChain,
      symbol,
      amount: String(amount),
      baseFee: data.base_fee ?? data.baseFee ?? null,
      executionFee: data.execution_fee ?? data.executionFee ?? null,
      expressFee: data.express_fee ?? data.expressFee ?? null,
      totalFee: data.total_fee ?? data.totalFee ?? null,
      feeToken: data.fee_token ?? data.feeToken ?? symbol,
      timestamp: new Date().toISOString(),
      raw: data,
    };
  }

  return {
    queryGMPStatus,
    estimateFees,
    getAxelarApiUrl: () => baseUrl,
    isRealBridgesEnabled: () => capturedConfig.enabled,
    normaliseAxelarStatus,
  };
}

/** The real Axios surface, narrowed to what this module uses. */
const productionHttp = {
  get: (url, config) => axios.get(url, config),
};

/**
 * A client configured from the environment AS IT IS RIGHT NOW.
 *
 * Built per call rather than once at import: `ENABLE_REAL_BRIDGES` and
 * `AXELAR_API_URL` are read when the call happens, which is the behaviour every
 * existing caller already depends on. Constructing the client is a closure and
 * a frozen two-field object, so the cost is not worth trading that away for.
 */
function productionClient() {
  return createAxelarApiClient({
    http: productionHttp,
    config: { enabled: isRealBridgesEnabled(), apiUrl: getAxelarApiUrl() },
  });
}

// Compatibility exports: existing production callers retain the same API.
async function queryGMPStatus(txHash) {
  return productionClient().queryGMPStatus(txHash);
}

async function estimateFees(sourceChain, destChain, symbol, amount) {
  return productionClient().estimateFees(sourceChain, destChain, symbol, amount);
}

module.exports = {
  createAxelarApiClient,
  queryGMPStatus,
  estimateFees,
  isRealBridgesEnabled,
  getAxelarApiUrl,
  normaliseAxelarStatus,
};
