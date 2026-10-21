/**
 * Meshtastic Payload Types and Zod Schemas
 *
 * Centralized type definitions for WRFCoin LoRa payload envelope format.
 * Used for encoding/decoding payloads transmitted over Meshtastic mesh network.
 *
 * Payload envelope format:
 * {
 *   t: 'wrf',           // Type marker identifying WRFCoin packets
 *   v: number,          // Schema version (start with 1)
 *   kind: PayloadKind,  // Payload type
 *   body: T             // Kind-specific body
 * }
 */

import { z } from 'zod';

// ============================================================================
// Constants: Sensor Value Ranges (Physics-based validation)
// ============================================================================

/**
 * Valid ranges for sensor measurements based on physical constraints.
 * Used for data quality validation.
 */
export const SENSOR_RANGES = {
  /** Temperature in Celsius - Earth's recorded extremes */
  tmp: { min: -89.2, max: 70.7 },
  /** Humidity percentage */
  hum: { min: 0, max: 100 },
  /** Atmospheric pressure in hPa - Earth's recorded extremes */
  prs: { min: 870, max: 1083.8 },
  /** Battery percentage */
  bat: { min: 0, max: 100 },
  /** Altitude in meters - below sea level to above Everest */
  alt: { min: -500, max: 9000 },
  /** Light in lux */
  lux: { min: 0, max: 150000 },
  /** PM2.5 in ug/m3 - AQI hazardous max */
  pm25: { min: 0, max: 500 },
  /** PM10 in ug/m3 */
  pm10: { min: 0, max: 1000 },
  /** VOC index (0-500 scale) */
  voc: { min: 0, max: 500 },
  /** CO2 in ppm - outdoor to dangerous indoor levels */
  co2: { min: 280, max: 10000 },
  /** Battery voltage in V */
  batV: { min: 0, max: 5 },
  /** Uptime in seconds - up to ~1 year */
  upt: { min: 0, max: 31536000 },
} as const;

// ============================================================================
// Type Definitions
// ============================================================================

/** Payload kind identifiers */
export type PayloadKind = 'obs' | 'reg' | 'tx' | 'ping' | 'sos' | 'sat' | 'trk' | 'sig';

/**
 * Generic WRFCoin payload envelope.
 * All LoRa packets from WRFCoin nodes use this envelope format.
 */
export interface WrfcoinPayload<T = unknown> {
  /** Type marker - always 'wrf' for WRFCoin packets */
  t: 'wrf';
  /** Schema version number */
  v: number;
  /** Payload kind identifier */
  kind: PayloadKind;
  /** Kind-specific payload body */
  body: T;
}

/**
 * Compact observation body format for LoRa transmission.
 * Uses short field names to minimize payload size.
 */
export interface ObsBody {
  /** Unix timestamp (seconds since epoch) */
  ts: number;
  /** Latitude (-90 to 90) */
  lat?: number;
  /** Longitude (-180 to 180) */
  lon?: number;
  /** Altitude in meters */
  alt?: number;
  /** Temperature in Celsius */
  tmp?: number;
  /** Humidity percentage (0-100) */
  hum?: number;
  /** Atmospheric pressure in hPa */
  prs?: number;
  /** Light level in lux */
  lux?: number;
  /** PM2.5 particulate matter (ug/m3) */
  pm25?: number;
  /** PM10 particulate matter (ug/m3) */
  pm10?: number;
  /** VOC index */
  voc?: number;
  /** CO2 equivalent in ppm */
  co2?: number;
  /** Battery percentage (0-100) */
  bat?: number;
  /** Battery voltage in V */
  batV?: number;
  /** Uptime in seconds */
  upt?: number;
}

/**
 * Registration body for node registration requests.
 * Handled by Task 111.
 */
