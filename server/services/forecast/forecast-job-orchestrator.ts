import { createHash, randomUUID } from 'crypto';
import {
  ForecastArtifact,
  ForecastDomainBounds,
  ForecastJobRecord,
  ForecastJobRequest,
  ForecastJobStatus,
  GfsFetchResult,
  WpsResult,
  WrfResult,
} from './forecast-job-types.js';

type TimerHandle = ReturnType<typeof setTimeout>;

interface ForecastExecutionAdapters {
  fetchGfsData: (request: ForecastJobRequest) => Promise<GfsFetchResult>;
  runWps: (request: ForecastJobRequest, gfs: GfsFetchResult) => Promise<WpsResult>;
  runWrf: (request: ForecastJobRequest, wps: WpsResult) => Promise<WrfResult>;
  storeArtifacts: (request: ForecastJobRequest, wrf: WrfResult) => Promise<ForecastArtifact>;
}

export interface ForecastJobOrchestratorOptions {
  scheduler?: (fn: () => void, delayMs: number) => TimerHandle;
  adapters?: Partial<ForecastExecutionAdapters>;
  maxJobs?: number;
  retentionMs?: number;
}

const DEFAULT_DOMAIN_BOUNDS: ForecastDomainBounds = {
  north: 49,
  south: 25,
  west: -125,
  east: -66,
};

const DEFAULT_ADAPTERS: ForecastExecutionAdapters = {
  async fetchGfsData(request: ForecastJobRequest) {
    const dateTag = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const hours = Array.from({ length: Math.max(1, Math.ceil(request.forecastHours / 6)) }).map(
      (_, index) => index * 6
    );
    return {
      source: 'noaa-nomads',
      fetchedFiles: hours.map(hour => `gfs.${dateTag}.f${String(hour).padStart(3, '0')}.grib2`),
    };
  },

  async runWps(_request: ForecastJobRequest, gfs: GfsFetchResult) {
    return {
      metadataPath: `/tmp/wps_${createHash('sha256').update(gfs.fetchedFiles.join('|')).digest('hex').slice(0, 12)}.json`,
    };
  },

  async runWrf(request: ForecastJobRequest, _wps: WpsResult) {
    return {
      netcdfFiles: [
        `wrfout_d01_${request.forecastHours}h_${Date.now()}.nc`,
      ],
    };
  },

  async storeArtifacts(request: ForecastJobRequest, wrf: WrfResult) {
    const cidPayload = JSON.stringify({
      model: request.model,
      forecastHours: request.forecastHours,
      files: wrf.netcdfFiles,
      domain: request.domainBounds,
    });
    const digest = createHash('sha256').update(cidPayload).digest('hex');
    return {
      outputCid: `bafy${digest.slice(0, 48)}`,
      netcdfFiles: wrf.netcdfFiles,
      storageProvider: 'ipfs-adapter-compatible',
    };
  },
};

export class ForecastJobOrchestrator {
  private readonly jobs: Map<string, ForecastJobRecord>;
  private readonly scheduler: (fn: () => void, delayMs: number) => TimerHandle;
  private readonly adapters: ForecastExecutionAdapters;
  private readonly maxJobs: number;
  private readonly retentionMs: number;

  constructor(options: ForecastJobOrchestratorOptions = {}) {
    this.jobs = new Map();
    this.scheduler = options.scheduler ?? ((fn, delayMs) => setTimeout(fn, delayMs));
    this.adapters = {
      ...DEFAULT_ADAPTERS,
      ...(options.adapters || {}),
    };
    this.maxJobs = options.maxJobs ?? 500;
    this.retentionMs = options.retentionMs ?? 24 * 60 * 60 * 1000;
  }

