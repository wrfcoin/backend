import { sql } from 'drizzle-orm';

export const GEO_FENCE_WINDOW_MS = 10 * 60 * 1000;
export const GEO_FENCE_BURST_THRESHOLD = 2;
export const GEO_FENCE_GRID_PRECISION = 6;

const GEOHASH_ALPHABET = '0123456789bcdefghjkmnpqrstuvwxyz';

export type GeoFenceIntegrationType = 'meshtastic' | 'iotex';
export type GeoFenceReviewStatus =
  | 'clear'
  | 'manual_review_required'
  | 'approved'
  | 'rejected';

export interface GeoFenceLocation {
  lat: number;
  lon: number;
  alt?: number;
}

export interface GeoFenceDecision {
  status: GeoFenceReviewStatus;
  gridKey: string | null;
  reason: 'geo_burst_detected' | 'location_required' | null;
  burstCount: number;
  windowStartedAt: string | null;
  triggeredAt: string | null;
}

type SqlExecutor = {
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
};

export function encodeGeoFenceGrid(
  location: GeoFenceLocation,
  precision: number = GEO_FENCE_GRID_PRECISION,
): string {
  let minLat = -90;
  let maxLat = 90;
  let minLon = -180;
  let maxLon = 180;
  let bit = 0;
  let ch = 0;
  let isLon = true;
  let hash = '';

  while (hash.length < precision) {
    if (isLon) {
      const mid = (minLon + maxLon) / 2;
      if (location.lon >= mid) {
        ch = (ch << 1) | 1;
        minLon = mid;
      } else {
        ch <<= 1;
        maxLon = mid;
      }
    } else {
      const mid = (minLat + maxLat) / 2;
      if (location.lat >= mid) {
        ch = (ch << 1) | 1;
        minLat = mid;
      } else {
        ch <<= 1;
        maxLat = mid;
      }
    }

    isLon = !isLon;
    bit += 1;

    if (bit === 5) {
      hash += GEOHASH_ALPHABET[ch];
      bit = 0;
      ch = 0;
    }
  }

  return hash;
}

export function isGeoFenceLocation(value: unknown): value is GeoFenceLocation {
  return (
    typeof value === 'object' &&
    value !== null &&
    Number.isFinite((value as GeoFenceLocation).lat) &&
    Number.isFinite((value as GeoFenceLocation).lon)
  );
}

export function requiresManualReview(status?: string | null): boolean {
  return status === 'manual_review_required' || status === 'rejected';
}

export function isRewardEligibleForGeoFence(status?: string | null): boolean {
  return status === undefined || status === null || status === 'clear' || status === 'approved';
}

export function buildGeoFenceReviewUpdate(
  decision: GeoFenceDecision,
): {
  geoFenceGrid: string | null;
  geoFenceStatus: GeoFenceReviewStatus;
  geoFenceReason: string | null;
  geoFenceBurstCount: number;
  geoFenceWindowStartedAt: Date | null;
  geoFenceTriggeredAt: Date | null;
} {
  return {
    geoFenceGrid: decision.gridKey,
    geoFenceStatus: decision.status,
    geoFenceReason: decision.reason,
    geoFenceBurstCount: decision.burstCount,
    geoFenceWindowStartedAt: decision.windowStartedAt ? new Date(decision.windowStartedAt) : null,
    geoFenceTriggeredAt: decision.triggeredAt ? new Date(decision.triggeredAt) : null,
  };
}

function rowsOf(result: unknown): unknown[] {
  return Array.isArray(result)
    ? result
    : (result as { rows?: unknown[] } | null | undefined)?.rows || [];
}

export class IotGatewayGeoFenceService {
  // meshtastic_nodes is created outside drizzle/migrations (only 0006 alters it,
  // IF EXISTS), so a database can lack it; an absent source then contributes
  // no identities instead of failing every registration (backend#1171).
  // Only a positive answer is cached: the table can appear later, never vanish.
  private meshtasticNodesPresent = false;

  constructor(
    private readonly db: SqlExecutor,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async hasMeshtasticNodes(): Promise<boolean> {
    if (this.meshtasticNodesPresent) return true;
    const result = await this.db.execute(
      sql`SELECT to_regclass('public.meshtastic_nodes') IS NOT NULL AS present`,
    );
    const present = (rowsOf(result)[0] as Record<string, unknown> | undefined)?.present === true;
    this.meshtasticNodesPresent = present;
    return present;
  }

  async evaluateNewIdentity(params: {
    integrationType: GeoFenceIntegrationType;
    subjectId: string;
    location?: GeoFenceLocation | null;
    existingGridKey?: string | null;
    occurredAt?: Date;
  }): Promise<GeoFenceDecision> {
    const occurredAt = params.occurredAt ?? this.now();
    const windowStart = new Date(occurredAt.getTime() - GEO_FENCE_WINDOW_MS);
    const gridKey = params.existingGridKey || (params.location ? encodeGeoFenceGrid(params.location) : null);

    if (!gridKey) {
      return {
        status: 'manual_review_required',
        gridKey: null,
        reason: 'location_required',
        burstCount: 0,
        windowStartedAt: windowStart.toISOString(),
        triggeredAt: occurredAt.toISOString(),
      };
    }

    // postgres-js (the live driver) rejects a Date bound in a raw sql template
    // ("argument must be of type string ... Received an instance of Date"), so
    // every registration failed against a real database (backend#1171).
    const windowStartParam = windowStart.toISOString();

    const meshtasticIdentities = (await this.hasMeshtasticNodes())
      ? sql`
        SELECT
          'meshtastic'::text AS source_type,
          meshtastic_node_id AS subject_id
        FROM meshtastic_nodes
        WHERE geo_fence_grid = ${gridKey}
          AND COALESCE(registered_at, created_at) >= ${windowStartParam}::timestamptz

        UNION ALL
`
      : sql.empty();

    const result = await this.db.execute(sql`
      WITH recent_identities AS (${meshtasticIdentities}
        SELECT
          'iotex'::text AS source_type,
          id AS subject_id
        FROM iotex_devices
        WHERE geo_fence_grid = ${gridKey}
          AND created_at >= ${windowStartParam}::timestamptz
      )
      SELECT COUNT(*)::int AS hit_count
      FROM recent_identities
      WHERE NOT (
        source_type = ${params.integrationType}
        AND subject_id = ${params.subjectId}
      )
    `);

    const hitCount = Number(
      ((rowsOf(result)[0] as Record<string, unknown> | undefined)?.hit_count ?? 0),
    );
    const burstCount = hitCount + 1;
    const isBurst = burstCount >= GEO_FENCE_BURST_THRESHOLD;

    return {
      status: isBurst ? 'manual_review_required' : 'clear',
      gridKey,
      reason: isBurst ? 'geo_burst_detected' : null,
      burstCount,
      windowStartedAt: windowStart.toISOString(),
      triggeredAt: isBurst ? occurredAt.toISOString() : null,
    };
  }
}
