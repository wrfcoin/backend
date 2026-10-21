/**
 * IoTeX Integration Routes
 *
 * This file defines API routes for the IoTeX integration with W3bstream
 * and device attestation for weather stations and environmental sensors.
 */

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { randomBytes } = require('crypto');
const { createLogger } = require('../../utils/logger.js');
const logger = createLogger('iotex:routes');
const controller = require('../integrations/iotex/controller');
const { db } = require('../db');
const {
  devices,
  deviceData,
  attestationRequests,
  w3bstreamPublishers,
  w3bstreamEvents,
} = require('../../shared/schema-iotex');
const { and, eq, desc, count } = require('drizzle-orm');
const { parseListPagination, paginatedResponse } = require('../utils/api-error');
const { hasOperatorToken } = require('../middleware/operator-token-auth');
const {
  IotGatewayGeoFenceService,
  buildGeoFenceReviewUpdate,
  isRewardEligibleForGeoFence,
} = require('../../shared/iot-gateway-geofence-service');

const geoFenceService = new IotGatewayGeoFenceService(db);
const IOT_GATEWAY_ADMIN_TOKEN = process.env.IOT_GATEWAY_ADMIN_TOKEN || '';

function requireIotGatewayAdmin(req, res) {
  const adminToken = req.get('x-iot-gateway-admin-token');
  if (!IOT_GATEWAY_ADMIN_TOKEN || adminToken !== IOT_GATEWAY_ADMIN_TOKEN) {
    res.status(403).json({
      success: false,
      message: 'Admin authorization required',
      code: 'ADMIN_AUTH_REQUIRED',
    });
    return false;
  }
  return true;
}

// backend#1220: this router is unauthenticated for reads. Operators (the
// WRFCOIN_OPERATOR_TOKEN bearer) and the IoT gateway admin see full device
// rows; everyone else gets a non-identifying projection.
function isPrivilegedIotRequest(req) {
  if (hasOperatorToken(req)) {
    return true;
  }
  const adminToken = req.get('x-iot-gateway-admin-token');
  return Boolean(IOT_GATEWAY_ADMIN_TOKEN) && adminToken === IOT_GATEWAY_ADMIN_TOKEN;
}

function requirePrivilegedIot(req, res) {
  if (isPrivilegedIotRequest(req)) {
    return true;
  }
  res.status(401).json({
    success: false,
    message: 'Operator or IoT gateway admin authorization required',
    code: 'OPERATOR_AUTH_REQUIRED',
  });
  return false;
}

// Server-side coarsening to 0.1 deg (~11 km), the shared anonymous projection.
// Client-side rounding is not a boundary, so exact coordinates never leave this
// process for anonymous reads.
const { coarsenCoordinate, coarsenCoordinatesInName } = require('../utils/anonymous-projection');
const { toStorageGrid } = require('../utils/coordinate-grid');

// Allowlist, not a denylist: owner, publicKey, hardwareId, firmwareVersion,
// geohash, geo-fence review state and metadata are all omitted, and any
// column added to the table later stays private until listed here.
function toAnonymousDevice(device) {
  return {
    id: device.id,
    // backend#1397: an owner-entered name's coordinate-like numbers at 0.1 deg.
    name: coarsenCoordinatesInName(device.name),
    type: device.type,
    attestationStatus: device.attestationStatus,
    attestationType: device.attestationType,
    lastSeen: device.lastSeen,
    latitude: coarsenCoordinate(device.latitude),
    longitude: coarsenCoordinate(device.longitude),
    createdAt: device.createdAt,
    updatedAt: device.updatedAt,
  };
}

function projectDevice(req, device) {
  return isPrivilegedIotRequest(req) ? device : toAnonymousDevice(device);
}

// W21 (owner ruling 2026-10-01): a device position is validated as sent, then
// only its 0.1 degree grid point is stored, hashed or given to the geo-fence.
// Absent -> { value: null }; not a number or out of range -> { invalid: true }.
function parseCoordinate(value, limit) {
  if (value === undefined || value === null || value === '') {
    return { value: null };
  }
  if (typeof value !== 'number' && typeof value !== 'string') {
    return { invalid: true };
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || Math.abs(parsed) > limit) {
    return { invalid: true };
  }
  return { value: toStorageGrid(parsed) };
}

