import nacl from 'tweetnacl';
import {
  verifyDeviceSignature,
  isRegisteredDevice,
  registerDevice,
  clearRegistry,
  registeredDeviceCount,
  bytesToHex,
  setDeviceStore,
  createInMemoryStore,
} from '../server/iot-edge-gateway/device-auth.js';
import { BatchSigner } from '../server/iot-edge-gateway/batch-signer.js';
import type { SensorReading, DeviceRegistration } from '../server/iot-edge-gateway/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeKeyPair() {
  const kp = nacl.sign.keyPair();
  return {
    publicKey: bytesToHex(kp.publicKey),
    secretKey: kp.secretKey,
  };
}

function signReading(
  fields: Omit<SensorReading, 'signature'>,
  secretKey: Uint8Array,
): SensorReading {
  const payload: Record<string, unknown> = {
    deviceId: fields.deviceId,
    timestamp: fields.timestamp,
    sensorType: fields.sensorType,
    value: fields.value,
    unit: fields.unit,
  };
  if (fields.location) {
    payload.location = fields.location;
  }
  payload.publicKey = fields.publicKey;

  const encoder = new TextEncoder();
  const message = encoder.encode(JSON.stringify(payload));
  const sig = nacl.sign.detached(message, secretKey);

  return {
    ...fields,
    signature: bytesToHex(sig),
  };
}

