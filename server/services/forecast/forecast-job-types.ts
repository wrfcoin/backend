export type ForecastJobStatus =
  | 'queued'
  | 'preparing_inputs'
  | 'running_wps'
  | 'running_wrf'
  | 'postprocessing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ForecastDomainBounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

export interface ForecastJobRequest {
  model: string;
  domainBounds: ForecastDomainBounds;
  resolutionKm: number;
  physicsOptions: Record<string, unknown>;
  forecastHours: number;
  datasets: string[];
  computeEnvironment: string;
  validation: string;
  requestedBy?: string;
}

export interface ForecastArtifact {
  outputCid: string;
  netcdfFiles: string[];
  storageProvider: string;
}

export interface ForecastJobHistoryItem {
  status: ForecastJobStatus;
  timestamp: string;
  note: string;
}

export interface ForecastJobRecord {
  jobId: string;
  status: ForecastJobStatus;
  progress: number;
  request: ForecastJobRequest;
  submittedAt: string;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  outputCid?: string;
  error?: string;
  history: ForecastJobHistoryItem[];
  orchestration: {
    gfsSource: string;
    wpsContainerImage: string;
    wrfContainerImage: string;
    resourceLimits: {
      cpu: number;
      memoryGb: number;
    };
  };
}

export interface GfsFetchResult {
  source: string;
  fetchedFiles: string[];
}

export interface WpsResult {
  metadataPath: string;
}

export interface WrfResult {
  netcdfFiles: string[];
}
