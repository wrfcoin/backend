/**
 * IoTeX W3bstream Adapter
 *
 * This adapter enables secure data collection from IoT devices using the W3bstream protocol.
 * W3bstream serves as a middleware between IoT devices and blockchain, facilitating secure
 * and verifiable data transmission from weather stations and other environmental sensors.
 *
 * backend#1171: this backend has NO W3bstream client. The previous version
 * published to a hard-coded placeholder host with a default API key and
 * answered success with randomly generated transaction ids and block
 * references, so a device integration received a fabricated on-chain receipt.
 * Now every publish path refuses with a coded error and never returns an id,
 * and the /api/iotex/w3bstream/* routes answer the standard not-wired 501 (see
 * requireW3bstreamWired). Configuration is read from the environment with no
 * defaults; wiring additionally needs a real client, which is out of scope.
 */

const { createLogger } = require('../../../utils/logger.js');
const logger = createLogger('iotex:w3bstream');
const { notWiredEnvelope } = require('../../middleware/require-wired-storage');

const W3B_PROJECT_NAME = 'wrfcoin-weather-data';

// Flip only together with a real W3bstream client that publishes and returns
// the network's own transaction ids.
const W3BSTREAM_CLIENT_IMPLEMENTED = false;

// RFC 2606 / RFC 6761 names that can never be a real W3bstream deployment.
const PLACEHOLDER_HOST = /(^|\.)(example\.(com|net|org)|example|invalid|test|localhost)$/i;

function readW3bstreamConfig() {
  const endpoint = (process.env.W3B_ENDPOINT || '').trim();
  const apiKey = (process.env.W3B_API_KEY || '').trim();
  let endpointValid = false;
  if (endpoint) {
    try {
      const url = new URL(endpoint);
      endpointValid = (url.protocol === 'https:' || url.protocol === 'http:')
        && !PLACEHOLDER_HOST.test(url.hostname);
    } catch {
      endpointValid = false;
    }
  }
  return { endpoint, apiKey, endpointValid };
}

/**
 * True when W3B_ENDPOINT (a real, non-placeholder http(s) URL) and
 * W3B_API_KEY are both set.
 */
function isW3bstreamConfigured() {
  const { endpointValid, apiKey } = readW3bstreamConfig();
  return endpointValid && Boolean(apiKey);
}

/** True only when configured AND a real client exists (never, today). */
function isW3bstreamWired() {
  return isW3bstreamConfigured() && W3BSTREAM_CLIENT_IMPLEMENTED;
}

function w3bstreamUnavailable() {
  if (!isW3bstreamConfigured()) {
    return {
      code: 'W3BSTREAM_NOT_CONFIGURED',
      message: 'W3bstream is not configured: W3B_ENDPOINT and W3B_API_KEY must both be set to a real deployment',
    };
  }
  return {
    code: 'W3BSTREAM_CLIENT_NOT_IMPLEMENTED',
    message: 'W3bstream is configured but this backend has no W3bstream client to publish with',
  };
}

function assertW3bstreamWired() {
  if (isW3bstreamWired()) return;
  const { code, message } = w3bstreamUnavailable();
  const error = new Error(message);
  error.code = code;
  throw error;
}

/**
 * Convert weather data to W3bstream format
 * @param {Object} device - The device sending data
 * @param {Object} rawData - Raw weather data from device
 * @returns {Object} Formatted data for W3bstream
 */
function formatWeatherData(device, rawData) {
  return {
    device_id: device.id,
    timestamp: Date.now(),
    type: device.type,
    location: {
      latitude: device.latitude,
      longitude: device.longitude,
      geohash: device.geohash,
    },
    measurements: rawData,
    meta: {
      firmware_version: device.firmwareVersion,
      hardware_id: device.hardwareId,
    },
  };
}

/**
 * Send weather data to W3bstream.
 * Throws W3BSTREAM_NOT_CONFIGURED / W3BSTREAM_CLIENT_NOT_IMPLEMENTED; it never
 * returns a transaction id it did not receive from W3bstream.
 * @param {Object} device - Device object containing ID, type, etc.
 * @param {Object} data - Weather data to send
 * @returns {Promise<Object>} Processing result
 */
async function sendWeatherData(device, data) {
  assertW3bstreamWired();
  // Unreachable until a client exists; kept so the payload shape is defined.
  return { payload: formatWeatherData(device, data) };
}

/**
 * Process an event from a W3bstream publisher.
 * Throws like sendWeatherData; never returns a generated blockchainTx.
 * @param {Object} event - Event object with type, payload, etc.
 * @param {Object} publisher - Publisher that originated the event
 * @returns {Promise<Object>} Processing result
 */
async function processEvent(event, publisher) {
  assertW3bstreamWired();
  return { eventId: event.id, publisherId: publisher.id };
}

/**
 * Get W3bstream project status: what is configured, never invented counts.
 * @returns {Promise<Object>} Project status
 */
async function getProjectStatus() {
  const wired = isW3bstreamWired();
  return {
    status: wired ? 'active' : (isW3bstreamConfigured() ? 'not_implemented' : 'not_configured'),
    configured: isW3bstreamConfigured(),
    wired,
    projectName: W3B_PROJECT_NAME,
  };
}

/**
 * Express guard for /api/iotex/w3bstream/*: the standard not-wired 501 unless
 * W3bstream is configured and a real client exists.
 */
function requireW3bstreamWired(req, res, next) {
  if (isW3bstreamWired()) {
    return next();
  }
  const { code, message } = w3bstreamUnavailable();
  logger.debug('W3bstream route refused: not wired', { code, path: req.originalUrl });
  return res.status(501).json(
    notWiredEnvelope({
      capability: 'iotex.w3bstream',
      message,
      details: `${code}: publisher and event routes stay unavailable until a real W3bstream deployment is configured and a client is implemented.`,
      see: 'wrfcoin/backend#1171',
    }),
  );
}

module.exports = {
  sendWeatherData,
  processEvent,
  getProjectStatus,
  isW3bstreamConfigured,
  isW3bstreamWired,
  requireW3bstreamWired,
};
