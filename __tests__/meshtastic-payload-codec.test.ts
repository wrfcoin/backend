/**
 * Meshtastic Payload Codec Tests
 *
 * Unit tests for:
 * - JSON encoding/decoding
 * - Base64 encoding/decoding
 * - CBOR encoding/decoding
 * - Observation parsing
 * - Schema validation
 * - Sensor range validation
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import {
  WrfcoinPayloadCodec,
  PayloadDecodeError,
  PayloadEncodeError,
} from '../shared/meshtastic-payload-codec.js';
import { ObservationParser, parseWrfObservation } from '../shared/meshtastic-observation-parser.js';
import {
  type WrfcoinPayload,
  type ObsBody,
  type MeshContext,
  SENSOR_RANGES,
  obsBodySchema,
  wrfcoinPayloadSchema,
} from '../shared/meshtastic-payload-types.js';

// ============================================================================
// Test Data
// ============================================================================

const validObsBody: ObsBody = {
  ts: 1704067200, // 2024-01-01T00:00:00Z
  lat: 37.7749,
  lon: -122.4194,
  alt: 10,
  tmp: 20.5,
  hum: 65,
  prs: 1013.25,
  lux: 15000,
  pm25: 12.5,
  pm10: 25,
  voc: 100,
  co2: 450,
  bat: 85,
  batV: 3.7,
  upt: 3600,
};

const validObsPayload: WrfcoinPayload<ObsBody> = {
  t: 'wrf',
  v: 1,
  kind: 'obs',
  body: validObsBody,
};

const minimalObsBody: ObsBody = {
  ts: 1704067200,
};

const minimalObsPayload: WrfcoinPayload<ObsBody> = {
  t: 'wrf',
  v: 1,
  kind: 'obs',
  body: minimalObsBody,
};

const meshContext: MeshContext = {
  rssi: -75,
  snr: 8.5,
  hopCount: 2,
  neighborCount: 5,
};

// ============================================================================
// JSON Encoding/Decoding Tests
// ============================================================================

describe('WrfcoinPayloadCodec - JSON', () => {
  describe('encodeJson', () => {
    it('should encode valid observation payload to JSON', () => {
      const json = WrfcoinPayloadCodec.encodeJson(validObsPayload);
      expect(typeof json).toBe('string');
      expect(json).toContain('"t":"wrf"');
      expect(json).toContain('"kind":"obs"');
    });

    it('should encode minimal observation payload', () => {
      const json = WrfcoinPayloadCodec.encodeJson(minimalObsPayload);
      expect(json).toContain('"ts":1704067200');
    });

    it('should encode ping payload', () => {
      const pingPayload = WrfcoinPayloadCodec.createPingPayload(1704067200, 42);
      const json = WrfcoinPayloadCodec.encodeJson(pingPayload);
      expect(json).toContain('"kind":"ping"');
      expect(json).toContain('"seq":42');
    });
  });

  describe('decodeJson', () => {
    it('should decode valid JSON to payload', () => {
      const json = JSON.stringify(validObsPayload);
      const payload = WrfcoinPayloadCodec.decodeJson<ObsBody>(json);
      expect(payload.t).toBe('wrf');
      expect(payload.v).toBe(1);
      expect(payload.kind).toBe('obs');
      expect(payload.body.ts).toBe(validObsBody.ts);
    });

    it('should throw PayloadDecodeError for invalid JSON', () => {
      expect(() => WrfcoinPayloadCodec.decodeJson('not valid json')).toThrow(PayloadDecodeError);
    });

    it('should throw PayloadDecodeError for empty string', () => {
      expect(() => WrfcoinPayloadCodec.decodeJson('')).toThrow(PayloadDecodeError);
    });
  });

  describe('JSON roundtrip', () => {
    it('should preserve data through encode/decode cycle', () => {
      const encoded = WrfcoinPayloadCodec.encodeJson(validObsPayload);
      const decoded = WrfcoinPayloadCodec.decodeJson<ObsBody>(encoded);
      expect(decoded).toEqual(validObsPayload);
    });

    it('should preserve floating point precision', () => {
      const payload: WrfcoinPayload<ObsBody> = {
        t: 'wrf',
        v: 1,
        kind: 'obs',
        body: { ts: 1704067200, tmp: 20.123456789, lat: 37.77490123, lon: -122.41941234 },
      };
      const encoded = WrfcoinPayloadCodec.encodeJson(payload);
      const decoded = WrfcoinPayloadCodec.decodeJson<ObsBody>(encoded);
      expect(decoded.body.tmp).toBe(20.123456789);
      expect(decoded.body.lat).toBe(37.77490123);
    });
  });
});

// ============================================================================
// Base64 Encoding/Decoding Tests
// ============================================================================

describe('WrfcoinPayloadCodec - Base64', () => {
  describe('encodeBase64', () => {
    it('should encode payload to Base64 string', () => {
      const base64 = WrfcoinPayloadCodec.encodeBase64(validObsPayload);
      expect(typeof base64).toBe('string');
      // Base64 should not contain special characters except +/=
      expect(base64).toMatch(/^[A-Za-z0-9+/=]+$/);
    });

    it('should produce valid Base64 that decodes to JSON', () => {
      const base64 = WrfcoinPayloadCodec.encodeBase64(validObsPayload);
      const decoded = Buffer.from(base64, 'base64').toString('utf-8');
      expect(() => JSON.parse(decoded)).not.toThrow();
    });
  });

  describe('decodeBase64', () => {
    it('should decode Base64 to payload', () => {
      const base64 = WrfcoinPayloadCodec.encodeBase64(validObsPayload);
      const payload = WrfcoinPayloadCodec.decodeBase64<ObsBody>(base64);
      expect(payload.t).toBe('wrf');
      expect(payload.body.ts).toBe(validObsBody.ts);
    });

    it('should throw PayloadDecodeError for invalid Base64', () => {
      expect(() => WrfcoinPayloadCodec.decodeBase64('!!not-base64!!')).toThrow(PayloadDecodeError);
    });
  });

  describe('Base64 roundtrip', () => {
    it('should preserve data through encode/decode cycle', () => {
      const encoded = WrfcoinPayloadCodec.encodeBase64(validObsPayload);
      const decoded = WrfcoinPayloadCodec.decodeBase64<ObsBody>(encoded);
      expect(decoded).toEqual(validObsPayload);
    });
  });
});

// ============================================================================
// CBOR Encoding/Decoding Tests
// ============================================================================

describe('WrfcoinPayloadCodec - CBOR', () => {
  describe('encodeCbor', () => {
    it('should encode payload to CBOR Buffer', () => {
      const cbor = WrfcoinPayloadCodec.encodeCbor(validObsPayload);
      expect(Buffer.isBuffer(cbor)).toBe(true);
      expect(cbor.length).toBeGreaterThan(0);
    });

    it('should be more compact than JSON for typical payloads', () => {
      const json = WrfcoinPayloadCodec.encodeJson(validObsPayload);
      const cbor = WrfcoinPayloadCodec.encodeCbor(validObsPayload);
      expect(cbor.length).toBeLessThan(Buffer.byteLength(json));
    });
  });

  describe('decodeCbor', () => {
    it('should decode CBOR Buffer to payload', () => {
      const cbor = WrfcoinPayloadCodec.encodeCbor(validObsPayload);
      const payload = WrfcoinPayloadCodec.decodeCbor<ObsBody>(cbor);
      expect(payload.t).toBe('wrf');
      expect(payload.body.ts).toBe(validObsBody.ts);
    });

    it('should throw PayloadDecodeError for invalid CBOR', () => {
      const invalidBuffer = Buffer.from([0xff, 0xff, 0xff]);
      expect(() => WrfcoinPayloadCodec.decodeCbor(invalidBuffer)).toThrow(PayloadDecodeError);
    });
  });

  describe('encodeCborBase64 / decodeCborBase64', () => {
    it('should encode CBOR to Base64 string', () => {
      const base64 = WrfcoinPayloadCodec.encodeCborBase64(validObsPayload);
      expect(typeof base64).toBe('string');
      expect(base64).toMatch(/^[A-Za-z0-9+/=]+$/);
    });

    it('should decode Base64-CBOR to payload', () => {
      const base64 = WrfcoinPayloadCodec.encodeCborBase64(validObsPayload);
      const payload = WrfcoinPayloadCodec.decodeCborBase64<ObsBody>(base64);
      expect(payload.t).toBe('wrf');
      expect(payload.body.tmp).toBe(validObsBody.tmp);
    });
  });

  describe('CBOR roundtrip', () => {
    it('should preserve data through encode/decode cycle', () => {
      const encoded = WrfcoinPayloadCodec.encodeCbor(validObsPayload);
      const decoded = WrfcoinPayloadCodec.decodeCbor<ObsBody>(encoded);
      expect(decoded).toEqual(validObsPayload);
    });

    it('should preserve data through CBOR-Base64 cycle', () => {
      const encoded = WrfcoinPayloadCodec.encodeCborBase64(validObsPayload);
      const decoded = WrfcoinPayloadCodec.decodeCborBase64<ObsBody>(encoded);
      expect(decoded).toEqual(validObsPayload);
    });
  });
});

// ============================================================================
// Validation Tests
// ============================================================================

describe('WrfcoinPayloadCodec - Validation', () => {
  describe('isWrfcoinPayload', () => {
    it('should return true for valid payload', () => {
      expect(WrfcoinPayloadCodec.isWrfcoinPayload(validObsPayload)).toBe(true);
    });

    it('should return false for null', () => {
      expect(WrfcoinPayloadCodec.isWrfcoinPayload(null)).toBe(false);
    });

    it('should return false for non-object', () => {
      expect(WrfcoinPayloadCodec.isWrfcoinPayload('string')).toBe(false);
      expect(WrfcoinPayloadCodec.isWrfcoinPayload(123)).toBe(false);
    });

    it('should return false for missing t field', () => {
      expect(WrfcoinPayloadCodec.isWrfcoinPayload({ v: 1, kind: 'obs', body: {} })).toBe(false);
    });

    it('should return false for wrong t value', () => {
      expect(WrfcoinPayloadCodec.isWrfcoinPayload({ t: 'other', v: 1, kind: 'obs', body: {} })).toBe(
        false
      );
    });

    it('should return false for invalid kind', () => {
      expect(WrfcoinPayloadCodec.isWrfcoinPayload({ t: 'wrf', v: 1, kind: 'invalid', body: {} })).toBe(
        false
      );
    });
  });

  describe('validatePayload', () => {
    it('should validate valid observation payload', () => {
      const result = WrfcoinPayloadCodec.validatePayload(validObsPayload);
      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it('should validate minimal observation payload', () => {
      const result = WrfcoinPayloadCodec.validatePayload(minimalObsPayload);
      expect(result.valid).toBe(true);
    });

    it('should reject payload with invalid version', () => {
      const invalid = { ...validObsPayload, v: -1 };
      const result = WrfcoinPayloadCodec.validatePayload(invalid);
      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
    });

    it('should reject payload with invalid kind', () => {
      const invalid = { t: 'wrf', v: 1, kind: 'invalid', body: { ts: 123 } };
      const result = WrfcoinPayloadCodec.validatePayload(invalid);
      expect(result.valid).toBe(false);
    });
  });

  describe('validateObsBody', () => {
    it('should validate valid observation body', () => {
      const result = WrfcoinPayloadCodec.validateObsBody(validObsBody);
      expect(result.valid).toBe(true);
    });

    it('should validate minimal observation body', () => {
      const result = WrfcoinPayloadCodec.validateObsBody(minimalObsBody);
      expect(result.valid).toBe(true);
    });

    it('should reject body with missing timestamp', () => {
      const result = WrfcoinPayloadCodec.validateObsBody({ lat: 37, lon: -122 });
      expect(result.valid).toBe(false);
    });
  });
});

// ============================================================================
// Sensor Range Validation Tests
// ============================================================================

describe('Sensor Range Validation', () => {
  describe('Temperature (tmp)', () => {
    it('should accept temperature within range', () => {
      const result = obsBodySchema.safeParse({ ts: 123, tmp: 20 });
      expect(result.success).toBe(true);
    });

    it('should accept minimum temperature', () => {
      const result = obsBodySchema.safeParse({ ts: 123, tmp: SENSOR_RANGES.tmp.min });
      expect(result.success).toBe(true);
    });

    it('should accept maximum temperature', () => {
      const result = obsBodySchema.safeParse({ ts: 123, tmp: SENSOR_RANGES.tmp.max });
      expect(result.success).toBe(true);
    });

    it('should reject temperature below range', () => {
      const result = obsBodySchema.safeParse({ ts: 123, tmp: SENSOR_RANGES.tmp.min - 1 });
      expect(result.success).toBe(false);
    });

    it('should reject temperature above range', () => {
      const result = obsBodySchema.safeParse({ ts: 123, tmp: SENSOR_RANGES.tmp.max + 1 });
      expect(result.success).toBe(false);
    });
  });

  describe('Humidity (hum)', () => {
    it('should accept humidity within range', () => {
      const result = obsBodySchema.safeParse({ ts: 123, hum: 50 });
      expect(result.success).toBe(true);
    });

    it('should reject negative humidity', () => {
      const result = obsBodySchema.safeParse({ ts: 123, hum: -1 });
      expect(result.success).toBe(false);
    });

    it('should reject humidity over 100', () => {
      const result = obsBodySchema.safeParse({ ts: 123, hum: 101 });
      expect(result.success).toBe(false);
    });
  });

  describe('Pressure (prs)', () => {
    it('should accept pressure within range', () => {
      const result = obsBodySchema.safeParse({ ts: 123, prs: 1013.25 });
      expect(result.success).toBe(true);
    });

    it('should reject pressure below range', () => {
      const result = obsBodySchema.safeParse({ ts: 123, prs: SENSOR_RANGES.prs.min - 1 });
      expect(result.success).toBe(false);
    });

    it('should reject pressure above range', () => {
      const result = obsBodySchema.safeParse({ ts: 123, prs: SENSOR_RANGES.prs.max + 1 });
      expect(result.success).toBe(false);
    });
  });

  describe('PM2.5 (pm25)', () => {
    it('should accept PM2.5 within range', () => {
      const result = obsBodySchema.safeParse({ ts: 123, pm25: 35 });
      expect(result.success).toBe(true);
    });

    it('should reject negative PM2.5', () => {
      const result = obsBodySchema.safeParse({ ts: 123, pm25: -1 });
      expect(result.success).toBe(false);
    });
  });

  describe('Battery (bat)', () => {
    it('should accept battery within range', () => {
      const result = obsBodySchema.safeParse({ ts: 123, bat: 85 });
      expect(result.success).toBe(true);
    });

    it('should reject battery over 100', () => {
      const result = obsBodySchema.safeParse({ ts: 123, bat: 101 });
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// Observation Parser Tests
// ============================================================================

describe('ObservationParser', () => {
  describe('parseCompact', () => {
    it('should parse full observation body', () => {
      const result = ObservationParser.parseCompact('node-123', validObsBody);
      expect(result.nodeId).toBe('node-123');
      expect(result.timestamp).toBe('2024-01-01T00:00:00.000Z');
      expect(result.location.lat).toBe(37.7749);
      expect(result.location.lon).toBe(-122.4194);
      expect(result.environment.temperatureC).toBe(20.5);
      expect(result.environment.humidityPct).toBe(65);
      expect(result.airQuality?.pm2_5).toBe(12.5);
      expect(result.deviceMetrics?.batteryPct).toBe(85);
    });

    it('should parse minimal observation body', () => {
      const result = ObservationParser.parseCompact('node-456', minimalObsBody);
      expect(result.nodeId).toBe('node-456');
      expect(result.timestamp).toBe('2024-01-01T00:00:00.000Z');
      expect(result.location.lat).toBe(0);
      expect(result.location.lon).toBe(0);
      expect(result.environment.temperatureC).toBeUndefined();
      expect(result.airQuality).toBeUndefined();
      expect(result.deviceMetrics).toBeUndefined();
    });

    it('should include mesh context when provided', () => {
      const result = ObservationParser.parseCompact('node-789', validObsBody, meshContext);
      expect(result.meshContext).toBeDefined();
      expect(result.meshContext?.rssi).toBe(-75);
      expect(result.meshContext?.snr).toBe(8.5);
      expect(result.meshContext?.hopCount).toBe(2);
    });

    it('should set schema version', () => {
      const result = ObservationParser.parseCompact('node-123', validObsBody, undefined, 2);
      expect(result.schemaVersion).toBe(2);
    });
  });

  describe('parseWithValidation', () => {
    it('should return success for valid body', () => {
      const result = ObservationParser.parseWithValidation('node-123', validObsBody);
      expect(result.success).toBe(true);
      expect(result.observation).toBeDefined();
      expect(result.errors).toBeUndefined();
    });

    it('should return errors for invalid body', () => {
      const invalidBody = { ts: -1 }; // Negative timestamp
      const result = ObservationParser.parseWithValidation('node-123', invalidBody);
      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBeGreaterThan(0);
    });

    it('should return errors for missing timestamp', () => {
      const result = ObservationParser.parseWithValidation('node-123', { lat: 37, lon: -122 });
      expect(result.success).toBe(false);
      expect(result.errors?.some((e) => e.field === 'ts')).toBe(true);
    });
  });

  describe('expandKeys', () => {
    it('should expand compact field names', () => {
      const expanded = ObservationParser.expandKeys(validObsBody);
      expect(expanded.environment.temperatureC).toBe(20.5);
      expect(expanded.environment.humidityPct).toBe(65);
      expect(expanded.environment.pressureHpa).toBe(1013.25);
      expect(expanded.airQuality?.pm2_5).toBe(12.5);
      expect(expanded.deviceMetrics?.batteryPct).toBe(85);
      expect(expanded.location.lat).toBe(37.7749);
    });

    it('should convert timestamp to Date', () => {
      const expanded = ObservationParser.expandKeys(validObsBody);
      expect(expanded.timestamp).toBeInstanceOf(Date);
      expect(expanded.timestamp.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    });
  });

  describe('normalizeTimestamp', () => {
    it('should convert Unix timestamp to ISO 8601', () => {
      const iso = ObservationParser.normalizeTimestamp(1704067200);
      expect(iso).toBe('2024-01-01T00:00:00.000Z');
    });

    it('should handle current timestamps', () => {
      const now = Math.floor(Date.now() / 1000);
      const iso = ObservationParser.normalizeTimestamp(now);
      expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
    });
  });

  describe('toUnixTimestamp', () => {
    it('should convert ISO 8601 to Unix timestamp', () => {
      const unix = ObservationParser.toUnixTimestamp('2024-01-01T00:00:00.000Z');
      expect(unix).toBe(1704067200);
    });
  });

  describe('compactKeys', () => {
    it('should compact enriched observation back to LoRa format', () => {
      const enriched = ObservationParser.parseCompact('node-123', validObsBody);
      const compacted = ObservationParser.compactKeys(enriched);
      expect(compacted.ts).toBe(validObsBody.ts);
      expect(compacted.tmp).toBe(validObsBody.tmp);
      expect(compacted.lat).toBe(validObsBody.lat);
      expect(compacted.pm25).toBe(validObsBody.pm25);
      expect(compacted.bat).toBe(validObsBody.bat);
    });

    it('should produce minimal compact body for minimal observation', () => {
      const enriched = ObservationParser.parseCompact('node-123', minimalObsBody);
      const compacted = ObservationParser.compactKeys(enriched);
      expect(compacted.ts).toBe(minimalObsBody.ts);
      expect(compacted.tmp).toBeUndefined();
    });
  });

  describe('parseWrfObservation convenience function', () => {
    it('should parse observation like ObservationParser.parseCompact', () => {
      const result = parseWrfObservation('node-123', validObsBody, meshContext);
      expect(result.nodeId).toBe('node-123');
      expect(result.meshContext?.rssi).toBe(-75);
    });
  });
});

// ============================================================================
// Utility Method Tests
// ============================================================================

describe('WrfcoinPayloadCodec - Utilities', () => {
  describe('createObsPayload', () => {
    it('should create observation payload with defaults', () => {
      const payload = WrfcoinPayloadCodec.createObsPayload(validObsBody);
      expect(payload.t).toBe('wrf');
      expect(payload.v).toBe(WrfcoinPayloadCodec.SCHEMA_VERSION);
      expect(payload.kind).toBe('obs');
      expect(payload.body).toBe(validObsBody);
    });

    it('should allow custom version', () => {
      const payload = WrfcoinPayloadCodec.createObsPayload(validObsBody, 2);
      expect(payload.v).toBe(2);
    });
  });

  describe('createPingPayload', () => {
    it('should create ping payload with timestamp', () => {
      const payload = WrfcoinPayloadCodec.createPingPayload(1704067200);
      expect(payload.kind).toBe('ping');
      expect(payload.body.ts).toBe(1704067200);
      expect(payload.body.seq).toBeUndefined();
    });

    it('should create ping payload with sequence number', () => {
      const payload = WrfcoinPayloadCodec.createPingPayload(1704067200, 42);
      expect(payload.body.seq).toBe(42);
    });

    it('should use current time if not specified', () => {
      const before = Math.floor(Date.now() / 1000);
      const payload = WrfcoinPayloadCodec.createPingPayload();
      const after = Math.floor(Date.now() / 1000);
      expect(payload.body.ts).toBeGreaterThanOrEqual(before);
      expect(payload.body.ts).toBeLessThanOrEqual(after);
    });
  });

  describe('estimateSize', () => {
    it('should return size estimates for all formats', () => {
      const sizes = WrfcoinPayloadCodec.estimateSize(validObsPayload);
      expect(sizes.json).toBeGreaterThan(0);
      expect(sizes.jsonBase64).toBeGreaterThan(0);
      expect(sizes.cbor).toBeGreaterThan(0);
      expect(sizes.cborBase64).toBeGreaterThan(0);
    });

    it('should show CBOR is more compact than JSON', () => {
      const sizes = WrfcoinPayloadCodec.estimateSize(validObsPayload);
      expect(sizes.cbor).toBeLessThan(sizes.json);
    });

    it('should show Base64 is larger than raw encoding', () => {
      const sizes = WrfcoinPayloadCodec.estimateSize(validObsPayload);
      expect(sizes.jsonBase64).toBeGreaterThan(sizes.json);
      expect(sizes.cborBase64).toBeGreaterThan(sizes.cbor);
    });
  });

  describe('autoDecode', () => {
    it('should detect and decode JSON', () => {
      const json = WrfcoinPayloadCodec.encodeJson(validObsPayload);
      const { payload, format } = WrfcoinPayloadCodec.autoDecode<ObsBody>(json);
      expect(format).toBe('json');
      expect(payload.body.ts).toBe(validObsBody.ts);
    });

    it('should detect and decode Base64-JSON', () => {
      const base64 = WrfcoinPayloadCodec.encodeBase64(validObsPayload);
      const { payload, format } = WrfcoinPayloadCodec.autoDecode<ObsBody>(base64);
      expect(format).toBe('base64-json');
      expect(payload.body.ts).toBe(validObsBody.ts);
    });

    it('should detect and decode Base64-CBOR', () => {
      const base64Cbor = WrfcoinPayloadCodec.encodeCborBase64(validObsPayload);
      const { payload, format } = WrfcoinPayloadCodec.autoDecode<ObsBody>(base64Cbor);
      expect(format).toBe('base64-cbor');
      expect(payload.body.ts).toBe(validObsBody.ts);
    });

    it('should throw for unknown format', () => {
      expect(() => WrfcoinPayloadCodec.autoDecode('random garbage data')).toThrow(PayloadDecodeError);
    });
  });
});

// ============================================================================
// Edge Case Tests
// ============================================================================

describe('Edge Cases', () => {
  it('should handle observation with only location', () => {
    const body: ObsBody = { ts: 123, lat: 37, lon: -122 };
    const result = ObservationParser.parseCompact('node', body);
    expect(result.location.lat).toBe(37);
    expect(result.environment.temperatureC).toBeUndefined();
  });

  it('should handle observation with only air quality', () => {
    const body: ObsBody = { ts: 123, pm25: 25, pm10: 50 };
    const result = ObservationParser.parseCompact('node', body);
    expect(result.airQuality?.pm2_5).toBe(25);
    expect(result.environment.temperatureC).toBeUndefined();
  });

  it('should handle observation with only device metrics', () => {
    const body: ObsBody = { ts: 123, bat: 75, upt: 3600 };
    const result = ObservationParser.parseCompact('node', body);
    expect(result.deviceMetrics?.batteryPct).toBe(75);
    expect(result.deviceMetrics?.uptimeSeconds).toBe(3600);
  });

  it('should handle zero values correctly', () => {
    const body: ObsBody = { ts: 123, lat: 0, lon: 0, tmp: 0, hum: 0, bat: 0 };
    const result = obsBodySchema.safeParse(body);
    expect(result.success).toBe(true);

    const parsed = ObservationParser.parseCompact('node', body);
    expect(parsed.location.lat).toBe(0);
    expect(parsed.environment.temperatureC).toBe(0);
  });

  it('should handle boundary values', () => {
    const body: ObsBody = {
      ts: 1,
      lat: -90,
      lon: 180,
      tmp: SENSOR_RANGES.tmp.max,
      hum: 100,
      prs: SENSOR_RANGES.prs.min,
    };
    const result = obsBodySchema.safeParse(body);
    expect(result.success).toBe(true);
  });

  it('should handle large payloads', () => {
    const largePayload: WrfcoinPayload<ObsBody> = {
      t: 'wrf',
      v: 1,
      kind: 'obs',
      body: validObsBody,
    };

    // Test all encoding methods
    const json = WrfcoinPayloadCodec.encodeJson(largePayload);
    const base64 = WrfcoinPayloadCodec.encodeBase64(largePayload);
    const cbor = WrfcoinPayloadCodec.encodeCbor(largePayload);

    expect(WrfcoinPayloadCodec.decodeJson<ObsBody>(json)).toEqual(largePayload);
    expect(WrfcoinPayloadCodec.decodeBase64<ObsBody>(base64)).toEqual(largePayload);
    expect(WrfcoinPayloadCodec.decodeCbor<ObsBody>(cbor)).toEqual(largePayload);
  });
});
