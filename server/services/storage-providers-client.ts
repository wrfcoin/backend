/**
 * StorageProvidersClient
 *
 * HTTP client for the storage-providers node REST API (wrfcoin/storage-providers).
 * Calls the cost estimator and analytics endpoints added in PR #63 (commit 57b756b).
 *
 * Environment variables:
 *   WRFCOIN_STORAGE_NODE_URL  - Base URL of the storage node (default: http://storage-node:7001)
 *
 * Endpoints consumed:
 *   GET /health
 *   GET /api/cost/estimate?size_bytes=N&duration_secs=N
 *   GET /api/cost/cheapest?size_bytes=N&duration_secs=N[&max_budget=N]
 *   GET /api/analytics/snapshot
 *   POST /api/store (IPFS-only JSON/base64 upload)
 *   GET /api/retrieve/ipfs:CID (raw bytes)
 */

import axios, { type AxiosInstance } from 'axios';
import { logger } from '../../utils/logger.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const STORAGE_NODE_URL =
  process.env.WRFCOIN_STORAGE_NODE_URL ?? 'http://storage-node:7001';

/** Default HTTP timeout for storage node calls (ms). */
const REQUEST_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Response types (mirror the Rust structs in wrfcoin-storage-providers)
// ---------------------------------------------------------------------------

export interface CostEstimate {
  provider: string;
  one_time_cost: number;
  recurring_cost_per_day: number;
  total_cost: number;
  /** e.g. "USD", "FIL", "AR", "free" */
  currency: string;
}

export interface CostEstimateResponse {
  size_bytes: number;
  duration_secs: number;
  /** Providers sorted cheapest-first by total_cost (same-currency comparisons only). */
  estimates: CostEstimate[];
  /** Unix timestamp (seconds) when the response was generated. */
  timestamp: number;
}

export interface CheapestProviderResponse {
  size_bytes: number;
  duration_secs: number;
  cheapest: CostEstimate;
}

export interface ProviderSnapshot {
  name: string;
  healthy: boolean;
  objects_stored: number;
  bytes_stored: number;
  avg_retrieval_latency_ms: number;
  error_rate: number;
  cost_to_date: number;
}

export interface TierSnapshot {
  tier: string;
  bytes_stored: number;
  cost_to_date: number;
  budget_remaining: number;
}

export interface DomainSnapshot {
  domain: string;
  object_count: number;
}

export interface BudgetSnapshot {
  total_spent: number;
  total_budget: number | null;
  budget_remaining: number | null;
  over_budget: boolean;
}

export interface SlaSnapshot {
  report_class: string;
  status: string;
  compliance_rate: number;
}

export interface FailoverSnapshot {
  total_failovers: number;
  successful_failovers: number;
  failed_failovers: number;
}

export interface StorageSnapshot {
  timestamp: number;
  providers: ProviderSnapshot[];
  tiers: TierSnapshot[];
  domains: DomainSnapshot[];
  budget: BudgetSnapshot;
  sla_compliance: SlaSnapshot[];
  failover: FailoverSnapshot;
}

export interface StorageNodeHealth {
  status: string;
  [key: string]: unknown;
}

export interface StoredIpfsContent {
  content_id: { provider: 'ipfs'; hash: string };
  provider: 'ipfs';
  timestamp: number;
  size: number;
}

export class StorageUnavailableError extends Error {
  readonly code = 'STORAGE_UNAVAILABLE';
  constructor() {
    super('IPFS storage is unavailable');
    this.name = 'StorageUnavailableError';
  }
}