export interface RegBody {
  /** WRFCoin wallet address */
  addr: string;
  /** Registration nonce */
  nonce: number;
  /** Unix timestamp */
  ts: number;
  /** Cryptographic signature */
  sig: string;
  /** Optional device metadata */
  meta?: {
    /** Hardware model identifier */
    hw?: string;
    /** Firmware version */
    fw?: string;
    /** Short display name */
    sn?: string;
    /** Long display name */
    ln?: string;
  };
}

/**
 * Transaction chunk body for transaction relay.
 * Large transactions are split into chunks for LoRa transmission.
 */
export interface TxBody {
  /** Transaction ID */
  txId: string;
  /** Sender address */
  from: string;
  /** Recipient address */
  to: string;
  /** Amount as string (for precision) */
  amount: string;
  /** Transaction nonce */
  nonce: number;
  /** Transaction signature */
  signature: string;
  /** Chunk information */
  chunk: {
    /** Chunk index (0-based) */
    index: number;
    /** Total number of chunks */
    total: number;
    /** Base64-encoded chunk data */
    data: string;
  };
}

/**
 * Ping body for health checks and keepalive messages.
 */
export interface PingBody {
  /** Unix timestamp */
  ts: number;
  /** Optional sequence number */
  seq?: number;
}

/**
 * SOS emergency beacon body.
 * SAFETY-CRITICAL: These must never be silently dropped.
 */
export interface SosBody {
  /** Unix timestamp */
  ts: number;
  /** Latitude */
  lat?: number;
  /** Longitude */
  lon?: number;
  /** Altitude in meters */
  alt?: number;
  /** Battery percentage */
  bat?: number;
  /** Free-form emergency message */
  msg?: string;
}

/**
 * Satellite status body for connectivity reporting.
 */
export interface SatBody {
  /** Unix timestamp */
  ts: number;
  /** Number of satellites in view */
  sats?: number;
  /** GPS fix type: 0=none, 2=2D, 3=3D */
  fix?: number;
  /** Horizontal dilution of precision */
  hdop?: number;
}

/**
 * Tracking update body for periodic location reports.
 */
export interface TrkBody {
  /** Unix timestamp */
  ts: number;
  /** Latitude */
  lat: number;
  /** Longitude */
  lon: number;
  /** Altitude in meters */
  alt?: number;
  /** Speed in m/s */
  spd?: number;
  /** Heading in degrees (0-360) */
  hdg?: number;
}

/**
 * Signed observation body — observation with cryptographic signature.
 */
export interface SigBody {
  /** Unix timestamp */
  ts: number;
  /** Wallet address of signer */
  addr: string;
  /** Cryptographic signature over the observation data */
  sig: string;
  /** The signed observation payload (compact obs format) */
  obs: ObsBody;
}

/**
 * Mesh network context from Meshtastic.
 * Provides signal quality and routing information.
 */
export interface MeshContext {
  /** Received Signal Strength Indicator in dBm */
  rssi?: number;
  /** Signal-to-Noise Ratio in dB */
  snr?: number;
  /** Number of hops from original sender */
  hopCount?: number;
  /** Number of neighbor nodes */
  neighborCount?: number;
}

/**
 * Enriched observation after gateway processing.
 * Expanded from compact ObsBody format with additional context.
 */
export interface EnrichedObservation {
  /** Meshtastic node ID */
  nodeId: string;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Location information */
  location: {
    lat: number;
    lon: number;
    alt?: number;
  };
  /** Environmental measurements */
  environment: {
    temperatureC?: number;
    humidityPct?: number;
    pressureHpa?: number;
    lightLux?: number;
  };
  /** Air quality measurements */
  airQuality?: {
    pm2_5?: number;
    pm10?: number;
    vocIndex?: number;
    co2EqPpm?: number;
  };
  /** Device metrics */
  deviceMetrics?: {
    batteryPct?: number;
    batteryVoltage?: number;
    uptimeSeconds?: number;
  };
  /** Mesh network context */
  meshContext?: MeshContext;
  /** Schema version from original payload */
  schemaVersion: number;
}

