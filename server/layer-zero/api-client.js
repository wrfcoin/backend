/**
 * LayerZero Scan API Client
 *
 * Real HTTP client for the layerzero-scan API.
 * All calls are gated behind the ENABLE_REAL_BRIDGES feature flag.
 *
 * Production exports use the process environment and the real axios, exactly as
 * before. Tests and other isolated consumers build a client with
 * `createLayerZeroApiClient({ http, config })` and hand it its HTTP surface
 * directly, so they never have to substitute `axios` through Jest's module
 * registry (backend#1017 — see the note in
 * `__tests__/bridge-real-api-clients.test.ts`).
 *
 * Env vars:
 *   LAYERZERO_ENDPOINT_URL — base URL (default: https://api-mainnet.layerzero-scan.com)
 *   ENABLE_REAL_BRIDGES    — set to "true" to activate real calls
 */

const axios = require('axios');
const { crossChainLogger: logger } = require('../utils/logger.js');

const DEFAULT_LZ_ENDPOINT_URL = 'https://api-mainnet.layerzero-scan.com';

/**
 * Returns the configured LayerZero scan base URL (no trailing slash).
 *
 * Read from the environment on every call, deliberately: production callers set
 * these after import, and snapshotting them at module scope would make this
 * module's answer depend on WHEN it was loaded — the very coupling #1017 is
 * about.
 *
 * @returns {string}
 */
function getLayerZeroEndpointUrl() {
  const raw = process.env.LAYERZERO_ENDPOINT_URL || DEFAULT_LZ_ENDPOINT_URL;
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
 * Normalise LayerZero scan status strings to uppercase constants.
 * @param {string|undefined} status
 * @returns {string}
 */
function normaliseLayerZeroStatus(status) {
  if (!status) return 'UNKNOWN';
  const s = String(status).toUpperCase();
  const map = {
    DELIVERED: 'DELIVERED',
    INFLIGHT: 'PENDING',
    PENDING: 'PENDING',
    FAILED: 'FAILED',
    BLOCKED: 'FAILED',
  };
  return map[s] || s;
}

/**
 * @typedef {Object} LayerZeroHttpClient
 * @property {(url: string, config?: Object) => Promise<{status: number, data: any}>} get
 *   The subset of the Axios surface these integrations use.
 */

/**
 * @typedef {Object} LayerZeroApiConfig
 * @property {boolean} enabled     — the ENABLE_REAL_BRIDGES decision, already made
 * @property {string}  endpointUrl — base URL, no trailing slash
 */

/**
 * Construct a LayerZero scan client from explicit dependencies.
 *
 * Config is copied at construction so later mutation by a caller cannot alter
 * an in-flight client's behaviour.
 *
 * @param {{http: LayerZeroHttpClient, config: LayerZeroApiConfig}} deps
 */
function createLayerZeroApiClient({ http, config }) {
  const capturedConfig = Object.freeze({ ...config });
  const baseUrl = String(capturedConfig.endpointUrl || DEFAULT_LZ_ENDPOINT_URL).replace(/\/$/, '');

  /**
   * Track a LayerZero message by source-chain transaction hash.
   *
   * Calls GET <endpoint>/tx/<txHash> which returns delivery status from the
   * LayerZero scan API. When the client is not enabled, returns null so callers
   * can fall back to stub behavior.
   *
   * @param {string} txHash — source-chain transaction hash
   * @returns {Promise<Object|null>}
   */
  async function trackMessage(txHash) {
    if (!capturedConfig.enabled) {
      logger.debug('[LayerZero API] Real bridges disabled — skipping message tracking');
      return null;
    }

    const url = `${baseUrl}/tx/${encodeURIComponent(txHash)}`;
    logger.info(`[LayerZero API] Tracking message: ${url}`);

    const response = await http.get(url, { timeout: 15000 });

    if (response.status !== 200) {
      throw new Error(`LayerZero scan query failed with HTTP ${response.status}`);
    }

    const data = response.data;

    // The API returns a messages array or a single object; normalise.
    const messages = Array.isArray(data.messages)
      ? data.messages
      : Array.isArray(data)
        ? data
        : data
          ? [data]
          : [];

    if (messages.length === 0) {
      logger.warn(`[LayerZero API] No message records found for txHash ${txHash}`);
      return null;
    }

    const msg = messages[0];
    return {
      txHash,
      messageId: msg.id || msg.nonce || txHash,
      status: normaliseLayerZeroStatus(msg.status),
      sourceChainId: msg.srcChainId ?? msg.srcUaAddress?.chainId ?? null,
      destinationChainId: msg.dstChainId ?? msg.dstUaAddress?.chainId ?? null,
      srcUaAddress: msg.srcUaAddress?.address ?? null,
      dstUaAddress: msg.dstUaAddress?.address ?? null,
      srcBlockHash: msg.srcBlockHash ?? null,
      dstTxHash: msg.dstTxHash ?? null,
      created: msg.created ?? null,
      updated: msg.updated ?? null,
      deliveredAt: msg.status === 'DELIVERED' && msg.updated ? msg.updated : null,
      errorMessage: msg.errorMessage ?? null,
      raw: msg,
    };
  }

  /**
   * Quote fees for a LayerZero cross-chain send by fetching tx tracking info.
   *
   * NOTE: LayerZero V2 on-chain fee quotes require contract calls. This function
   * uses the scan API to look up an existing tx to surface gas/fee data when the
   * client is enabled. When it is not, it returns null.
   *
   * @param {string} txHash — a reference source-tx hash to pull fee data from
   * @returns {Promise<Object|null>}
   */
  async function quoteFeeFromTx(txHash) {
    if (!capturedConfig.enabled) {
      logger.debug('[LayerZero API] Real bridges disabled — skipping fee quote');
      return null;
    }

    const tracked = await trackMessage(txHash);
    if (!tracked) {
      return null;
    }

    return {
      txHash,
      sourceChainId: tracked.sourceChainId,
      destinationChainId: tracked.destinationChainId,
      nativeFee: tracked.raw?.nativeFee ?? null,
      lzTokenFee: tracked.raw?.lzTokenFee ?? null,
      timestamp: new Date().toISOString(),
      raw: tracked.raw,
    };
  }

  return {
    trackMessage,
    quoteFeeFromTx,
    getLayerZeroEndpointUrl: () => baseUrl,
    isRealBridgesEnabled: () => capturedConfig.enabled,
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
 * `LAYERZERO_ENDPOINT_URL` are read when the call happens, which is the
 * behaviour every existing caller already depends on.
 */
function productionClient() {
  return createLayerZeroApiClient({
    http: productionHttp,
    config: { enabled: isRealBridgesEnabled(), endpointUrl: getLayerZeroEndpointUrl() },
  });
}

// Compatibility exports: existing production callers retain the same API.
async function trackMessage(txHash) {
  return productionClient().trackMessage(txHash);
}

async function quoteFeeFromTx(txHash) {
  return productionClient().quoteFeeFromTx(txHash);
}

module.exports = {
  createLayerZeroApiClient,
  trackMessage,
  quoteFeeFromTx,
  isRealBridgesEnabled,
  getLayerZeroEndpointUrl,
};
