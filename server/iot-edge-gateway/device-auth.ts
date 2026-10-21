import nacl from 'tweetnacl';
import { eq, sql } from 'drizzle-orm';
import type { SensorReading, DeviceRegistration } from './types.js';

// ---------------------------------------------------------------------------
// Pluggable persistence back-end
// ---------------------------------------------------------------------------

export interface DeviceStoreBackend {
  get(deviceId: string): Promise<DeviceRegistration | undefined>;
  /** Persist a registration. Returns 'key_conflict' if the deviceId already
   *  exists with a *different* public key. */
  save(reg: DeviceRegistration): Promise<'saved' | 'key_conflict'>;
  has(deviceId: string): Promise<boolean>;
  count(): Promise<number>;
  clear(): Promise<void>;
}

/** In-memory store — used as the default (tests / when no DB is configured). */
export function createInMemoryStore(): DeviceStoreBackend {
  const map = new Map<string, DeviceRegistration>();
  return {
    async get(deviceId) { return map.get(deviceId); },
    async save(reg) {
      const existing = map.get(reg.deviceId);
      if (existing && existing.publicKey !== reg.publicKey) return 'key_conflict';
      map.set(reg.deviceId, reg);
      return 'saved';
    },
    async has(deviceId) { return map.has(deviceId); },
    async count() { return map.size; },
    async clear() { map.clear(); },
  };
}

/** PostgreSQL-backed store via Drizzle ORM. */
export function createPostgresStore(db: any, devicesTable: any): DeviceStoreBackend {
  return {
    async get(deviceId) {
      const rows = await db.select().from(devicesTable)
        .where(eq(devicesTable.deviceId, deviceId)).limit(1);
      if (rows.length === 0) return undefined;
      const row = rows[0];
      const meta = (row.deviceMetadata ?? {}) as Record<string, unknown>;
      return {
        deviceId: row.deviceId,
        publicKey: row.publicKeyHex ?? '',
        deviceType: row.deviceType,
        manufacturer: meta.manufacturer as string | undefined,
        firmware: meta.firmware as string | undefined,
        location: row.locationLat != null && row.locationLon != null
          ? { lat: Number(row.locationLat), lng: Number(row.locationLon) }
          : undefined,
      };
    },
    async save(reg) {
      const existing = await this.get(reg.deviceId);
      if (existing && existing.publicKey !== reg.publicKey) return 'key_conflict';

      const metadata: Record<string, unknown> = {};
      if (reg.manufacturer) metadata.manufacturer = reg.manufacturer;
      if (reg.firmware) metadata.firmware = reg.firmware;

      if (existing) {
        await db.update(devicesTable).set({
          deviceType: reg.deviceType,
          publicKeyHex: reg.publicKey,
          deviceMetadata: metadata,
          locationLat: reg.location?.lat?.toString() ?? null,
          locationLon: reg.location?.lng?.toString() ?? null,
          lastSeen: new Date(),
          updatedAt: new Date(),
        }).where(eq(devicesTable.deviceId, reg.deviceId));
        return 'saved';
      }

      await db.insert(devicesTable).values({
        deviceId: reg.deviceId,
        deviceType: reg.deviceType,
        publicKeyHex: reg.publicKey,
        deviceMetadata: metadata,
        locationLat: reg.location?.lat?.toString() ?? null,
        locationLon: reg.location?.lng?.toString() ?? null,
        isActive: true,
      });
      return 'saved';
    },
    async has(deviceId) {
      const rows = await db.select({ id: devicesTable.id }).from(devicesTable)
        .where(eq(devicesTable.deviceId, deviceId)).limit(1);
      return rows.length > 0;
    },
    async count() {
      const [row] = await db.select({ value: sql`count(*)::int` }).from(devicesTable);
      return row?.value ?? 0;
    },
    async clear() {
      await db.delete(devicesTable);
    },
  };
}

let store: DeviceStoreBackend = createInMemoryStore();

/** Replace the device store back-end (call at service startup for PostgreSQL). */
export function setDeviceStore(backend: DeviceStoreBackend): void {
  store = backend;
}

// ---------------------------------------------------------------------------
// Signing / verification helpers (pure — unchanged)
// ---------------------------------------------------------------------------

function buildSigningPayload(reading: SensorReading): Uint8Array {
  const payload: Record<string, unknown> = {
    deviceId: reading.deviceId,
    timestamp: reading.timestamp,
    sensorType: reading.sensorType,
    value: reading.value,
    unit: reading.unit,
  };
  if (reading.location) {
    payload.location = reading.location;
  }
  payload.publicKey = reading.publicKey;

  const encoder = new TextEncoder();
  return encoder.encode(JSON.stringify(payload));
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function buildRegistrationPayload(registration: DeviceRegistration): Uint8Array {
  const payload: Record<string, unknown> = {
    deviceId: registration.deviceId,
    publicKey: registration.publicKey,
    deviceType: registration.deviceType,
  };
  if (registration.manufacturer) payload.manufacturer = registration.manufacturer;
  if (registration.firmware) payload.firmware = registration.firmware;
  if (registration.location) payload.location = registration.location;

  const encoder = new TextEncoder();
  return encoder.encode(JSON.stringify(payload));
}

export function verifyRegistrationSignature(registration: DeviceRegistration): boolean {
  try {
    if (!registration.signature) return false;
    const message = buildRegistrationPayload(registration);
    const signature = hexToBytes(registration.signature);
    const publicKey = hexToBytes(registration.publicKey);

    return nacl.sign.detached.verify(message, signature, publicKey);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API (async — backed by pluggable store)
// ---------------------------------------------------------------------------

/**
 * Verify the ed25519 signature on a sensor reading.
 * Registered devices must sign with their registered public key.
 */
export async function verifyDeviceSignature(reading: SensorReading): Promise<boolean> {
  try {
    const registered = await store.get(reading.deviceId);
    if (registered && reading.publicKey !== registered.publicKey) {
      return false;
    }

    const expectedPublicKey = registered?.publicKey ?? reading.publicKey;
    const message = buildSigningPayload({
      ...reading,
      publicKey: expectedPublicKey,
    });
    const signature = hexToBytes(reading.signature);
    const publicKey = hexToBytes(expectedPublicKey);

    if (signature.length !== nacl.sign.signatureLength) {
      return false;
    }
    if (publicKey.length !== nacl.sign.publicKeyLength) {
      return false;
    }

    return nacl.sign.detached.verify(message, signature, publicKey);
  } catch {
    return false;
  }
}

/**
 * Check whether a device is registered.
 */
export async function isRegisteredDevice(deviceId: string): Promise<boolean> {
  return store.has(deviceId);
}

/**
 * Register a device. Returns true if successful.
 * Rejects if the deviceId is already registered with a different public key.
 */
export async function registerDevice(registration: DeviceRegistration): Promise<boolean> {
  if (!verifyRegistrationSignature(registration)) {
    return false;
  }
  const result = await store.save(registration);
  return result === 'saved';
}

/**
 * Get a registered device by ID.
 */
export async function getDevice(deviceId: string): Promise<DeviceRegistration | undefined> {
  return store.get(deviceId);
}

/**
 * Return the total number of registered devices.
 */
export async function registeredDeviceCount(): Promise<number> {
  return store.count();
}

/**
 * Clear the device registry (testing only).
 */
export async function clearRegistry(): Promise<void> {
  await store.clear();
}

// Re-export helpers for signing in tests
export { buildSigningPayload, hexToBytes };