/** Kubo's SHA-256 dag-pb/raw CIDs (CIDv0 base58 or CIDv1 base32). */
function isIpfsCid(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(value)) {
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let encoded = 0n;
    for (const char of value) encoded = encoded * 58n + BigInt(alphabet.indexOf(char));
    const hex = encoded.toString(16);
    const decoded = Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex');
    return decoded.length === 34 && decoded[0] === 0x12 && decoded[1] === 0x20;
  }
  if (!/^b[a-z2-7]{58}$/.test(value)) return false;
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  const decoded: number[] = [];
  let bits = 0, accumulator = 0;
  for (const char of value.slice(1)) {
    accumulator = (accumulator << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      decoded.push((accumulator >> bits) & 255);
      accumulator &= (1 << bits) - 1;
    }
  }
  return accumulator === 0 && decoded.length === 36 && decoded[0] === 1 &&
    [0x55, 0x70].includes(decoded[1]) && decoded[2] === 0x12 && decoded[3] === 0x20;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class StorageProvidersClient {
  private readonly http: AxiosInstance;
  private readonly baseUrl: string;

  constructor(baseUrl: string = STORAGE_NODE_URL) {
    this.baseUrl = baseUrl;
    this.http = axios.create({
      baseURL: baseUrl,
      timeout: REQUEST_TIMEOUT_MS,
      headers: { Accept: 'application/json' },
    });
  }

  /** Upload bytes to the self-hosted IPFS provider; only an acknowledged receipt is returned. */
  async storeIpfs(
    bytes: Buffer,
    contentType = 'application/json',
    tags: Record<string, string> = {},
  ): Promise<StoredIpfsContent> {
    try {
      const { status, data } = await this.http.post<StoredIpfsContent>('/api/store', {
        data: bytes.toString('base64'), content_type: contentType, provider: 'ipfs', tags,
      }, { maxRedirects: 0 });
      if (status !== 201 || data?.provider !== 'ipfs' ||
          data?.content_id?.provider !== 'ipfs' || !isIpfsCid(data?.content_id?.hash) ||
          data.size !== bytes.length || !Number.isSafeInteger(data.timestamp) || data.timestamp < 0) {
        throw new StorageUnavailableError();
      }
      return data;
    } catch {
      // No exception text, upstream response or invented receipt reaches callers.
      throw new StorageUnavailableError();
    }
  }

  /** Retrieve raw IPFS bytes; failures remain unavailable rather than empty content. */
  async retrieveIpfs(cid: string): Promise<Buffer> {
    if (!isIpfsCid(cid)) throw new TypeError('Invalid IPFS CID');
    try {
      const { status, data } = await this.http.get<ArrayBuffer>(
        `/api/retrieve/${encodeURIComponent(`ipfs:${cid}`)}`,
        { responseType: 'arraybuffer', maxRedirects: 0 },
      );
      if (status !== 200) throw new StorageUnavailableError();
      return Buffer.from(data);
    } catch {
      throw new StorageUnavailableError();
    }
  }

  /**
   * Check that the storage node is reachable and healthy.
   *
   * Maps to `GET /health`.
   *
   * @returns The parsed health response from the node.
   * @throws if the node is unreachable or returns a non-2xx status.
   */
  async checkHealth(): Promise<StorageNodeHealth> {
    logger.debug('[StorageProvidersClient] GET /health', { baseUrl: this.baseUrl });
    const { data } = await this.http.get<StorageNodeHealth>('/health');
    return data;
  }

  /**
   * Retrieve cost estimates for all configured providers, sorted cheapest-first.
   *
   * Maps to `GET /api/cost/estimate?size_bytes=N&duration_secs=N`.
   *
   * @param sizeBytes    Payload size in bytes.
   * @param durationSecs Storage duration in seconds (default: 86400 = 1 day).
   */
  async estimateCost(
    sizeBytes: number,
    durationSecs = 86_400,
  ): Promise<CostEstimateResponse> {
    logger.debug('[StorageProvidersClient] estimateCost', { sizeBytes, durationSecs });
    const { data } = await this.http.get<CostEstimateResponse>(
      '/api/cost/estimate',
      { params: { size_bytes: sizeBytes, duration_secs: durationSecs } },
    );
    return data;
  }

  /**
   * Return the cheapest healthy provider for the requested payload, subject to
   * an optional maximum-budget ceiling.
   *
   * Maps to `GET /api/cost/cheapest?size_bytes=N&duration_secs=N[&max_budget=N]`.
   *
   * @param sizeBytes    Payload size in bytes.
   * @param durationSecs Storage duration in seconds (default: 86400 = 1 day).
   * @param maxBudget    Optional maximum total cost (in the estimate's currency).
   *                     Pass `undefined` to skip the budget filter.
   * @returns            The cheapest provider estimate, or `null` when no
   *                     provider satisfies the constraints.
   */
  async cheapestProvider(
    sizeBytes: number,
    durationSecs = 86_400,
    maxBudget?: number,
  ): Promise<CheapestProviderResponse | null> {
    logger.debug('[StorageProvidersClient] cheapestProvider', {
      sizeBytes,
      durationSecs,
      maxBudget,
    });
    try {
      const params: Record<string, unknown> = {
        size_bytes: sizeBytes,
        duration_secs: durationSecs,
      };
      if (maxBudget !== undefined) {
        params.max_budget = maxBudget;
      }
      const { data } = await this.http.get<CheapestProviderResponse>(
        '/api/cost/cheapest',
        { params },
      );
      return data;
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        // Storage node returns 404 when no provider passes health + budget constraints.
        logger.warn('[StorageProvidersClient] no healthy provider within budget', {
          sizeBytes,
          durationSecs,
          maxBudget,
        });
        return null;
      }
      throw err;
    }
  }

  /**
   * Build and return a full analytics snapshot from the storage node.
   * The node also appends the snapshot to its 60-entry ring-buffer on each call.
   *
   * Maps to `GET /api/analytics/snapshot`.
   */
  async analyticsSnapshot(): Promise<StorageSnapshot> {
    logger.debug('[StorageProvidersClient] analyticsSnapshot');
    const { data } = await this.http.get<StorageSnapshot>('/api/analytics/snapshot');
    return data;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const storageProvidersClient = new StorageProvidersClient();
