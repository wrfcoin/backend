export interface HydrologicalStation {
  siteNumber: string;
  siteName: string;
  latitude: number;
  longitude: number;
  stateCode?: string;
  countyCode?: string;
}

export interface HydrologicalObservation {
  observationId: string;
  dedupeKey: string;
  category: 'Hydrological';
  interval: 'IV' | 'DV';
  observedAt: string;
  ingestedAt: string;
  station: HydrologicalStation;
  metrics: {
    streamflowCfs?: number;
    gageHeightFt?: number;
    waterTemperatureC?: number;
    dissolvedOxygenMgL?: number;
  };
  sourceMetadata: {
    endpoint: string;
    parameterCodes: string[];
    qualifiers?: string[];
  };
}

export interface HydrologicalSiteDiscoveryResult {
  sites: HydrologicalStation[];
  count: number;
}

export interface UsgsHydrologyMetrics {
  ivPollIntervalMs: number;
  dvPollIntervalMs: number;
  ivSuccesses: number;
  ivFailures: number;
  dvSuccesses: number;
  dvFailures: number;
  siteDiscoverySuccesses: number;
  siteDiscoveryFailures: number;
  parseFailures: number;
  recentLatencyMs: number | null;
}