  submitJob(payload: Record<string, unknown>): ForecastJobRecord {
    this.pruneJobs();
    if (this.jobs.size >= this.maxJobs) {
      throw new Error('Forecast queue capacity reached. Please retry later.');
    }

    const request = normalizeForecastJobRequest(payload);
    const validationErrors = validateForecastJobRequest(request);
    if (validationErrors.length > 0) {
      throw new Error(`Invalid forecast job request: ${validationErrors.join('; ')}`);
    }

    const jobId = `forecast_job_${randomUUID()}`;
    const submittedAt = new Date().toISOString();
    const record: ForecastJobRecord = {
      jobId,
      status: 'queued',
      progress: 0,
      request,
      submittedAt,
      history: [
        {
          status: 'queued',
          timestamp: submittedAt,
          note: 'Job accepted and queued for forecast execution.',
        },
      ],
      orchestration: {
        gfsSource: 'noaa-nomads',
        wpsContainerImage: process.env.WRF_WPS_CONTAINER_IMAGE || 'wrfcoin/wrf-wps:latest',
        wrfContainerImage: process.env.WRF_CONTAINER_IMAGE || 'wrfcoin/wrf:latest',
        resourceLimits: {
          cpu: Number.parseInt(process.env.WRF_MAX_CPU || '4', 10),
          memoryGb: Number.parseInt(process.env.WRF_MAX_MEMORY_GB || '16', 10),
        },
      },
    };

    this.jobs.set(jobId, record);
    this.runPipeline(jobId).catch(error => {
      this.failJob(jobId, error instanceof Error ? error.message : 'Unknown execution error');
    });
    return cloneJobRecord(record);
  }

  getJob(jobId: string): ForecastJobRecord | null {
    const job = this.jobs.get(jobId);
    return job ? cloneJobRecord(job) : null;
  }

  jobCount(): number {
    return this.jobs.size;
  }

  listJobs(limit = 50): ForecastJobRecord[] {
    this.pruneJobs();
    return Array.from(this.jobs.values())
      .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
      .slice(0, limit)
      .map(cloneJobRecord);
  }

  cancelJob(jobId: string): ForecastJobRecord | null {
    const job = this.jobs.get(jobId);
    if (!job) {
      return null;
    }

    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      return cloneJobRecord(job);
    }