function signRegistration(
  fields: Omit<DeviceRegistration, 'signature'>,
  secretKey: Uint8Array,
): DeviceRegistration {
  const payload: Record<string, unknown> = {
    deviceId: fields.deviceId,
    publicKey: fields.publicKey,
    deviceType: fields.deviceType,
  };
  if (fields.manufacturer) {
    payload.manufacturer = fields.manufacturer;
  }
  if (fields.firmware) {
    payload.firmware = fields.firmware;
  }
  if (fields.location) {
    payload.location = fields.location;
  }

  const encoder = new TextEncoder();
  const message = encoder.encode(JSON.stringify(payload));
  const sig = nacl.sign.detached(message, secretKey);

  return {
    ...fields,
    signature: bytesToHex(sig),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IoT Edge Gateway', () => {
  beforeEach(async () => {
    setDeviceStore(createInMemoryStore());
    await clearRegistry();
  });

  // -----------------------------------------------------------------------
  // Device registration
  // -----------------------------------------------------------------------
  describe('device registration', () => {
    it('should register a device and look it up', async () => {
      const { publicKey, secretKey } = makeKeyPair();
      const reg: DeviceRegistration = signRegistration({
        deviceId: 'sensor-001',
        publicKey,
        deviceType: 'weather',
      }, secretKey);

      expect(await isRegisteredDevice('sensor-001')).toBe(false);
      expect(await registerDevice(reg)).toBe(true);
      expect(await isRegisteredDevice('sensor-001')).toBe(true);
      expect(await registeredDeviceCount()).toBe(1);
    });

    it('should return false for unknown devices', async () => {
      expect(await isRegisteredDevice('nonexistent')).toBe(false);
    });

    it('should reject re-registration with a different public key', async () => {
      const kp1 = makeKeyPair();
      const kp2 = makeKeyPair();

      expect(await registerDevice(signRegistration({
        deviceId: 'd1',
        publicKey: kp1.publicKey,
        deviceType: 'temp',
      }, kp1.secretKey))).toBe(true);

      // Same deviceId, different key — must be rejected
      expect(await registerDevice(signRegistration({
        deviceId: 'd1',
        publicKey: kp2.publicKey,
        deviceType: 'humidity',
      }, kp2.secretKey))).toBe(false);

      expect(await registeredDeviceCount()).toBe(1);
    });

    it('should allow idempotent re-registration with the same key', async () => {
      const { publicKey, secretKey } = makeKeyPair();

      expect(await registerDevice(signRegistration({
        deviceId: 'd1',
        publicKey,
        deviceType: 'temp',
      }, secretKey))).toBe(true);

      // Same deviceId, same key — idempotent
      expect(await registerDevice(signRegistration({
        deviceId: 'd1',
        publicKey,
        deviceType: 'humidity',
      }, secretKey))).toBe(true);

      expect(await registeredDeviceCount()).toBe(1);
    });

    it('should reject unsigned registration payloads', async () => {
      const { publicKey } = makeKeyPair();

      expect(await registerDevice({
        deviceId: 'sensor-unsigned',
        publicKey,
        deviceType: 'weather',
      })).toBe(false);
      expect(await isRegisteredDevice('sensor-unsigned')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Signature verification
  // -----------------------------------------------------------------------
  describe('signature verification', () => {
    it('should accept a valid ed25519 signature', async () => {
      const { publicKey, secretKey } = makeKeyPair();
      const reading = signReading(
        {
          deviceId: 'sensor-001',
          timestamp: Date.now(),
          sensorType: 'temperature',
          value: 22.5,
          unit: 'C',
          publicKey,
        },
        secretKey,
      );

      expect(await verifyDeviceSignature(reading)).toBe(true);
    });

    it('should accept a reading that includes location', async () => {
      const { publicKey, secretKey } = makeKeyPair();
      const reading = signReading(
        {
          deviceId: 'sensor-002',
          timestamp: Date.now(),
          sensorType: 'humidity',
          value: 65,
          unit: '%',
          location: { lat: 40.7, lng: -74.0, altitude: 10 },
          publicKey,
        },
        secretKey,
      );

      expect(await verifyDeviceSignature(reading)).toBe(true);
    });

    it('should reject a reading with a tampered value', async () => {
      const { publicKey, secretKey } = makeKeyPair();
      const reading = signReading(
        {
          deviceId: 'sensor-001',
          timestamp: Date.now(),
          sensorType: 'temperature',
          value: 22.5,
          unit: 'C',
          publicKey,
        },
        secretKey,
      );

      // Tamper with the value
      reading.value = 99.9;
      expect(await verifyDeviceSignature(reading)).toBe(false);
    });

    it('should reject a reading signed with a different key', async () => {
      const kp1 = makeKeyPair();
      const kp2 = makeKeyPair();

      const reading = signReading(
        {
          deviceId: 'sensor-001',
          timestamp: Date.now(),
          sensorType: 'pressure',
          value: 1013,
          unit: 'hPa',
          publicKey: kp1.publicKey,
        },
        kp2.secretKey, // wrong key
      );

      expect(await verifyDeviceSignature(reading)).toBe(false);
    });

    it('should reject a registered device reading that supplies a different public key', async () => {
      const registered = makeKeyPair();
      const attacker = makeKeyPair();

      expect(
        await registerDevice(
          signRegistration(
            {
              deviceId: 'sensor-bound',
              publicKey: registered.publicKey,
              deviceType: 'temperature',
            },
            registered.secretKey,
          ),
        ),
      ).toBe(true);

      const reading = signReading(
        {
          deviceId: 'sensor-bound',
          timestamp: Date.now(),
          sensorType: 'temperature',
          value: 23.4,
          unit: 'C',
          publicKey: attacker.publicKey,
        },
        attacker.secretKey,
      );

      expect(await verifyDeviceSignature(reading)).toBe(false);
    });

    it('should reject a reading with an invalid signature hex', async () => {
      const { publicKey } = makeKeyPair();
      const reading: SensorReading = {
        deviceId: 'sensor-001',
        timestamp: Date.now(),
        sensorType: 'temperature',
        value: 20,
        unit: 'C',
        publicKey,
        signature: 'not-valid-hex',
      };

      expect(await verifyDeviceSignature(reading)).toBe(false);
    });

    it('should reject a reading with a truncated signature', async () => {
      const { publicKey, secretKey } = makeKeyPair();
      const reading = signReading(
        {
          deviceId: 'sensor-001',
          timestamp: Date.now(),
          sensorType: 'temperature',
          value: 20,
          unit: 'C',
          publicKey,
        },
        secretKey,
      );

      // Truncate signature
      reading.signature = reading.signature.slice(0, 32);
      expect(await verifyDeviceSignature(reading)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Batch accumulation and flush
  // -----------------------------------------------------------------------
  describe('batch signer', () => {
    let signer: BatchSigner;

    beforeEach(() => {
      signer = new BatchSigner();
    });

    afterEach(() => {
      signer.stop();
    });

    it('should accumulate readings', () => {
      const { publicKey, secretKey } = makeKeyPair();
      const reading = signReading(
        {
          deviceId: 'sensor-001',
          timestamp: Date.now(),
          sensorType: 'temperature',
          value: 22.5,
          unit: 'C',
          publicKey,
        },
        secretKey,
      );

      signer.addReading(reading);
      signer.addReading(reading);
      expect(signer.pendingCount).toBe(2);
    });

    it('should return null when flushing an empty buffer', async () => {
      const result = await signer.flush();
      expect(result).toBeNull();
    });

    it('should flush readings into a signed batch', async () => {
      const { publicKey, secretKey } = makeKeyPair();
      const reading = signReading(
        {
          deviceId: 'sensor-001',
          timestamp: Date.now(),
          sensorType: 'temperature',
          value: 22.5,
          unit: 'C',
          publicKey,
        },
        secretKey,
      );

      signer.addReading(reading);
      signer.addReading(reading);

      // Mock global fetch so we don't hit a real server
      const originalFetch = globalThis.fetch;
      globalThis.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

      try {
        const batch = await signer.flush();
        expect(batch).not.toBeNull();
        expect(batch!.readings).toHaveLength(2);
        expect(batch!.readingCount).toBe(2);
        expect(batch!.batchId).toBeTruthy();
        expect(batch!.gatewaySignature).toBeTruthy();
        expect(batch!.timestamp).toBeGreaterThan(0);

        // Buffer should be empty after flush
        expect(signer.pendingCount).toBe(0);
        expect(signer.lastFlushTime).toBeGreaterThan(0);

        // Fetch should have been called with the batch
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        const [url, opts] = (globalThis.fetch as jest.Mock).mock.calls[0];
        expect(url).toContain('/sensors/aggregate-data');
        expect(opts.method).toBe('POST');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should handle fetch failure gracefully', async () => {
      const { publicKey, secretKey } = makeKeyPair();
      const reading = signReading(
        {
          deviceId: 'sensor-001',
          timestamp: Date.now(),
          sensorType: 'temperature',
          value: 22.5,
          unit: 'C',
          publicKey,
        },
        secretKey,
      );

      signer.addReading(reading);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = jest.fn().mockRejectedValue(new Error('connection refused'));

      try {
        // Should not throw
        const batch = await signer.flush();
        expect(batch).not.toBeNull();
        expect(batch!.readingCount).toBe(1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // -----------------------------------------------------------------------
  // MQTT message handling (unit-level, no real broker)
  // -----------------------------------------------------------------------
  describe('MQTT handler integration', () => {
    // We test the MQTT handler indirectly through the device-auth + batch-signer
    // path, since starting a real Aedes broker requires port binding.
    // Full integration is validated by starting the gateway in a real environment.

    it('should reject unregistered device readings', async () => {
      const { publicKey, secretKey } = makeKeyPair();
      const reading = signReading(
        {
          deviceId: 'unregistered-device',
          timestamp: Date.now(),
          sensorType: 'temperature',
          value: 22.5,
          unit: 'C',
          publicKey,
        },
        secretKey,
      );

      // The auth check the MQTT handler would perform:
      expect(await isRegisteredDevice(reading.deviceId)).toBe(false);
    });

    it('should accept registered device with valid signature', async () => {
      const { publicKey, secretKey } = makeKeyPair();
      expect(await registerDevice(signRegistration({
        deviceId: 'sensor-100',
        publicKey,
        deviceType: 'weather',
      }, secretKey))).toBe(true);

      const reading = signReading(
        {
          deviceId: 'sensor-100',
          timestamp: Date.now(),
          sensorType: 'temperature',
          value: 22.5,
          unit: 'C',
          publicKey,
        },
        secretKey,
      );

      expect(await isRegisteredDevice(reading.deviceId)).toBe(true);
      expect(await verifyDeviceSignature(reading)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Malformed message rejection
  // -----------------------------------------------------------------------
  describe('malformed message handling', () => {
    it('should reject reading with missing required fields', async () => {
      const result = await verifyDeviceSignature({
        deviceId: '',
        timestamp: 0,
        sensorType: '',
        value: 0,
        unit: '',
        publicKey: '',
        signature: '',
      });
      expect(result).toBe(false);
    });

    it('should reject reading with non-hex signature', async () => {
      const { publicKey } = makeKeyPair();
      const result = await verifyDeviceSignature({
        deviceId: 'sensor-001',
        timestamp: Date.now(),
        sensorType: 'temperature',
        value: 20,
        unit: 'C',
        publicKey,
        signature: 'zzzzzzzz',
      });
      expect(result).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Persistence-specific tests
  // -----------------------------------------------------------------------
  describe('persistence behavior', () => {
    it('should survive a store reset when using the same backing store', async () => {
      const store = createInMemoryStore();
      setDeviceStore(store);

      const { publicKey, secretKey } = makeKeyPair();
      expect(await registerDevice(signRegistration({
        deviceId: 'persistent-001',
        publicKey,
        deviceType: 'weather',
      }, secretKey))).toBe(true);

      // Simulate a "restart" — re-set the same store instance
      setDeviceStore(store);
      expect(await isRegisteredDevice('persistent-001')).toBe(true);
      expect(await registeredDeviceCount()).toBe(1);
    });

    it('should prevent key takeover across store operations', async () => {
      const legitimate = makeKeyPair();
      const attacker = makeKeyPair();

      // Legitimate device registers
      expect(await registerDevice(signRegistration({
        deviceId: 'weather-station-42',
        publicKey: legitimate.publicKey,
        deviceType: 'weather',
      }, legitimate.secretKey))).toBe(true);

      // Attacker tries to re-register same deviceId with their key
      expect(await registerDevice(signRegistration({
        deviceId: 'weather-station-42',
        publicKey: attacker.publicKey,
        deviceType: 'weather',
      }, attacker.secretKey))).toBe(false);

      // Attacker tries to submit a reading — signature check uses registered key
      const attackerReading = signReading({
        deviceId: 'weather-station-42',
        timestamp: Date.now(),
        sensorType: 'temperature',
        value: 99.9,
        unit: 'C',
        publicKey: attacker.publicKey,
      }, attacker.secretKey);

      expect(await verifyDeviceSignature(attackerReading)).toBe(false);

      // Legitimate device can still submit
      const legitimateReading = signReading({
        deviceId: 'weather-station-42',
        timestamp: Date.now(),
        sensorType: 'temperature',
        value: 22.5,
        unit: 'C',
        publicKey: legitimate.publicKey,
      }, legitimate.secretKey);

      expect(await verifyDeviceSignature(legitimateReading)).toBe(true);
    });
  });
});