/**
 * Validation result structure.
 */
export interface ValidationResult {
  /** Whether validation passed */
  valid: boolean;
  /** Array of validation errors if any */
  errors?: Array<{
    field: string;
    message: string;
    code?: string;
  }>;
}

// ============================================================================
// Zod Schemas
// ============================================================================

/**
 * Zod schema for observation body with sensor range validation.
 */
export const obsBodySchema = z.object({
  ts: z.number().int().positive(),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
  alt: z.number().min(SENSOR_RANGES.alt.min).max(SENSOR_RANGES.alt.max).optional(),
  tmp: z.number().min(SENSOR_RANGES.tmp.min).max(SENSOR_RANGES.tmp.max).optional(),
  hum: z.number().min(SENSOR_RANGES.hum.min).max(SENSOR_RANGES.hum.max).optional(),
  prs: z.number().min(SENSOR_RANGES.prs.min).max(SENSOR_RANGES.prs.max).optional(),
  lux: z.number().min(SENSOR_RANGES.lux.min).max(SENSOR_RANGES.lux.max).optional(),
  pm25: z.number().min(SENSOR_RANGES.pm25.min).max(SENSOR_RANGES.pm25.max).optional(),
  pm10: z.number().min(SENSOR_RANGES.pm10.min).max(SENSOR_RANGES.pm10.max).optional(),
  voc: z.number().int().min(SENSOR_RANGES.voc.min).max(SENSOR_RANGES.voc.max).optional(),
  co2: z.number().int().min(SENSOR_RANGES.co2.min).max(SENSOR_RANGES.co2.max).optional(),
  bat: z.number().int().min(SENSOR_RANGES.bat.min).max(SENSOR_RANGES.bat.max).optional(),
  batV: z.number().min(SENSOR_RANGES.batV.min).max(SENSOR_RANGES.batV.max).optional(),
  upt: z.number().int().min(SENSOR_RANGES.upt.min).max(SENSOR_RANGES.upt.max).optional(),
});

/**
 * Zod schema for registration body.
 */
export const regBodySchema = z.object({
  addr: z.string().min(1).max(128),
  nonce: z.number().int().min(1).max(2147483647),
  ts: z.number().int().positive(),
  sig: z.string().min(64),
  meta: z
    .object({
      hw: z.string().max(64).optional(),
      fw: z.string().max(32).optional(),
      sn: z.string().max(16).optional(),
      ln: z.string().max(255).optional(),
    })
    .optional(),
});

/**
 * Address format regex patterns for validation.
 * Supports EVM addresses (0x...) and WRFCoin native addresses (wrf...).
 */
const EVM_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
const WRFCOIN_ADDRESS_REGEX = /^wrf[a-zA-Z0-9]{30,64}$/;
const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const HEX_64_REGEX = /^[0-9a-fA-F]{64}$/;

/**
 * Validates an address is either EVM or WRFCoin format.
 */
const isValidAddress = (address: string): boolean => {
  return EVM_ADDRESS_REGEX.test(address) || WRFCOIN_ADDRESS_REGEX.test(address);
};

/**
 * Validates a transaction ID is either UUID or 64-char hex.
 */
const isValidTxId = (txId: string): boolean => {
  return UUID_REGEX.test(txId) || HEX_64_REGEX.test(txId);
};

/**
 * Validates an amount string is a positive number.
 */
const isValidAmount = (amount: string): boolean => {
  const parsed = parseFloat(amount);
  return !isNaN(parsed) && parsed > 0 && isFinite(parsed);
};

/**
 * Zod schema for transaction body.
 * Enhanced validation for Task 109 - LoRa Transaction Relay.
 */
