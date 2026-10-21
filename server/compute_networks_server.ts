// OpenTelemetry must be initialized before other imports for auto-instrumentation
import { initializeOTel } from './utils/otel-setup.js';
void initializeOTel().catch(() => {});

/**
 * Compute Networks Server
 * Port 6000 - Dedicated to distributed computing and task execution
 * Designed for: Flux, Akash, Bacalhau, Golem, Render Network, TatauCloud, SONM, iExec, AIOZ, Internet Computer Protocol
 *
 * HONEST-GAP STATUS (backend#1118): none of the networks above has a client
 * wired here, and there is no job queue behind the generic /api/compute/*
 * routes — the previous implementation pushed submissions into an in-memory
 * Map, advanced them to "completed" on a timer, and reported pseudo-random
 * queue depth / utilisation. Those routes now return an explicit 501
 * NOT_IMPLEMENTED via server/utils/honest-gap.js; the network table is a
 * design catalog (status: 'not_wired').
 *
 * The REAL routers mounted on this server are untouched and remain the only
 * working compute surface: satellite/USGS/NRCS ingestion, forecast
 * verification, forecast jobs (backend#47, /api/compute/forecast-jobs) and
 * the compute-node task lifecycle (backend#57, /api/compute/tasks/*).
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import winston from 'winston';
import { computeLogger } from './utils/logger.js';
import { createSatelliteIngestionRouter } from './routes/satellite-ingestion-routes.js';
import { createForecastVerificationRouter } from './routes/forecast-verification-routes.js';
import { createUsgsWaterIngestionRouter } from './routes/usgs-water-ingestion-routes.js';
import { createUsgsEarthquakeIngestionRouter } from './routes/usgs-earthquake-ingestion-routes.js';
import { createNrcsSoilIngestionRouter } from './routes/nrcs-soil-ingestion-routes.js';
import { createForecastJobRouter } from './routes/forecast-job-routes.js';
import { createComputeTaskRouter } from './routes/compute-task-routes.js';
const { createHealthMiddleware } = require('./middleware/create-health-middleware');
const { registerGracefulShutdown } = require('./utils/graceful-shutdown');

// Import production CORS cleanup (assuming it's converted to TypeScript exports)
const ProductionCORSCleanup = require('../middleware/production-cors-cleanup').default;
const { sendNotWired, integrationNotice } = require('./utils/honest-gap.js');
const COMPUTE_SEE = 'wrfcoin/backend#1118';
const REAL_COMPUTE_ROUTES =
  'POST /api/compute/forecast-jobs (backend#47) and /api/compute/tasks/* (backend#57) are the real, wired job surfaces on this server.';

// Utility function to safely extract error message from unknown error type
// TypeScript Interface Definitions for Compute Networks

interface ComputeNetworkCapabilities {
  [key: string]: any;
}

interface ComputeNetworkNode {
  name: string;
  network?: string;
  nodes?: number;
  type: string;
  capabilities?: ComputeNetworkCapabilities | string[];
  totalTFLOPS?: number;
  availableTFLOPS?: number;
  gpuNodes?: number;
  reliability?: string;
  status: string;
  compute_power?: string;
  gpu_available?: boolean;
  cost_per_hour?: string;
  specialization?: string;
  getStatus?(): Promise<any>;
  getComputeCapacity?(): Promise<any>;
}

interface ComputeNetworkCollection {
  [key: string]: ComputeNetworkNode;
}

interface ComputeJob {
  id: string;
  task: any;
  network: string;
  status: string;
  submitted_at: string;
  priority: string;
  resources: {
    cpu: number;
    memory: string;
  };
  started_at?: string;
  completed_at?: string;
  cancelled_at?: string;
  result?: any;
  provider?: string;
}

interface ComputeProvider {
  name: string;
  type: string;
  capabilities: ComputeNetworkCapabilities | string[];
  totalTFLOPS: number;
  availableTFLOPS: number;
  costPerHour: number;
  reliability: string;
  status: string;
}

interface TaskRequirements {
  gpu?: boolean;
  memory?: string;
  [key: string]: any;
}

interface BatchTask {
  taskType: string;
  requirements?: TaskRequirements;
  [key: string]: any;
}

interface JobResult {
  jobId: string;
  provider: string;
  taskType: string;
  cost: string;
  status: string;
  queuePosition: number;
}

interface DistributedShard {
  shardId: string;
  provider: string;
  dataPartition: string;
  estimatedCost: string;
  redundancyLevel: string;
}

interface JobMetrics {
  jobId: string;
  status: string;
  progress: number;
  cpuUsage: string;
  memoryUsage: string;
  networkIO: string;
  estimatedTimeRemaining: string;
  costAccrued: string;
  provider: string;
}

interface OptimizationRecommendation {
  currentUtilization: string;
  totalCapacity: string;
  availableCapacity: string;
  recommendations: string[];
  optimalLoadTarget: string;
  scalingThreshold: string;
}

// Type-safe function signatures
type TaskType =
  | 'machine_learning'
  | 'ai'
  | 'rendering'
  | 'data_processing'
  | 'web_hosting'
  | 'storage'
  | 'quantum'
  | 'distributed'
  | 'big_data'
  | string;
type PriorityLevel = 'low' | 'normal' | 'high' | 'urgent';
type JobStatus = 'queued' | 'running' | 'completed' | 'cancelled';
type OptimizationStrategy = 'cost' | 'performance' | 'reliability';
type RedundancyLevel = 'standard' | 'high' | 'maximum';

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as any).message);
  }
  return 'Unknown error occurred';
}

const app = express();
// COMPUTE_NETWORKS_PORT lets tests bind an ephemeral port; production keeps 6000.
const PORT = Number(process.env.COMPUTE_NETWORKS_PORT || 6000);
const probeState = { draining: false };

// Configure Winston logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'compute-networks' },
  transports: [
    new winston.transports.File({
      filename: 'logs/compute-error.log',
      level: 'error',
    }),
    new winston.transports.File({ filename: 'logs/compute-combined.log' }),
    new winston.transports.Console({
      format: winston.format.simple(),
    }),
  ],
});

// Middleware
app.use(helmet());
// Enhanced security middleware with production CORS cleanup
ProductionCORSCleanup.autoConfigureCORS(app);
// Rate limiting for compute-intensive operations
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500, // Limit each IP to 500 requests per windowMs
  message: 'Too many compute requests from this IP, please try again later.',
});
(app as any).use(limiter);
// Satellite ingestion endpoints (backend#58) use route-level 1MB JSON limits.
app.use('/api', createSatelliteIngestionRouter());
// USGS hydrological ingestion endpoints (backend#54) use route-level 1MB JSON limits.
app.use('/api', createUsgsWaterIngestionRouter());
// USGS seismic ingestion endpoints (backend#55).
app.use('/api', createUsgsEarthquakeIngestionRouter());
// NRCS soil ingestion endpoints (backend#56).
app.use('/api', createNrcsSoilIngestionRouter());
// Forecast verification route uses a stricter parser limit than the global API parser.
app.use('/api', createForecastVerificationRouter());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(
  createHealthMiddleware('compute-networks', {}, { state: probeState }).router
);

// backend#1118: the in-memory job Map and the provider-selection / cost
// helpers that only fed fabricated responses were removed with the routes.

const computeNetworks: ComputeNetworkCollection = {
  flux: {
    name: 'Flux Network',
    network: 'Flux Mainnet',
    nodes: 2847,
    type: 'Decentralized Cloud Infrastructure',
    capabilities: [
      'GPU Computing',
      'Web Hosting',
      'Docker Deployment',
      'Storage',
    ],
    totalTFLOPS: 78.5,
    availableTFLOPS: 52.3,
    gpuNodes: 456,
    reliability: '99.7%',
    status: 'not_wired',
    async getStatus() {
      return {
        status: 'online',
        nodes: this.nodes,
        totalTFLOPS: this.totalTFLOPS,
        availableTFLOPS: this.availableTFLOPS,
        uptime: this.reliability,
      };
    },
    async getComputeCapacity() {
      return {
        totalCapacity: this.totalTFLOPS,
        availableCapacity: this.availableTFLOPS,
        utilization: `${Math.round((1 - this.availableTFLOPS! / this.totalTFLOPS!) * 100)}%`,
      };
    },
  },
  akash: {
    name: 'Akash Network',
    type: 'decentralized_cloud',
    status: 'not_wired',
    compute_power: '50,000 vCPUs',
    gpu_available: true,
    cost_per_hour: '0.05',
    specialization: 'container_deployment',
    capabilities: ['Docker Deployment', 'Container Orchestration'],
    totalTFLOPS: 45.2,
    availableTFLOPS: 32.1,
    reliability: '99.6%',
  },
  bacalhau: {
    name: 'Bacalhau',
    type: 'distributed_compute',
    status: 'not_wired',
    compute_power: '25,000 cores',
    gpu_available: true,
    cost_per_hour: '0.03',
    specialization: 'data_processing',
    capabilities: ['Data Processing', 'distributed', 'Big Data'],
    totalTFLOPS: 28.7,
    availableTFLOPS: 22.3,
    reliability: '99.4%',
  },
  golem: {
    name: 'Golem Network',
    type: 'p2p_compute',
    status: 'not_wired',
    compute_power: '100,000 cores',
    gpu_available: false,
    cost_per_hour: '0.02',
    specialization: 'cpu_intensive',
    capabilities: ['CPU Computing', 'P2P Processing'],
    totalTFLOPS: 65.4,
    availableTFLOPS: 51.2,
    reliability: '99.1%',
  },
  render: {
    name: 'Render Network',
    type: 'gpu_rendering',
    status: 'not_wired',
    compute_power: '15,000 GPUs',
    gpu_available: true,
    cost_per_hour: '0.10',
    specialization: 'graphics_rendering',
    capabilities: ['GPU Computing', '3D Rendering', 'Graphics Processing'],
    totalTFLOPS: 89.3,
    availableTFLOPS: 67.8,
    reliability: '99.8%',
  },
  tataucloud: {
    name: 'TatauCloud',
    type: 'edge_compute',
    status: 'not_wired',
    compute_power: '30,000 nodes',
    gpu_available: true,
    cost_per_hour: '0.04',
    specialization: 'edge_processing',
    capabilities: ['Edge Computing', 'IoT Processing', 'GPU Computing'],
    totalTFLOPS: 42.1,
    availableTFLOPS: 31.5,
    reliability: '99.3%',
  },
  sonm: {
    name: 'SONM',
    type: 'fog_computing',
    status: 'not_wired',
    compute_power: '40,000 devices',
    gpu_available: true,
    cost_per_hour: '0.025',
    specialization: 'distributed_fog',
    capabilities: ['Fog Computing', 'distributed', 'GPU Computing'],
    totalTFLOPS: 36.8,
    availableTFLOPS: 27.2,
    reliability: '99.2%',
  },
  iexec: {
    name: 'iExec',
    type: 'decentralized_compute',
    status: 'not_wired',
    compute_power: '113,880 cores',
    gpu_available: true,
    cost_per_hour: '0.08',
    specialization: 'confidential_computing',
    capabilities: ['Confidential Computing', 'GPU Computing', 'distributed'],
    totalTFLOPS: 72.6,
    availableTFLOPS: 54.9,
    reliability: '99.7%',
  },
  icp: {
    name: 'Internet Computer Protocol',
    type: 'blockchain_compute',
    status: 'not_wired',
    compute_power: '580 subnet nodes',
    gpu_available: false,
    cost_per_hour: '0.06',
    specialization: 'web3_hosting',
    capabilities: [
      'Web3 Hosting',
      'Blockchain Computing',
      'Canister Deployment',
    ],
    totalTFLOPS: 15.4,
    availableTFLOPS: 11.8,
    reliability: '99.9%',
  },
  aioz: {
    name: 'AIOZ Network',
    type: 'content_delivery',
    status: 'not_wired',
    compute_power: '12,000 CDN nodes',
    gpu_available: true,
    cost_per_hour: '0.05',
    specialization: 'ai_content_distribution',
    capabilities: ['AI/ML Training', 'Content Delivery', 'GPU Computing'],
    totalTFLOPS: 25.3,
    availableTFLOPS: 18.7,
    reliability: '99.6%',
  },
};

// Logging middleware
app.use((req, res, next) => {
  logger.info('Compute API Request', {
    ip: req.ip,
    method: req.method,
    path: req.path,
  });
  next();
});

// Get all compute networks — design catalog, explicitly marked not wired.
app.get('/api/compute/networks', (req, res) => {
  try {
    res.json({
      success: true,
      integration: integrationNotice('Compute networks', COMPUTE_SEE),
      networks: computeNetworks,
      active_networks: 0,
      gpu_networks: Object.values(computeNetworks).filter(n => n.gpu_available)
        .length,
      real_routes: REAL_COMPUTE_ROUTES,
    });
  } catch (error) {
    logger.error('Error fetching compute networks', {
      error: getErrorMessage(error),
    });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Per-network status endpoints — no client is wired for any of them.
const notWiredNetworkStatus =
  (slug: string, label: string) =>
  (req: express.Request, res: express.Response) =>
    sendNotWired(res, {
      capability: `compute.${slug}.status`,
      message: `${label} status not yet wired; no ${label} client is integrated.`,
      details: 'The previous response was a hard-coded "online / 99.x% uptime" block.',
      see: COMPUTE_SEE,
    });

app.get('/api/flux/status', notWiredNetworkStatus('flux', 'Flux'));
app.get('/api/iexec/status', notWiredNetworkStatus('iexec', 'iExec'));
app.get('/api/icp/status', notWiredNetworkStatus('icp', 'Internet Computer Protocol'));
app.get('/api/aioz/status', notWiredNetworkStatus('aioz', 'AIOZ Network'));
app.get('/api/compute/flux/status', notWiredNetworkStatus('flux', 'Flux'));

// Get specific compute network — catalog entry; live metrics unavailable.
app.get('/api/compute/networks/:network', (req, res) => {
  try {
    const { network } = req.params;
    const networkInfo = computeNetworks[network.toLowerCase()];

    if (!networkInfo) {
      return res
        .status(404)
        .json({ success: false, error: 'Network not found' });
    }

    res.json({
      success: true,
      integration: integrationNotice('Compute networks', COMPUTE_SEE),
      network: networkInfo,
      metrics: {
        unavailable: true,
        reason: `No ${networkInfo.name} client is wired; queue length and utilisation cannot be measured (previous values were pseudo-random).`,
      },
    });
  } catch (error) {
    logger.error('Error fetching compute network', {
      error: getErrorMessage(error),
    });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Submit compute job — validation kept; there is no dispatch behind it.
app.post('/api/compute/submit', (req, res) => {
  try {
    const { task, network } = req.body;

    if (!task || !network) {
      return res
        .status(400)
        .json({ success: false, error: 'Task and network required' });
    }

    const selectedNetwork = computeNetworks[network.toLowerCase()];
    if (!selectedNetwork) {
      return res
        .status(404)
        .json({ success: false, error: 'Network not found' });
    }

    return sendNotWired(res, {
      capability: 'compute.submit',
      message: `Generic job submission to ${selectedNetwork.name} not yet wired; the job was NOT accepted.`,
      details:
        'The previous implementation stored the job in memory and marked it "completed" after 30s without running anything. ' +
        REAL_COMPUTE_ROUTES,
      see: COMPUTE_SEE,
    });
  } catch (error) {
    logger.error('Error submitting compute job', {
      error: getErrorMessage(error),
    });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

const notWiredJobs = (capability: string, message: string) =>
  (req: express.Request, res: express.Response) =>
    sendNotWired(res, {
      capability,
      message,
      details: 'No generic job queue exists behind this server. ' + REAL_COMPUTE_ROUTES,
      see: COMPUTE_SEE,
    });

// Job status / listing / cancel — the in-memory job Map was removed.
app.get('/api/compute/jobs/:jobId', notWiredJobs('compute.job_status', 'Generic compute job tracking not yet wired.'));
app.get('/api/compute/jobs', notWiredJobs('compute.jobs', 'Generic compute job listing not yet wired.'));
app.delete('/api/compute/jobs/:jobId', notWiredJobs('compute.job_cancel', 'Generic compute job cancellation not yet wired.'));
app.get('/api/compute/job/:jobId/metrics', notWiredJobs('compute.job_metrics', 'Per-job metrics not yet wired (previous values were pseudo-random).'));

// Compute metrics endpoint
app.get('/api/compute/metrics', (req, res) => {
  return sendNotWired(res, {
    capability: 'compute.metrics',
    message: 'Aggregate compute metrics not yet wired.',
    details:
      'Previous values ("260,000+ cores", 72% utilisation, 99.2% success, a pseudo-random total_jobs_processed) were constants or random.',
    see: COMPUTE_SEE,
  });
});

// Batch / distributed / quantum submission — provider "selection" was over a static table; nothing dispatched.
app.post('/api/compute/submit-batch', (req, res) => {
  const { tasks } = req.body;
  if (!tasks || !Array.isArray(tasks)) {
    return res.status(400).json({ success: false, error: 'Tasks array required' });
  }
  return sendNotWired(res, {
    capability: 'compute.submit_batch',
    message: 'Batch job submission not yet wired; no task was accepted.',
    details: REAL_COMPUTE_ROUTES,
    see: COMPUTE_SEE,
  });
});

app.post('/api/compute/submit-distributed', (req, res) => {
  const { workloadType } = req.body;
  if (!workloadType) {
    return res.status(400).json({ success: false, error: 'Workload type required' });
  }
  return sendNotWired(res, {
    capability: 'compute.submit_distributed',
    message: 'Distributed workload submission not yet wired; no shard was dispatched.',
    details: REAL_COMPUTE_ROUTES,
    see: COMPUTE_SEE,
  });
});

app.post('/api/compute/submit-quantum', (req, res) => {
  const { algorithm } = req.body;
  if (!algorithm) {
    return res.status(400).json({ success: false, error: 'Algorithm type required' });
  }
  return sendNotWired(res, {
    capability: 'compute.submit_quantum',
    message: 'Quantum-simulation submission not yet wired; no provider exists.',
    see: COMPUTE_SEE,
  });
});

// Network capacity optimization — was computed from the static catalog's TFLOPS numbers.
app.get('/api/compute/optimize-capacity', (req, res) => {
  return sendNotWired(res, {
    capability: 'compute.optimize_capacity',
    message: 'Capacity optimisation not yet wired; no live capacity data exists.',
    see: COMPUTE_SEE,
  });
});

// WRF/GFS forecast execution endpoints (backend#47)
app.use('/api/compute', createForecastJobRouter());

// Compute node task lifecycle endpoints (backend#57)
app.use('/api', createComputeTaskRouter());

// Error handling middleware
app.use((err: any, req, res, next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ success: false, error: 'Payload too large' });
  }

  if (
    err?.type === 'entity.parse.failed' ||
    err?.status === 400 ||
    (err instanceof SyntaxError && 'body' in err)
  ) {
    return res.status(400).json({ success: false, error: 'Invalid JSON payload' });
  }

  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint not found' });
});

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
  logger.info(`Compute Networks Server running on port ${PORT}`);
  computeLogger.info(`Compute Networks Server running on http://0.0.0.0:${PORT}`);
});

registerGracefulShutdown({
  serviceName: 'compute-networks',
  server,
  logger,
  state: probeState,
});

module.exports = app;
module.exports.server = server;