    job.status = 'cancelled';
    job.progress = Math.min(job.progress, 99);
    job.completedAt = new Date().toISOString();
    job.history.push({
      status: 'cancelled',
      timestamp: job.completedAt,
      note: 'Job cancelled by requester.',
    });
    return cloneJobRecord(job);
  }

  private async runPipeline(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) {
      return;
    }

    job.startedAt = new Date().toISOString();
    await this.transition(jobId, 'preparing_inputs', 15, 'Downloading NOAA GFS initial/boundary conditions.');
    const request = this.getJobOrThrow(jobId).request;
    const gfs = await this.adapters.fetchGfsData(request);

    await this.transition(jobId, 'running_wps', 40, `Running WPS (geogrid/ungrib/metgrid) with ${gfs.fetchedFiles.length} file(s).`);
    const wps = await this.adapters.runWps(request, gfs);

    await this.transition(jobId, 'running_wrf', 75, `Running WRF-ARW solver using ${wps.metadataPath}.`);
    const wrf = await this.adapters.runWrf(request, wps);

    await this.transition(jobId, 'postprocessing', 90, 'Post-processing NetCDF outputs and preparing artifact storage.');
    const artifacts = await this.adapters.storeArtifacts(request, wrf);

    const completed = this.getJobOrThrow(jobId);
    completed.status = 'completed';
    completed.progress = 100;
    completed.completedAt = new Date().toISOString();
    completed.outputCid = artifacts.outputCid;
    completed.history.push({
      status: 'completed',
      timestamp: completed.completedAt,
      note: `Forecast run finished. Stored ${artifacts.netcdfFiles.length} NetCDF file(s) to ${artifacts.storageProvider}.`,
    });
  }

  private async transition(
    jobId: string,
    nextStatus: ForecastJobStatus,
    progress: number,
    note: string
  ): Promise<void> {
    await this.delay(20);
    const job = this.getJobOrThrow(jobId);
    if (job.status === 'cancelled') {
      throw new Error('Job execution cancelled');
    }
    job.status = nextStatus;
    job.progress = progress;
    job.history.push({
      status: nextStatus,
      timestamp: new Date().toISOString(),
      note,
    });
  }

  private failJob(jobId: string, reason: string): void {
    const job = this.jobs.get(jobId);
    if (!job || job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      return;
    }

    job.status = 'failed';
    job.failedAt = new Date().toISOString();
    job.error = reason;
    job.history.push({
      status: 'failed',
      timestamp: job.failedAt,
      note: reason,
    });
  }

  private delay(delayMs: number): Promise<void> {
    return new Promise(resolve => {
      this.scheduler(resolve, delayMs);
    });
  }

  private getJobOrThrow(jobId: string): ForecastJobRecord {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Forecast job ${jobId} not found`);
    }
    return job;
  }

  private pruneJobs(): void {
    const now = Date.now();
    for (const [jobId, job] of this.jobs.entries()) {
      const terminal =
        job.status === 'completed' ||
        job.status === 'failed' ||
        job.status === 'cancelled';
      const endedAt = job.completedAt || job.failedAt;
      if (terminal && endedAt) {
        const ageMs = now - new Date(endedAt).getTime();
        if (ageMs > this.retentionMs) {
          this.jobs.delete(jobId);
        }
      }
    }
  }
}

export function normalizeForecastJobRequest(payload: Record<string, unknown>): ForecastJobRequest {
  const recipe = toObject(payload.recipe) || {};
  const domainFromPayload = toObject(payload.domainBounds);
  const domainFromRecipe = toObject(recipe.domainBounds);

  const domainBounds = normalizeDomainBounds(domainFromPayload || domainFromRecipe || payload);

  const model = stringWithDefault(payload.model, stringWithDefault(recipe.model, 'WRF'));
  const resolutionKm = numberWithDefault(payload.resolutionKm, numberWithDefault(recipe.resolutionKm, 10));
  const forecastHours = numberWithDefault(payload.forecastHours, numberWithDefault(recipe.forecastHours, 12));
  const physicsOptions = toObject(payload.physicsOptions) || toObject(recipe.physicsOptions) || {};
  const datasets = normalizeStringArray(payload.datasets, recipe.datasets);

  return {
    model,
    domainBounds,
    resolutionKm,
    physicsOptions,
    forecastHours,
    datasets,
    computeEnvironment: stringWithDefault(payload.computeEnvironment, stringWithDefault(recipe.computeEnvironment, 'local-wrf')),
    validation: stringWithDefault(payload.validation, stringWithDefault(recipe.validation, 'standard')),
    requestedBy: typeof payload.requestedBy === 'string' ? payload.requestedBy : undefined,
  };
}

export function validateForecastJobRequest(request: ForecastJobRequest): string[] {
  const errors: string[] = [];
  if (!request.model) {
    errors.push('model is required');
  }

  if (request.resolutionKm <= 0) {
    errors.push('resolutionKm must be greater than 0');
  }

  if (request.forecastHours <= 0 || request.forecastHours > 240) {
    errors.push('forecastHours must be between 1 and 240');
  }

  const { north, south, east, west } = request.domainBounds;
  if (north < -90 || north > 90 || south < -90 || south > 90) {
    errors.push('domainBounds latitude values must be between -90 and 90');
  }
  if (east < -180 || east > 180 || west < -180 || west > 180) {
    errors.push('domainBounds longitude values must be between -180 and 180');
  }
  if (north <= south) {
    errors.push('domainBounds.north must be greater than domainBounds.south');
  }
  if (east <= west) {
    errors.push('domainBounds.east must be greater than domainBounds.west');
  }

  return errors;
}

function normalizeDomainBounds(
  payload: Record<string, unknown> | null
): ForecastDomainBounds {
  if (!payload) {
    return { ...DEFAULT_DOMAIN_BOUNDS };
  }

  const north = numberWithDefault(payload.north, DEFAULT_DOMAIN_BOUNDS.north);
  const south = numberWithDefault(payload.south, DEFAULT_DOMAIN_BOUNDS.south);
  const east = numberWithDefault(payload.east, DEFAULT_DOMAIN_BOUNDS.east);
  const west = numberWithDefault(payload.west, DEFAULT_DOMAIN_BOUNDS.west);
  return { north, south, east, west };
}

function numberWithDefault(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function stringWithDefault(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  return fallback;
}

function normalizeStringArray(primary: unknown, secondary: unknown): string[] {
  const source = Array.isArray(primary) ? primary : Array.isArray(secondary) ? secondary : [];
  return source
    .filter(item => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean);
}

function toObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function cloneJobRecord(record: ForecastJobRecord): ForecastJobRecord {
  return JSON.parse(JSON.stringify(record));
}