const INVALID_COORDINATES = {
  success: false,
  message: 'latitude must be a number in [-90, 90] and longitude a number in [-180, 180]',
  code: 'INVALID_COORDINATES',
};

// backend#1397: a privileged IoT caller (operator bearer or gateway admin
// token) gets full device rows here (#1220), exact positions included. The
// global anonymous-coordinate guard only knows the operator token, so mark the
// request for it; the flag is set on /api/iotex only and grants nothing
// elsewhere.
router.use((req, _res, next) => {
  if (isPrivilegedIotRequest(req)) {
    req.exactCoordinatesAuthorized = true;
  }
  next();
});

// Get all registered devices
router.get('/devices', async (req, res) => {
  try {
    const { limit, offset, page } = parseListPagination(req.query, {
      defaultLimit: 50,
      maxLimit: 200,
    });
    const [countRow] = await db.select({ total: count() }).from(devices);
    const allDevices = await db
      .select()
      .from(devices)
      .orderBy(desc(devices.createdAt), desc(devices.id))
      .limit(limit)
      .offset(offset);

    return res.json(
      paginatedResponse(
        allDevices.map(device => projectDevice(req, device)),
        Number(countRow?.total ?? 0),
        page,
        limit
      )
    );
  } catch (error) {
    logger.error(`Error fetching devices: ${error.message}`, {
      error: error.toString(),
    });
    return res.status(500).json({
      success: false,
      message: 'Error fetching devices',
    });
  }
});

// Get a specific device by ID
router.get('/devices/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [device] = await db.select().from(devices).where(eq(devices.id, id));

    if (!device) {
      return res.status(404).json({
        success: false,
        message: `Device with ID ${id} not found`,
      });
    }

    return res.json({
      success: true,
      device: projectDevice(req, device),
    });
  } catch (error) {
    logger.error(`Error fetching device: ${error.message}`, {
      error: error.toString(),
    });
    return res.status(500).json({
      success: false,
      message: 'Error fetching device',
    });
  }
});

