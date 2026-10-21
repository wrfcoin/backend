/**
 * Meshtastic Payload Codec
 *
 * Encoding/decoding functions for WRFCoin LoRa payload envelope.
 * Supports JSON, Base64, and CBOR formats for different use cases:
 *
 * - JSON: Human-readable, good for debugging and API responses
 * - Base64: Text-safe encoding for LoRa text payloads
 * - CBOR: Binary format for bandwidth optimization on LoRa
 */

import { encode as cborEncode, decode as cborDecode } from 'cbor-x';
import {
  type WrfcoinPayload,
  type ObsBody,
  type ValidationResult,
  type PayloadKind,
  wrfcoinPayloadSchema,
  wrfcoinPayloadBaseSchema,
  obsBodySchema,
  regBodySchema,
  txBodySchema,
  pingBodySchema,
} from './meshtastic-payload-types.js';

// ============================================================================
// Error Classes
// ============================================================================

/**
 * Error thrown when payload decoding fails.
 */
export class PayloadDecodeError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'PayloadDecodeError';
  }
}

/**
 * Error thrown when payload encoding fails.
 */
export class PayloadEncodeError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'PayloadEncodeError';
  }
}

/**
 * Error thrown when payload validation fails.
 */
export class PayloadValidationError extends Error {
  constructor(
    message: string,
    public readonly errors: ValidationResult['errors']
  ) {
    super(message);
    this.name = 'PayloadValidationError';
  }
}

// ============================================================================
// WRFCoin Payload Codec
// ============================================================================

/**
 * Codec for WRFCoin payload envelope encoding and decoding.
 * Provides static methods for JSON, Base64, and CBOR formats.
 */
export class WrfcoinPayloadCodec {
  /** Current schema version */
  static readonly SCHEMA_VERSION = 1;

  /** Type marker for WRFCoin payloads */
  static readonly TYPE_MARKER = 'wrf' as const;

  // ==========================================================================
  // JSON Encoding/Decoding
  // ==========================================================================

