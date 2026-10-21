export type NrcsNetwork = 'SCAN' | 'SNOTEL';

export type NrcsInterval = 'HOURLY' | 'DAILY';

export interface NrcsSoilStation {
  triplet: string;
  stationId: string;
  stationName: string;
  network: NrcsNetwork;
  latitude: number;
  longitude: number;
  elevationMeters: number;
  stateCode?: string;
  countyName?: string;
}

export interface NrcsEnvironmentalObservation {
  observationId: string;
  dedupeKey: string;
  category: 'Environmental';
  network: NrcsNetwork;
  interval: NrcsInterval;
  observedAt: string;
  ingestedAt: string;
  station: NrcsSoilStation;
  metrics: {
    soilMoisturePct5cm?: number;
    soilMoisturePct10cm?: number;
    soilMoisturePct20cm?: number;
    soilMoisturePct50cm?: number;
    soilTemperatureC?: number;
    precipitationMm?: number;
    snowWaterEquivalentMm?: number;
    snowDepthCm?: number;
    airTemperatureC?: number;
  };
  sourceMetadata: {
    endpoint: string;
    elementCodes: string[];
  };
}

export interface NrcsStationDiscoveryResult {
  stations: NrcsSoilStation[];
  count: number;
}

export interface NrcsSoilMetrics {
  scanPollIntervalMs: number;
  snotelPollIntervalMs: number;
  configuredScanStations: string[];
  configuredSnotelStations: string[];
  scanSuccesses: number;
  scanFailures: number;
  snotelSuccesses: number;
  snotelFailures: number;
  stationMetadataSuccesses: number;
  stationMetadataFailures: number;
  parseFailures: number;
  recentLatencyMs: number | null;
}