// Register a new device
router.post('/devices', async (req, res) => {
  // backend#1398: creating a device (and its attestation request) is
  // operator/IoT-admin only, like every other device-mutating route. Owner
  // self-registration with a device signature is a future owner decision.
  if (!requirePrivilegedIot(req, res)) {
    return;
  }
  try {
    const {
      name,
      type,
      latitude,
      longitude,
      owner,
      publicKey,
      firmwareVersion,
      hardwareId,
      metadata,
    } = req.body;

    // Validate required fields
    if (!name || !type) {
      return res.status(400).json({
        success: false,
        message: 'Device name and type are required',
      });
    }

    const lat = parseCoordinate(latitude, 90);
    const lon = parseCoordinate(longitude, 180);
    if (lat.invalid || lon.invalid) {
      return res.status(400).json(INVALID_COORDINATES);
    }
    const parsedLatitude = lat.value;
    const parsedLongitude = lon.value;

    // backend#1240: a device key is a 32-byte ed25519 key (64 hex). Validated and
    // stored normalized so the verifier and the column agree on one format.
    let normalizedPublicKey = null;
    if (publicKey !== undefined && publicKey !== null && publicKey !== '') {
      normalizedPublicKey = await controller.normalizePublicKey(publicKey);
      if (!normalizedPublicKey) {
        return res.status(400).json({
          success: false,
          message: 'publicKey must be a 32-byte ed25519 public key as 64 hex characters',
          code: 'INVALID_PUBLIC_KEY',
        });
      }
    }

    // Generate device ID
    const deviceId = `device-${randomBytes(4).toString('hex')}`;

    // Calculate geohash if lat/long are provided
    let geohash = null;
    if (parsedLatitude !== null && parsedLongitude !== null) {
      geohash = await controller.calculateGeohash(parsedLatitude, parsedLongitude);
    }

    const geoFenceDecision = await geoFenceService.evaluateNewIdentity({
      integrationType: 'iotex',
      subjectId: deviceId,
      location:
        parsedLatitude !== null && parsedLongitude !== null
          ? { lat: parsedLatitude, lon: parsedLongitude }
          : null,
    });
    const geoFenceReview = buildGeoFenceReviewUpdate(geoFenceDecision);

    // Create the device
    const [newDevice] = await db
      .insert(devices)
      .values({
        id: deviceId,
        name,
        type,
        attestationStatus: 'PENDING',
        latitude: parsedLatitude,
        longitude: parsedLongitude,
        geohash,
        ...geoFenceReview,
        metadata,
        owner,
        publicKey: normalizedPublicKey,
        firmwareVersion,
        hardwareId,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

    // Create initial attestation request for device
    if (newDevice) {
      const challenge = await controller.generateAttestation(deviceId);

      await db.insert(attestationRequests).values({
        id: uuidv4(),
        deviceId: deviceId,
        attestationType: 'IOTEX_SOVEREIGN',
        status: 'PENDING',
        challenge,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // Expires in 24 hours
        createdAt: new Date(),
      });
    }

    return res.status(201).json({
      success: true,
      // backend#1397 r6: the creator gets the same projection as any reader
      // (an anonymous caller: name and position at 0.1 deg, no private columns).
      device: {
        ...projectDevice(req, newDevice),
        manualAttestationRequired: newDevice.geoFenceStatus === 'manual_review_required',
      },
      message: 'Device registered successfully',
    });
  } catch (error) {
    logger.error(`Error registering device: ${error.message}`, {
      error: error.toString(),
    });
    return res.status(500).json({
      success: false,
      message: 'Error registering device',
    });
  }
});

// Update device information
router.put('/devices/:id', async (req, res) => {
  // backend#1220: raw readings, attestation challenges, publisher keys and
  // attestation/location writes are operator/IoT-admin only.
  if (!requirePrivilegedIot(req, res)) {
    return;
  }
  try {
    const { id } = req.params;
    const {
      name,
      attestationStatus,
      latitude,
      longitude,
      metadata,
      firmwareVersion,
    } = req.body;
    const lat = parseCoordinate(latitude, 90);
    const lon = parseCoordinate(longitude, 180);
    if (lat.invalid || lon.invalid) {
      return res.status(400).json(INVALID_COORDINATES);
    }
    const parsedLatitude = lat.value;
    const parsedLongitude = lon.value;

    // Check if device exists
    const [existingDevice] = await db
      .select()
      .from(devices)
      .where(eq(devices.id, id));

    if (!existingDevice) {
      return res.status(404).json({
        success: false,
        message: `Device with ID ${id} not found`,
      });
    }

    // Update the device
    const updateValues = {
      updatedAt: new Date(),
    };

    if (name) updateValues.name = name;
    if (attestationStatus) updateValues.attestationStatus = attestationStatus;
    if (parsedLatitude !== null) updateValues.latitude = parsedLatitude;
    if (parsedLongitude !== null) updateValues.longitude = parsedLongitude;
    if (metadata) updateValues.metadata = metadata;
    if (firmwareVersion) updateValues.firmwareVersion = firmwareVersion;

    // Calculate new geohash if lat/long were updated
    if (parsedLatitude !== null && parsedLongitude !== null) {
      updateValues.geohash = await controller.calculateGeohash(
        parsedLatitude,
        parsedLongitude
      );
    }

    const [updatedDevice] = await db
      .update(devices)
      .set(updateValues)
      .where(eq(devices.id, id))
      .returning();

    return res.json({
      success: true,
      device: updatedDevice,
      message: 'Device updated successfully',
    });
  } catch (error) {
    logger.error(`Error updating device: ${error.message}`, {
      error: error.toString(),
    });
    return res.status(500).json({
      success: false,
      message: 'Error updating device',
    });
  }
});

// Get device data by device ID
router.get('/devices/:id/data', async (req, res) => {
  // backend#1220: raw readings, attestation challenges, publisher keys and
  // attestation/location writes are operator/IoT-admin only.
  if (!requirePrivilegedIot(req, res)) {
    return;
  }
  try {
    const { id } = req.params;
    const { limit, offset, page } = parseListPagination(req.query, {
      defaultLimit: 50,
      maxLimit: 200,
    });

    // Check if device exists
    const [device] = await db.select().from(devices).where(eq(devices.id, id));

    if (!device) {
      return res.status(404).json({
        success: false,
        message: `Device with ID ${id} not found`,
      });
    }

    // Get device data entries
    const data = await db
      .select()
      .from(deviceData)
      .where(eq(deviceData.deviceId, id))
      .orderBy(deviceData.timestamp, deviceData.id)
      .limit(limit)
      .offset(offset);

    const [countRow] = await db
      .select({ total: count() })
      .from(deviceData)
      .where(eq(deviceData.deviceId, id));

    return res.json(
      paginatedResponse(
        data,
        Number(countRow?.total ?? 0),
        page,
        limit
      )
    );
  } catch (error) {
    logger.error(`Error fetching device data: ${error.message}`, {
      error: error.toString(),
    });
    return res.status(500).json({
      success: false,
      message: 'Error fetching device data',
    });
  }
});

// Submit data from a device
//
// Two ways in (backend#1240): the operator bearer / IoT gateway admin (unchanged),
// or the device itself with a valid ed25519 signature over the canonical
// `device_data` message (device-attestation.js header): { data, timestamp (unix
// seconds), nonce, signature }. A signature is single use per device: a replay of
// the same signature is refused (durably, against the stored rows), and a stale or
// future timestamp is refused. Anything else is 401 with no write or processing.
const inFlightDeviceSignatures = new Set();

// Payload keys that JSON.parse can produce as OWN members but that plain-object
// canonicalization would drop or alias (see device-attestation.js hasReservedKey).
const RESERVED_PAYLOAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function hasReservedPayloadKey(value, depth = 0) {
  if (depth > 64) return true;
  if (Array.isArray(value)) return value.some((item) => hasReservedPayloadKey(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.keys(value).some((key) => RESERVED_PAYLOAD_KEYS.has(key) || hasReservedPayloadKey(value[key], depth + 1));
  }
  return false;
}

router.post('/devices/:id/data', async (req, res) => {
  const privileged = isPrivilegedIotRequest(req);
  const { id } = req.params;
  const { data, timestamp, signature, nonce } = req.body || {};
  const refuse = (status, code, message) =>
    res.status(status).json({ success: false, message, code });
  if (hasReservedPayloadKey(data)) {
    return refuse(400, 'RESERVED_PAYLOAD_KEY', 'Payload contains a reserved key');
  }
  let inFlightKey = null;
  let normalizedSignature = null;
  try {
    // Check if device exists
    const [device] = await db.select().from(devices).where(eq(devices.id, id));

    if (!device) {
      // Unauthenticated callers learn nothing about which ids exist.
      return privileged
        ? res.status(404).json({ success: false, message: `Device with ID ${id} not found` })
        : refuse(401, 'DEVICE_SIGNATURE_REQUIRED', 'A valid device signature or operator authorization is required');
    }

    // Real verification (also annotates the stored row for privileged writes).
    let verification = { ok: false, reason: 'NO_SIGNATURE' };
    if (signature && device.publicKey) {
      verification = await controller.verifySignedSubmission({
        kind: 'deviceData',
        subjectId: id,
        timestamp,
        nonce,
        payload: data,
        signature,
        publicKey: device.publicKey,
      });
    }
    let verified = verification.ok;

    if (verified) {
      // Single-use signature per device: durable check against stored rows plus an
      // in-process guard for concurrent duplicates.
      // Hex is case-insensitive: key and store the normalized form so an upper-case
      // copy of a used signature cannot slip past the replay check.
      normalizedSignature = String(signature).trim().replace(/^0x/i, '').toLowerCase();
      inFlightKey = `${id}:${normalizedSignature}`;
      const [seen] = await db
        .select()
        .from(deviceData)
        .where(and(eq(deviceData.deviceId, id), eq(deviceData.signature, normalizedSignature)));
      if (seen || inFlightDeviceSignatures.has(inFlightKey)) {
        verified = false;
        verification = { ok: false, reason: 'REPLAY' };
        inFlightKey = null;
      } else {
        inFlightDeviceSignatures.add(inFlightKey);
      }
    }

    if (!privileged && !verified) {
      return refuse(401, 'DEVICE_SIGNATURE_REQUIRED', 'A valid device signature or operator authorization is required');
    }
    if (data === undefined || data === null) {
      return res.status(400).json({ success: false, message: 'data is required' });
    }

    // Create data entry
    const [newDataEntry] = await db
      .insert(deviceData)
      .values({
        id: uuidv4(),
        deviceId: id,
        data,
        // A verified submission carries its signed timestamp; an operator write keeps
        // the previous behaviour.
        timestamp: verified && verification.timestampSeconds
          ? new Date(verification.timestampSeconds * 1000)
          : timestamp ? new Date(timestamp) : new Date(),
        verified,
        signature: verified ? normalizedSignature : signature,
        createdAt: new Date(),
      })
      .returning();

    // Process data through W3bstream if it's a weather station
    if (
      isRewardEligibleForGeoFence(device.geoFenceStatus) &&
      (device.type === 'WEATHER_STATION' ||
        device.type === 'AIR_QUALITY_MONITOR')
    ) {
      try {
        const result = await controller.processWeatherData(device, data);

        if (result && result.transactionId) {
          // Update data entry with blockchain reference
          await db
            .update(deviceData)
            .set({
              blockchainReference: result.blockchainReference,
              transactionId: result.transactionId,
            })
            .where(eq(deviceData.id, newDataEntry.id));

          newDataEntry.blockchainReference = result.blockchainReference;
          newDataEntry.transactionId = result.transactionId;
        }
      } catch (processingError) {
        logger.error(
          `Error processing weather data: ${processingError.message}`,
          {
            error: processingError.toString(),
            deviceId: id,
          }
        );
        // We continue even if processing fails - the data is still stored
      }
    }

    return res.status(201).json({
      success: true,
      dataEntry: newDataEntry,
      manualAttestationRequired: !isRewardEligibleForGeoFence(device.geoFenceStatus),
      message: 'Data submitted successfully',
    });
  } catch (error) {
    logger.error(`Error submitting device data: ${error.message}`, {
      error: error.toString(),
    });
    return res.status(500).json({
      success: false,
      message: 'Error submitting device data',
    });
  } finally {
    if (inFlightKey) inFlightDeviceSignatures.delete(inFlightKey);
  }
});

router.post('/devices/:id/geo-fence-review', async (req, res) => {
  try {
    if (!requireIotGatewayAdmin(req, res)) {
      return;
    }

    const { id } = req.params;
    const { decision, reason } = req.body || {};

    if (decision !== 'approve' && decision !== 'reject') {
      return res.status(400).json({
        success: false,
        message: 'decision must be "approve" or "reject"',
      });
    }

    const [updatedDevice] = await db
      .update(devices)
      .set({
        geoFenceStatus: decision === 'approve' ? 'approved' : 'rejected',
        geoFenceReason: reason || null,
        geoFenceReviewedAt: new Date(),
        geoFenceReviewedBy: 'iot-gateway-admin',
        updatedAt: new Date(),
      })
      .where(eq(devices.id, id))
      .returning();

    if (!updatedDevice) {
      return res.status(404).json({
        success: false,
        message: `Device with ID ${id} not found`,
      });
    }

    return res.json({
      success: true,
      device: updatedDevice,
      message: 'Geo-fence review recorded successfully',
    });
  } catch (error) {
    logger.error(`Error reviewing geo-fence hold: ${error.message}`, {
      error: error.toString(),
    });
    return res.status(500).json({
      success: false,
      message: 'Error reviewing geo-fence hold',
    });
  }
});

// Get attestation requests for a device
router.get('/devices/:id/attestations', async (req, res) => {
  // backend#1220: raw readings, attestation challenges, publisher keys and
  // attestation/location writes are operator/IoT-admin only.
  if (!requirePrivilegedIot(req, res)) {
    return;
  }
  try {
    const { id } = req.params;

    // Check if device exists
    const [device] = await db.select().from(devices).where(eq(devices.id, id));

    if (!device) {
      return res.status(404).json({
        success: false,
        message: `Device with ID ${id} not found`,
      });
    }

    // Get attestation requests
    const requests = await db
      .select()
      .from(attestationRequests)
      .where(eq(attestationRequests.deviceId, id))
      .orderBy(attestationRequests.createdAt);

    return res.json({
      success: true,
      deviceId: id,
      attestationRequests: requests,
    });
  } catch (error) {
    logger.error(`Error fetching attestation requests: ${error.message}`, {
      error: error.toString(),
    });
    return res.status(500).json({
      success: false,
      message: 'Error fetching attestation requests',
    });
  }
});

// Submit attestation response
router.post('/devices/:id/attestations/:attestationId', async (req, res) => {
  // backend#1220 / #1240: every branch below writes (EXPIRED, ATTESTED + device
  // status, FAILED), so it stays operator/IoT-admin only. The response is now
  // verified with real ed25519 against the device's registered key (never a
  // caller-supplied one), so an attestation can no longer be forged with a key
  // the caller chooses.
  if (!requirePrivilegedIot(req, res)) {
    return;
  }
  try {
    const { id, attestationId } = req.params;
    const { response } = req.body;

    // Check if attestation request exists
    const [attestation] = await db
      .select()
      .from(attestationRequests)
      // and(): chained .where() calls REPLACE each other in drizzle, so the previous
      // form matched on the device id alone.
      .where(and(eq(attestationRequests.id, attestationId), eq(attestationRequests.deviceId, id)));

    if (!attestation) {
      return res.status(404).json({
        success: false,
        message: `Attestation request with ID ${attestationId} not found for device ${id}`,
      });
    }

    // Check if attestation has expired
    if (new Date(attestation.expiresAt) < new Date()) {
      await db
        .update(attestationRequests)
        .set({
          status: 'EXPIRED',
          failedAt: new Date(),
          failureReason: 'Attestation request expired',
        })
        .where(eq(attestationRequests.id, attestationId));

      return res.status(400).json({
        success: false,
        message: 'Attestation request has expired',
      });
    }

    // Verify against the device's REGISTERED public key; a key supplied in the
    // response is never trusted (backend#1240).
    const [attestedDevice] = await db.select().from(devices).where(eq(devices.id, id));
    const verificationResult = await controller.verifyAttestation(
      attestation.challenge,
      response,
      { deviceId: id, publicKey: attestedDevice && attestedDevice.publicKey }
    );

    if (verificationResult.success) {
      // Update attestation request
      await db
        .update(attestationRequests)
        .set({
          status: 'ATTESTED',
          response,
          completedAt: new Date(),
        })
        .where(eq(attestationRequests.id, attestationId));

      // Update device attestation status
      await db
        .update(devices)
        .set({
          attestationStatus: 'ATTESTED',
          updatedAt: new Date(),
        })
        .where(eq(devices.id, id));

      return res.json({
        success: true,
        message: 'Attestation completed successfully',
        result: verificationResult,
      });
    } else {
      // Update attestation request as failed
      await db
        .update(attestationRequests)
        .set({
          status: 'FAILED',
          response,
          failedAt: new Date(),
          failureReason: verificationResult.message,
        })
        .where(eq(attestationRequests.id, attestationId));

      return res.status(400).json({
        success: false,
        message: 'Attestation verification failed',
        result: verificationResult,
      });
    }
  } catch (error) {
    logger.error(`Error processing attestation response: ${error.message}`, {
      error: error.toString(),
    });
    return res.status(500).json({
      success: false,
      message: 'Error processing attestation response',
    });
  }
});

// backend#1171: no W3bstream client exists, so every /w3bstream/* route
// answers the standard not-wired 501 until one is configured and implemented.
// Authorization comes first (backend#1220: every /w3bstream route is
// operator/IoT-admin only), so an anonymous caller gets 401 and learns
// nothing about wiring; only an authorized caller sees the 501.
const { requireW3bstreamWired } = require('../integrations/iotex/w3bstream-adapter');
router.use('/w3bstream', (req, res, next) => {
  if (!requirePrivilegedIot(req, res)) {
    return;
  }
  return requireW3bstreamWired(req, res, next);
});

// W3bstream publisher registration
router.post('/w3bstream/publishers', async (req, res) => {
  // backend#1220 / #1240: publisher public keys are what event signatures are
  // checked against; registering one is an operator/IoT-admin action.
  if (!requirePrivilegedIot(req, res)) {
    return;
  }
  try {
    const { name, type, publicKey, deviceId, metadata } = req.body;

    if (!name || !type || !publicKey) {
      return res.status(400).json({
        success: false,
        message: 'Publisher name, type and public key are required',
      });
    }

    const normalizedPublisherKey = await controller.normalizePublicKey(publicKey);
    if (!normalizedPublisherKey) {
      return res.status(400).json({
        success: false,
        message: 'publicKey must be a 32-byte ed25519 public key as 64 hex characters',
        code: 'INVALID_PUBLIC_KEY',
      });
    }

    // Generate publisher ID
    const publisherId = `pub-${randomBytes(4).toString('hex')}`;

    // Create the publisher
    const [newPublisher] = await db
      .insert(w3bstreamPublishers)
      .values({
        id: publisherId,
        name,
        type,
        publicKey: normalizedPublisherKey,
        deviceId,
        metadata,
        createdAt: new Date(),
      })
      .returning();

    return res.status(201).json({
      success: true,
      publisher: newPublisher,
      message: 'Publisher registered successfully',
    });
  } catch (error) {
    logger.error(`Error registering publisher: ${error.message}`, {
      error: error.toString(),
    });
    return res.status(500).json({
      success: false,
      message: 'Error registering publisher',
    });
  }
});

// W3bstream event submission
router.post('/w3bstream/events', async (req, res) => {
  // backend#1220 / #1240: events are persisted and processed, so this stays
  // operator bearer or IoT gateway admin only (and 501 until W3bstream is wired);
  // the signature flag below is real ed25519 verification.
  if (!requirePrivilegedIot(req, res)) {
    return;
  }
  try {
    const { publisherId, eventType, payload, signature } = req.body;

    if (!publisherId || !eventType || !payload) {
      return res.status(400).json({
        success: false,
        message: 'Publisher ID, event type and payload are required',
      });
    }

    if (hasReservedPayloadKey(payload)) {
      return res.status(400).json({
        success: false,
        message: 'Payload contains a reserved key',
        code: 'RESERVED_PAYLOAD_KEY',
      });
    }

    // Get publisher
    const [publisher] = await db
      .select()
      .from(w3bstreamPublishers)
      .where(eq(w3bstreamPublishers.id, publisherId));

    if (!publisher) {
      return res.status(404).json({
        success: false,
        message: `Publisher with ID ${publisherId} not found`,
      });
    }

    // Real ed25519 verification over the canonical `w3bstream_event` message
    // ({ timestamp (unix seconds), nonce, signature } in the body). The route stays
    // operator/IoT-admin only and not wired (backend#1171); the flag is now honest.
    let verified = false;
    if (signature && publisher.publicKey) {
      const result = await controller.verifySignedSubmission({
        kind: 'w3bstreamEvent',
        subjectId: publisherId,
        timestamp: req.body.timestamp,
        nonce: req.body.nonce,
        payload: { eventType, payload },
        signature,
        publicKey: publisher.publicKey,
      });
      verified = result.ok;
    }

    // Create event
    const [newEvent] = await db
      .insert(w3bstreamEvents)
      .values({
        id: uuidv4(),
        publisherId,
        eventType,
        payload,
        timestamp: new Date(),
        verified,
        createdAt: new Date(),
      })
      .returning();

    // Process event
    const result = await controller.processW3bstreamEvent(newEvent, publisher);

    if (result && result.blockchainTx) {
      // Update event with blockchain transaction
      await db
        .update(w3bstreamEvents)
        .set({ blockchainTx: result.blockchainTx })
        .where(eq(w3bstreamEvents.id, newEvent.id));

      newEvent.blockchainTx = result.blockchainTx;
    }

    // Update publisher's last event timestamp
    await db
      .update(w3bstreamPublishers)
      .set({ lastEventTimestamp: new Date() })
      .where(eq(w3bstreamPublishers.id, publisherId));

    return res.status(201).json({
      success: true,
      event: newEvent,
      message: 'Event submitted successfully',
      processing: result,
    });
  } catch (error) {
    logger.error(`Error submitting W3bstream event: ${error.message}`, {
      error: error.toString(),
    });
    return res.status(500).json({
      success: false,
      message: 'Error submitting W3bstream event',
    });
  }
});

// Get W3bstream publishers
router.get('/w3bstream/publishers', async (req, res) => {
  // backend#1220: raw readings, attestation challenges, publisher keys and
  // attestation/location writes are operator/IoT-admin only.
  if (!requirePrivilegedIot(req, res)) {
    return;
  }
  try {
    const { limit, offset, page } = parseListPagination(req.query, {
      defaultLimit: 50,
      maxLimit: 200,
    });
    const [countRow] = await db
      .select({ total: count() })
      .from(w3bstreamPublishers);
    const publishers = await db
      .select()
      .from(w3bstreamPublishers)
      .orderBy(desc(w3bstreamPublishers.createdAt), desc(w3bstreamPublishers.id))
      .limit(limit)
      .offset(offset);

    return res.json(
      paginatedResponse(
        publishers,
        Number(countRow?.total ?? 0),
        page,
        limit
      )
    );
  } catch (error) {
    logger.error(`Error fetching publishers: ${error.message}`, {
      error: error.toString(),
    });
    return res.status(500).json({
      success: false,
      message: 'Error fetching publishers',
    });
  }
});

// Get events for a specific publisher
router.get('/w3bstream/publishers/:id/events', async (req, res) => {
  // backend#1220: raw readings, attestation challenges, publisher keys and
  // attestation/location writes are operator/IoT-admin only.
  if (!requirePrivilegedIot(req, res)) {
    return;
  }
  try {
    const { id } = req.params;
    const { limit, offset, page } = parseListPagination(req.query, {
      defaultLimit: 50,
      maxLimit: 200,
    });

    // Check if publisher exists
    const [publisher] = await db
      .select()
      .from(w3bstreamPublishers)
      .where(eq(w3bstreamPublishers.id, id));

    if (!publisher) {
      return res.status(404).json({
        success: false,
        message: `Publisher with ID ${id} not found`,
      });
    }

    // Get events
    const events = await db
      .select()
      .from(w3bstreamEvents)
      .where(eq(w3bstreamEvents.publisherId, id))
      .orderBy(w3bstreamEvents.timestamp, w3bstreamEvents.id)
      .limit(limit)
      .offset(offset);
    const [countRow] = await db
      .select({ total: count() })
      .from(w3bstreamEvents)
      .where(eq(w3bstreamEvents.publisherId, id));

    return res.json(
      paginatedResponse(
        events,
        Number(countRow?.total ?? 0),
        page,
        limit
      )
    );
  } catch (error) {
    logger.error(`Error fetching publisher events: ${error.message}`, {
      error: error.toString(),
    });
    return res.status(500).json({
      success: false,
      message: 'Error fetching publisher events',
    });
  }
});

module.exports = router;