  /**
   * Encode payload to JSON string.
   *
   * @param payload - WRFCoin payload to encode
   * @returns JSON string representation
   * @throws PayloadEncodeError if encoding fails
   */
  static encodeJson<T>(payload: WrfcoinPayload<T>): string {
    try {
      return JSON.stringify(payload);
    } catch (error) {
      throw new PayloadEncodeError(
        'Failed to encode payload to JSON',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Decode JSON string to payload.
   *
   * @param data - JSON string to decode
   * @returns Decoded WRFCoin payload
   * @throws PayloadDecodeError if decoding fails
   */
  static decodeJson<T = unknown>(data: string): WrfcoinPayload<T> {
    try {
      const parsed = JSON.parse(data);
      return parsed as WrfcoinPayload<T>;
    } catch (error) {
      throw new PayloadDecodeError(
        'Failed to decode JSON payload',
        error instanceof Error ? error : undefined
      );
    }
  }

  // ==========================================================================
  // Base64 Encoding/Decoding
  // ==========================================================================

  /**
   * Encode payload to Base64 string.
   * First encodes to JSON, then to Base64.
   *
   * @param payload - WRFCoin payload to encode
   * @returns Base64-encoded string
   * @throws PayloadEncodeError if encoding fails
   */
  static encodeBase64<T>(payload: WrfcoinPayload<T>): string {
    try {
      const json = this.encodeJson(payload);
      return Buffer.from(json, 'utf-8').toString('base64');
    } catch (error) {
      if (error instanceof PayloadEncodeError) {
        throw error;
      }
      throw new PayloadEncodeError(
        'Failed to encode payload to Base64',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Decode Base64 string to payload.
   * First decodes from Base64, then parses JSON.
   *
   * @param data - Base64-encoded string to decode
   * @returns Decoded WRFCoin payload
   * @throws PayloadDecodeError if decoding fails
   */
  static decodeBase64<T = unknown>(data: string): WrfcoinPayload<T> {
    try {
      const json = Buffer.from(data, 'base64').toString('utf-8');
      return this.decodeJson<T>(json);
    } catch (error) {
      if (error instanceof PayloadDecodeError) {
        throw error;
      }
      throw new PayloadDecodeError(
        'Failed to decode Base64 payload',
        error instanceof Error ? error : undefined
      );
    }
  }

  // ==========================================================================
  // CBOR Encoding/Decoding
  // ==========================================================================

  /**
   * Encode payload to CBOR binary format.
   * More compact than JSON for bandwidth-constrained LoRa transmission.
   *
   * @param payload - WRFCoin payload to encode
   * @returns CBOR-encoded Buffer
   * @throws PayloadEncodeError if encoding fails
   */
  static encodeCbor<T>(payload: WrfcoinPayload<T>): Buffer {
    try {
      return Buffer.from(cborEncode(payload));
    } catch (error) {
      throw new PayloadEncodeError(
        'Failed to encode payload to CBOR',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Decode CBOR binary to payload.
   *
   * @param data - CBOR-encoded Buffer or Uint8Array to decode
   * @returns Decoded WRFCoin payload
   * @throws PayloadDecodeError if decoding fails
   */
  static decodeCbor<T = unknown>(data: Buffer | Uint8Array): WrfcoinPayload<T> {
    try {
      return cborDecode(data) as WrfcoinPayload<T>;
    } catch (error) {
      throw new PayloadDecodeError(
        'Failed to decode CBOR payload',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Encode payload to CBOR, then to Base64 string.
   * Combines CBOR compactness with text-safe Base64 encoding.
   *
   * @param payload - WRFCoin payload to encode
   * @returns Base64-encoded CBOR string
   * @throws PayloadEncodeError if encoding fails
   */
  static encodeCborBase64<T>(payload: WrfcoinPayload<T>): string {
    try {
      const cbor = this.encodeCbor(payload);
      return cbor.toString('base64');
    } catch (error) {
      if (error instanceof PayloadEncodeError) {
        throw error;
      }
      throw new PayloadEncodeError(
        'Failed to encode payload to CBOR Base64',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Decode Base64-encoded CBOR to payload.
   *
   * @param data - Base64-encoded CBOR string to decode
   * @returns Decoded WRFCoin payload
   * @throws PayloadDecodeError if decoding fails
   */
  static decodeCborBase64<T = unknown>(data: string): WrfcoinPayload<T> {
    try {
      const buffer = Buffer.from(data, 'base64');
      return this.decodeCbor<T>(buffer);
    } catch (error) {
      if (error instanceof PayloadDecodeError) {
        throw error;
      }
      throw new PayloadDecodeError(
        'Failed to decode CBOR Base64 payload',
        error instanceof Error ? error : undefined
      );
    }
  }

  // ==========================================================================
  // Type Guards and Validation
  // ==========================================================================

  /**
   * Check if data is a WRFCoin payload (basic structure check).
   *
   * @param data - Unknown data to check
   * @returns True if data has WRFCoin payload structure
   */
  static isWrfcoinPayload(data: unknown): data is WrfcoinPayload {
    if (typeof data !== 'object' || data === null) {
      return false;
    }

    const obj = data as Record<string, unknown>;
    return (
      obj.t === this.TYPE_MARKER &&
      typeof obj.v === 'number' &&
      typeof obj.kind === 'string' &&
      ['obs', 'reg', 'tx', 'ping'].includes(obj.kind) &&
      typeof obj.body === 'object' &&
      obj.body !== null
    );
  }

  /**
   * Validate payload against Zod schema.
   * Uses discriminated union to validate based on 'kind' field.
   *
   * @param payload - Payload to validate
   * @returns Validation result with errors if any
   */
  static validatePayload(payload: unknown): ValidationResult {
    // First check basic structure
    const baseResult = wrfcoinPayloadBaseSchema.safeParse(payload);
    if (!baseResult.success) {
      return {
        valid: false,
        errors: baseResult.error.issues.map((e) => ({
          field: e.path.join('.'),
          message: e.message,
          code: e.code,
        })),
      };
    }

    // Then validate with full schema (includes body validation)
    const fullResult = wrfcoinPayloadSchema.safeParse(payload);
    if (!fullResult.success) {
      return {
        valid: false,
        errors: fullResult.error.issues.map((e) => ({
          field: e.path.join('.'),
          message: e.message,
          code: e.code,
        })),
      };
    }

    return { valid: true };
  }

  /**
   * Validate observation body against Zod schema.
   *
   * @param body - Observation body to validate
   * @returns Validation result with errors if any
   */
  static validateObsBody(body: unknown): ValidationResult {
    const result = obsBodySchema.safeParse(body);
    if (!result.success) {
      return {
        valid: false,
        errors: result.error.issues.map((e) => ({
          field: e.path.join('.'),
          message: e.message,
          code: e.code,
        })),
      };
    }
    return { valid: true };
  }

  /**
   * Validate body based on kind.
   *
   * @param kind - Payload kind
   * @param body - Body to validate
   * @returns Validation result with errors if any
   */
  static validateBody(kind: PayloadKind, body: unknown): ValidationResult {
    const schemaMap = {
      obs: obsBodySchema,
      reg: regBodySchema,
      tx: txBodySchema,
      ping: pingBodySchema,
    };

    const schema = schemaMap[kind];
    if (!schema) {
      return {
        valid: false,
        errors: [{ field: 'kind', message: `Unknown payload kind: ${kind}` }],
      };
    }

    const result = schema.safeParse(body);
    if (!result.success) {
      return {
        valid: false,
        errors: result.error.issues.map((e) => ({
          field: e.path.join('.'),
          message: e.message,
          code: e.code,
        })),
      };
    }
    return { valid: true };
  }

  // ==========================================================================
  // Factory Methods
  // ==========================================================================

  /**
   * Create a WRFCoin observation payload.
   *
   * @param body - Observation body
   * @param version - Schema version (default: current version)
   * @returns WRFCoin observation payload
   */
  static createObsPayload(body: ObsBody, version = this.SCHEMA_VERSION): WrfcoinPayload<ObsBody> {
    return {
      t: this.TYPE_MARKER,
      v: version,
      kind: 'obs',
      body,
    };
  }

  /**
   * Create a WRFCoin ping payload.
   *
   * @param ts - Unix timestamp (default: current time)
   * @param seq - Sequence number (optional)
   * @returns WRFCoin ping payload
   */
  static createPingPayload(
    ts = Math.floor(Date.now() / 1000),
    seq?: number
  ): WrfcoinPayload<{ ts: number; seq?: number }> {
    return {
      t: this.TYPE_MARKER,
      v: this.SCHEMA_VERSION,
      kind: 'ping',
      body: seq !== undefined ? { ts, seq } : { ts },
    };
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Estimate payload size in bytes for different encodings.
   *
   * @param payload - Payload to estimate
   * @returns Size estimates for each encoding format
   */
  static estimateSize<T>(payload: WrfcoinPayload<T>): {
    json: number;
    jsonBase64: number;
    cbor: number;
    cborBase64: number;
  } {
    const json = this.encodeJson(payload);
    const cbor = this.encodeCbor(payload);

    return {
      json: Buffer.byteLength(json, 'utf-8'),
      jsonBase64: Buffer.byteLength(Buffer.from(json).toString('base64')),
      cbor: cbor.length,
      cborBase64: Buffer.byteLength(cbor.toString('base64')),
    };
  }

  /**
   * Auto-detect and decode payload from string.
   * Tries to detect format (JSON, Base64-JSON, or Base64-CBOR).
   *
   * @param data - String data to decode
   * @returns Decoded payload and detected format
   * @throws PayloadDecodeError if all decode attempts fail
   */
  static autoDecode<T = unknown>(data: string): {
    payload: WrfcoinPayload<T>;
    format: 'json' | 'base64-json' | 'base64-cbor';
  } {
    // Try JSON first (if starts with '{')
    if (data.trim().startsWith('{')) {
      try {
        const payload = this.decodeJson<T>(data);
        if (this.isWrfcoinPayload(payload)) {
          return { payload, format: 'json' };
        }
      } catch {
        // Not JSON, continue to next format
      }
    }

    // Try Base64-JSON
    try {
      const payload = this.decodeBase64<T>(data);
      if (this.isWrfcoinPayload(payload)) {
        return { payload, format: 'base64-json' };
      }
    } catch {
      // Not Base64-JSON, continue
    }

    // Try Base64-CBOR
    try {
      const payload = this.decodeCborBase64<T>(data);
      if (this.isWrfcoinPayload(payload)) {
        return { payload, format: 'base64-cbor' };
      }
    } catch {
      // Not Base64-CBOR
    }

    throw new PayloadDecodeError(
      'Failed to auto-decode payload: unknown format. Expected JSON, Base64-JSON, or Base64-CBOR.'
    );
  }
}