export const txBodySchema = z
  .object({
    txId: z
      .string()
      .min(1)
      .refine(isValidTxId, {
        message: 'txId must be a valid UUID or 64-character hex string',
      }),
    from: z
      .string()
      .min(1)
      .refine(isValidAddress, {
        message: 'from address must be EVM (0x...) or WRFCoin (wrf...) format',
      }),
    to: z
      .string()
      .min(1)
      .refine(isValidAddress, {
        message: 'to address must be EVM (0x...) or WRFCoin (wrf...) format',
      }),
    amount: z
      .string()
      .min(1)
      .refine(isValidAmount, {
        message: 'amount must be a valid positive number',
      }),
    nonce: z.number().int().min(0),
    signature: z.string().min(64, 'signature must be at least 64 characters'),
    chunk: z.object({
      index: z.number().int().min(0),
      total: z.number().int().min(1).max(256, 'total chunks cannot exceed 256'),
      data: z.string().min(1),
    }),
  })
  .refine(data => data.chunk.index < data.chunk.total, {
    message: 'chunk.index must be less than chunk.total',
    path: ['chunk', 'index'],
  });

/**
 * Zod schema for ping body.
 */
export const pingBodySchema = z.object({
  ts: z.number().int().positive(),
  seq: z.number().int().min(0).optional(),
});

/**
 * Zod schema for SOS emergency beacon body.
 */
export const sosBodySchema = z.object({
  ts: z.number().int().positive(),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
  alt: z.number().min(SENSOR_RANGES.alt.min).max(SENSOR_RANGES.alt.max).optional(),
  bat: z.number().int().min(0).max(100).optional(),
  msg: z.string().max(256).optional(),
});

/**
 * Zod schema for satellite status body.
 */
export const satBodySchema = z.object({
  ts: z.number().int().positive(),
  sats: z.number().int().min(0).max(100).optional(),
  fix: z.number().int().min(0).max(3).optional(),
  hdop: z.number().min(0).max(100).optional(),
});

/**
 * Zod schema for tracking update body.
 */
export const trkBodySchema = z.object({
  ts: z.number().int().positive(),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  alt: z.number().min(SENSOR_RANGES.alt.min).max(SENSOR_RANGES.alt.max).optional(),
  spd: z.number().min(0).max(1000).optional(),
  hdg: z.number().min(0).max(360).optional(),
});

/**
 * Zod schema for signed observation body.
 */
export const sigBodySchema = z.object({
  ts: z.number().int().positive(),
  addr: z.string().min(1).max(128),
  sig: z.string().min(64),
  obs: obsBodySchema,
});

/**
 * Zod schema for mesh context.
 */
export const meshContextSchema = z.object({
  rssi: z.number().int().optional(),
  snr: z.number().optional(),
  hopCount: z.number().int().min(0).optional(),
  neighborCount: z.number().int().min(0).optional(),
});

/**
 * Zod schema for payload kind.
 */
export const payloadKindSchema = z.enum(['obs', 'reg', 'tx', 'ping', 'sos', 'sat', 'trk', 'sig']);

/**
 * Zod schema for base WRFCoin payload envelope (without typed body).
 */
export const wrfcoinPayloadBaseSchema = z.object({
  t: z.literal('wrf'),
  v: z.number().int().positive(),
  kind: payloadKindSchema,
  body: z.record(z.string(), z.unknown()),
});

/**
 * Zod schema for WRFCoin payload with observation body.
 */
export const wrfcoinObsPayloadSchema = z.object({
  t: z.literal('wrf'),
  v: z.number().int().positive(),
  kind: z.literal('obs'),
  body: obsBodySchema,
});

/**
 * Zod schema for WRFCoin payload with registration body.
 */
export const wrfcoinRegPayloadSchema = z.object({
  t: z.literal('wrf'),
  v: z.number().int().positive(),
  kind: z.literal('reg'),
  body: regBodySchema,
});

/**
 * Zod schema for WRFCoin payload with transaction body.
 */
export const wrfcoinTxPayloadSchema = z.object({
  t: z.literal('wrf'),
  v: z.number().int().positive(),
  kind: z.literal('tx'),
  body: txBodySchema,
});

/**
 * Zod schema for WRFCoin payload with ping body.
 */
