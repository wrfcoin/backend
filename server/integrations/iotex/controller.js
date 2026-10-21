/**
 * IoTeX Integration Controller
 *
 * This file provides functionality for the IoTeX integration:
 * - W3bstream adapter for secure data collection from IoT devices
 * - Device attestation module for weather station verification
 * - Cross-chain functionality with the IoTeX network
 */

const { createLogger } = require('../../../utils/logger.js');
const logger = createLogger('iotex:controller');
const w3bstreamAdapter = require('./w3bstream-adapter');
const deviceAttestation = require('./device-attestation');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

// backend#1241: a real geohash, from the same encoder the geo-fence grid uses. This used to
// store a sha256 hex prefix under the name "geohash", which no consumer could decode.
// Invalid or out-of-range coordinates yield null, never a made-up value.
async function calculateGeohash(latitude, longitude, precision = 9) {
  try {
    const lat = Number(latitude);
    const lon = Number(longitude);
    if (
      latitude === null || latitude === undefined || longitude === null || longitude === undefined ||
      !Number.isFinite(lat) || !Number.isFinite(lon) ||
      lat < -90 || lat > 90 || lon < -180 || lon > 180 ||
      !Number.isInteger(precision) || precision < 1 || precision > 12
    ) {
      return null;
    }
    const { encodeGeoFenceGrid } = await import('../../../shared/iot-gateway-geofence-service.js');
    return encodeGeoFenceGrid({ lat, lon }, precision);
  } catch (error) {
    logger.error(`Error calculating geohash: ${error.message}`, {
      error: error.toString(),
    });
    return null;
  }
}

// Generate attestation challenge for a device
async function generateAttestation(deviceId) {
  try {
    return await deviceAttestation.generateChallenge(deviceId);
  } catch (error) {
    logger.error(`Error generating attestation challenge: ${error.message}`, {
      error: error.toString(),
    });
    throw error;
  }
}

// Verify attestation response
async function verifyAttestation(challenge, response, device) {
  try {
    return await deviceAttestation.verifyResponse(challenge, response, device);
  } catch (error) {
    logger.error(`Error verifying attestation: ${error.message}`, {
      error: error.toString(),
    });
    return { success: false, message: error.message };
  }
}

// Verify cryptographic signature
async function verifySignature(data, signature, publicKey) {
  try {
    return await deviceAttestation.verifySignature(data, signature, publicKey);
  } catch (error) {
    logger.error(`Error verifying signature: ${error.message}`, {
      error: error.toString(),
    });
    return false;
  }
}

// Verify a signed device or publisher submission (real ed25519, domain + chain +
// timestamp window + nonce); returns { ok, reason? } and never throws.
async function verifySignedSubmission(submission, options) {
  try {
    return await deviceAttestation.verifySignedSubmission(submission, options);
  } catch (error) {
    logger.error(`Error verifying signed submission: ${error.message}`, {
      error: error.toString(),
    });
    return { ok: false, reason: 'VERIFY_ERROR' };
  }
}

async function normalizePublicKey(value) {
  try {
    return await deviceAttestation.normalizePublicKey(value);
  } catch {
    return null;
  }
}

// Process weather data through W3bstream
async function processWeatherData(device, data) {
  // backend#1171: no W3bstream client exists. The data is already stored;
  // there is nothing to publish and no transaction id to record.
  if (!w3bstreamAdapter.isW3bstreamWired()) {
    logger.debug(`W3bstream not wired; skipping publish for device ${device.id}`);
    return null;
  }
  try {
    logger.info(`Processing weather data from device ${device.id}`, {
      deviceType: device.type,
    });

    // Send data to W3bstream
    const result = await w3bstreamAdapter.sendWeatherData(device, data);

    // Log result
    if (result.success) {
      logger.info(
        `Weather data processed successfully for device ${device.id}`,
        {
          transactionId: result.transactionId,
          blockchainReference: result.blockchainReference,
        }
      );
    } else {
      logger.warn(
        `Weather data processing incomplete for device ${device.id}`,
        {
          error: result.message,
        }
      );
    }

    return result;
  } catch (error) {
    logger.error(`Error processing weather data: ${error.message}`, {
      error: error.toString(),
      deviceId: device.id,
    });
    throw error;
  }
}

// Process W3bstream event
async function processW3bstreamEvent(event, publisher) {
  try {
    logger.info(
      `Processing W3bstream event ${event.id} from publisher ${publisher.id}`,
      {
        eventType: event.eventType,
      }
    );

    // Process event through W3bstream
    const result = await w3bstreamAdapter.processEvent(event, publisher);

    if (result.success) {
      logger.info('W3bstream event processed successfully', {
        eventId: event.id,
        blockchainTx: result.blockchainTx,
      });
    } else {
      logger.warn('W3bstream event processing incomplete', {
        eventId: event.id,
        error: result.message,
      });
    }

    return result;
  } catch (error) {
    logger.error(`Error processing W3bstream event: ${error.message}`, {
      error: error.toString(),
      eventId: event.id,
      publisherId: publisher.id,
    });
    return { success: false, message: error.message };
  }
}

// Get IoTeX network status
async function getNetworkStatus() {
  try {
    // This would connect to the actual IoTeX network in production
    return {
      blockHeight: 15487935,
      epoch: 31452,
      tps: 42.8,
      peers: 112,
      status: 'healthy',
    };
  } catch (error) {
    logger.error(`Error getting IoTeX network status: ${error.message}`, {
      error: error.toString(),
    });
    throw error;
  }
}

// Export controller functions
module.exports = {
  calculateGeohash,
  generateAttestation,
  verifyAttestation,
  verifySignature,
  verifySignedSubmission,
  normalizePublicKey,
  processWeatherData,
  processW3bstreamEvent,
  getNetworkStatus,
};
