export interface BoundingBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface SatelliteSourceMetadata {
  bucket: string;
  key: string;
  eTag?: string;
  sizeBytes: number;
  lastModified: string;
  sourceUrl: string;
}

export interface SatelliteObservation {
  observationId: string;
  dedupeKey: string;
  sourceType: 'satellite';
  provider: 'NOAA';
  platform: 'GOES-16';
  productFamily: string;
  observationTime: string;
  ingestedAt: string;
  regionTag: 'full_disk' | 'conus' | 'mesoscale' | 'unknown';
  coverageBounds: BoundingBox;
  sourceMetadata: SatelliteSourceMetadata;
  rawMetadata: {
    prefix: string;
    listingTimestamp: string;
  };
}

export interface SatelliteIngestionMetrics {
  pollAttempts: number;
  pollSuccesses: number;
  pollFailures: number;
  backfillAttempts: number;
  backfillSuccesses: number;
  backfillFailures: number;
  parseFailures: number;
  ingestedRecords: number;
  duplicateRecords: number;
  recentLagMs: number | null;
  averageLagMs: number | null;
  pollAverageLagMs: number | null;
  backfillAverageLagMs: number | null;
  successRate: number;
}