export const wrfcoinPingPayloadSchema = z.object({
  t: z.literal('wrf'),
  v: z.number().int().positive(),
  kind: z.literal('ping'),
  body: pingBodySchema,
});

/**
 * Zod schema for WRFCoin payload with SOS beacon body.
 */
export const wrfcoinSosPayloadSchema = z.object({
  t: z.literal('wrf'),
  v: z.number().int().positive(),
  kind: z.literal('sos'),
  body: sosBodySchema,
});

/**
 * Zod schema for WRFCoin payload with satellite status body.
 */
export const wrfcoinSatPayloadSchema = z.object({
  t: z.literal('wrf'),
  v: z.number().int().positive(),
  kind: z.literal('sat'),
  body: satBodySchema,
});

/**
 * Zod schema for WRFCoin payload with tracking update body.
 */
export const wrfcoinTrkPayloadSchema = z.object({
  t: z.literal('wrf'),
  v: z.number().int().positive(),
  kind: z.literal('trk'),
  body: trkBodySchema,
});

/**
 * Zod schema for WRFCoin payload with signed observation body.
 */
export const wrfcoinSigPayloadSchema = z.object({
  t: z.literal('wrf'),
  v: z.number().int().positive(),
  kind: z.literal('sig'),
  body: sigBodySchema,
});

/**
 * Combined Zod schema for any WRFCoin payload.
 * Discriminated union based on 'kind' field.
 */
export const wrfcoinPayloadSchema = z.discriminatedUnion('kind', [
  wrfcoinObsPayloadSchema,
  wrfcoinRegPayloadSchema,
  wrfcoinTxPayloadSchema,
  wrfcoinPingPayloadSchema,
  wrfcoinSosPayloadSchema,
  wrfcoinSatPayloadSchema,
  wrfcoinTrkPayloadSchema,
  wrfcoinSigPayloadSchema,
]);

// ============================================================================
// Type Exports from Zod Schemas
// ============================================================================

export type ObsBodyZod = z.infer<typeof obsBodySchema>;
export type RegBodyZod = z.infer<typeof regBodySchema>;
export type TxBodyZod = z.infer<typeof txBodySchema>;
export type PingBodyZod = z.infer<typeof pingBodySchema>;
export type MeshContextZod = z.infer<typeof meshContextSchema>;
export type WrfcoinPayloadZod = z.infer<typeof wrfcoinPayloadSchema>;
export type WrfcoinObsPayloadZod = z.infer<typeof wrfcoinObsPayloadSchema>;
export type WrfcoinRegPayloadZod = z.infer<typeof wrfcoinRegPayloadSchema>;
export type WrfcoinTxPayloadZod = z.infer<typeof wrfcoinTxPayloadSchema>;
export type WrfcoinPingPayloadZod = z.infer<typeof wrfcoinPingPayloadSchema>;
export type SosBodyZod = z.infer<typeof sosBodySchema>;
export type SatBodyZod = z.infer<typeof satBodySchema>;
export type TrkBodyZod = z.infer<typeof trkBodySchema>;
export type SigBodyZod = z.infer<typeof sigBodySchema>;
export type WrfcoinSosPayloadZod = z.infer<typeof wrfcoinSosPayloadSchema>;
export type WrfcoinSatPayloadZod = z.infer<typeof wrfcoinSatPayloadSchema>;
export type WrfcoinTrkPayloadZod = z.infer<typeof wrfcoinTrkPayloadSchema>;
export type WrfcoinSigPayloadZod = z.infer<typeof wrfcoinSigPayloadSchema>;

// ============================================================================
// Transaction Validation Utility Exports (Task 109)
// ============================================================================

export {
  isValidAddress,
  isValidTxId,
  isValidAmount,
  EVM_ADDRESS_REGEX,
  WRFCOIN_ADDRESS_REGEX,
  UUID_REGEX,
  HEX_64_REGEX,
};
