// OpenTelemetry must be initialized before other imports for auto-instrumentation
const { initializeOTel } = require('./utils/otel-setup.js');
initializeOTel().catch(() => {});

/**
 * AI/ML Networks Server
 * Port 6001 - Dedicated to machine learning and AI inference operations
 * Real: local ONNX model registry + inference, ensemble scoring, advisories.
 * Catalog only (not wired, backend#1173): Bittensor, Near Protocol, Fetch.ai,
 * SingularityNET.
 */

const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const winston = require('winston');
const multer = require('multer');
const ProductionCORSCleanup = require('../middleware/production-cors-cleanup').default;
const { createHealthMiddleware } = require('./middleware/create-health-middleware');
const { registerGracefulShutdown } = require('./utils/graceful-shutdown');
const { integrationNotice } = require('./utils/honest-gap.js');

const { sendSidecarUnavailable } = require('./utils/sidecar-unavailable.js');

const AIML_SEE = 'wrfcoin/backend#1173';

const app = express();
const PORT = 6001;
const probeState = { draining: false };

const MODEL_REGISTRY_FILE = path.resolve(__dirname, '../data/aiml-model-registry.json');
const MODEL_STORAGE_DIR = path.resolve(__dirname, '../data/aiml-models');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'ai-ml-networks' },
  transports: [
    new winston.transports.File({
      filename: 'logs/ai-ml-error.log',
      level: 'error',
    }),
    new winston.transports.File({ filename: 'logs/ai-ml-combined.log' }),
    new winston.transports.Console({ format: winston.format.simple() }),
  ],
});

app.use(helmet());
ProductionCORSCleanup.autoConfigureCORS(app);
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(
  createHealthMiddleware('ai-ml-networks', {}, { state: probeState }).router
);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: 'Too many AI requests from this IP, please try again later.',
});
app.use(limiter);

// Design catalog of the third-party AI networks this service is meant to
// front. None has a client in this repo, so every entry is `not_wired`
// (backend#1173, same treatment as #1118). The invented validator / miner /
// agent / service counts and per-call WRF prices were removed. A model
// registered under one of these keys is still a LOCAL ONNX model — the key is
// a label, not a remote execution target.
const aiNetworks = {
  bittensor: {
    name: 'Bittensor',
    type: 'neural_network',
    status: 'not_wired',
    specialization: 'distributed_ai_training',
    models_available: ['language', 'vision', 'audio', 'multimodal'],
  },
  near: {
    name: 'Near Protocol',
    type: 'smart_contracts',
    status: 'not_wired',
    specialization: 'ai_smart_contracts',
    models_available: ['prediction', 'classification', 'regression'],
  },
  fetchai: {
    name: 'Fetch.ai',
    type: 'autonomous_agents',
    status: 'not_wired',
    specialization: 'agent_based_ml',
    models_available: ['optimization', 'negotiation', 'prediction', 'routing'],
  },
  singularitynet: {
    name: 'SingularityNET',
    type: 'ai_marketplace',
    status: 'not_wired',
    specialization: 'ai_service_marketplace',
    models_available: ['nlp', 'computer_vision', 'robotics', 'biomedical_ai'],
  },
};

const AI_NETWORKS_NOTICE = integrationNotice('AI/ML networks', AIML_SEE);

const activeInferences = new Map();
const ensembleSubmissions = new Map();
const ensembleRounds = new Map();
const ensembleStandings = new Map();

const ensembleConfig = {
  halfLifeDays: Number(process.env.AIML_ENSEMBLE_HALFLIFE_DAYS || 14),
  retirementThreshold: Number(process.env.AIML_ENSEMBLE_RETIREMENT_THRESHOLD || 0.35),
  retirementRounds: Number(process.env.AIML_ENSEMBLE_RETIREMENT_ROUNDS || 3),
};

const advisoryPolicyBundles = {
  storm: {
    version: 'v1',
    thresholds: { monitor: 0.15, watch: 0.35, warning: 0.55, emergency: 0.78 },
  },
  flood: {
    version: 'v1',
    thresholds: { monitor: 0.1, watch: 0.3, warning: 0.55, emergency: 0.8 },
  },
  heat: {
    version: 'v1',
    thresholds: { monitor: 0.12, watch: 0.33, warning: 0.58, emergency: 0.82 },
  },
};

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1,
  },
});

class ModelRegistry {
  constructor() {
    this.models = new Map();
    this.loaded = false;
  }

  async init() {
    if (this.loaded) return;
    await fs.mkdir(path.dirname(MODEL_REGISTRY_FILE), { recursive: true });
    await fs.mkdir(MODEL_STORAGE_DIR, { recursive: true });
    try {
      const raw = await fs.readFile(MODEL_REGISTRY_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      const models = Array.isArray(parsed.models) ? parsed.models : [];
      for (const model of models) {
        this.models.set(model.id, model);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.warn('Failed to load model registry, starting empty', { error: error.message });
      }
      await this.persist();
    }
    this.loaded = true;
  }

  list(filters = {}) {
    const values = Array.from(this.models.values());
    return values.filter(model => {
      if (filters.network && model.network !== filters.network) return false;
      if (filters.modelType && model.modelType !== filters.modelType) return false;
      return true;
    });
  }

  getById(id) {
    return this.models.get(id) || null;
  }

  findByTypeAndNetwork(modelType, network) {
    const models = this.list({ modelType, network });
    return models[0] || null;
  }

  async add(input) {
    const id = `mdl_${crypto.randomUUID().replace(/-/g, '')}`;
    const now = new Date().toISOString();
    const model = {
      id,
      name: input.name,
      version: input.version || '1.0.0',
      network: input.network,
      modelType: input.modelType,
      filePath: input.filePath,
      labels: Array.isArray(input.labels) ? input.labels : [],
      createdAt: now,
      updatedAt: now,
      status: 'active',
    };

    this.models.set(id, model);
    await this.persist();
    return model;
  }

  async delete(id) {
    const existed = this.models.delete(id);
    if (existed) {
      await this.persist();
    }
    return existed;
  }

  async persist() {
    const payload = {
      updatedAt: new Date().toISOString(),
      models: Array.from(this.models.values()),
    };
    await fs.writeFile(MODEL_REGISTRY_FILE, JSON.stringify(payload, null, 2));
  }
}

const modelRegistry = new ModelRegistry();
let ort = null;

async function loadOnnxRuntime() {
  if (ort) return ort;
  try {
    ort = await import('onnxruntime-node');
    return ort;
  } catch (error) {
    logger.warn('onnxruntime-node not available, fallback inference will be used', {
      error: error.message,
    });
    return null;
  }
}

function collectNumericValues(input, accumulator = []) {
  if (typeof input === 'number' && Number.isFinite(input)) {
    accumulator.push(input);
    return accumulator;
  }
  if (Array.isArray(input)) {
    for (const item of input) {
      collectNumericValues(item, accumulator);
    }
    return accumulator;
  }
  if (input && typeof input === 'object') {
    for (const value of Object.values(input)) {
      collectNumericValues(value, accumulator);
    }
  }
  return accumulator;
}

function statisticalFallbackInference(model, inputData) {
  const numbers = collectNumericValues(inputData);
  const count = numbers.length;
  const mean = count > 0
    ? numbers.reduce((sum, value) => sum + value, 0) / count
    : 0;
  const variance = count > 0
    ? numbers.reduce((sum, value) => sum + (value - mean) ** 2, 0) / count
    : 0;
  const stddev = Math.sqrt(variance);
  const anomalyScore = Number((stddev / (Math.abs(mean) + 1)).toFixed(6));
  const confidence = Number((1 / (1 + anomalyScore)).toFixed(4));

  return {
    engine: 'statistical-fallback',
    prediction: anomalyScore > 1.5 ? 'anomaly' : 'normal',
    anomaly_score: anomalyScore,
    confidence,
    numeric_sample_count: count,
    model_version: model.version,
  };
}

async function runOnnxInference(model, inputData) {
  const runtime = await loadOnnxRuntime();
  if (!runtime) {
    return statisticalFallbackInference(model, inputData);
  }

  const session = await runtime.InferenceSession.create(model.filePath);
  const inputNames = session.inputNames;
  if (inputNames.length === 0) {
    throw new Error('ONNX model has no input names');
  }

  const numbers = collectNumericValues(inputData);
  const normalized = numbers.length > 0 ? numbers : [0];
  const tensor = new runtime.Tensor('float32', Float32Array.from(normalized), [1, normalized.length]);
  const feeds = { [inputNames[0]]: tensor };
  const output = await session.run(feeds);

  const firstOutputName = session.outputNames[0];
  const outputTensor = output[firstOutputName];
  const outputData = outputTensor?.data ? Array.from(outputTensor.data) : [];
  const firstValue = outputData.length > 0 ? Number(outputData[0]) : 0;
  const confidence = Number((1 / (1 + Math.exp(-firstValue))).toFixed(4));

  return {
    engine: 'onnxruntime-node',
    prediction: firstValue > 0.5 ? 'anomaly' : 'normal',
    confidence,
    raw_output: outputData,
    model_version: model.version,
  };
}

function computeEnsembleRoundId(domainBounds, validTimeRange) {
  const payload = JSON.stringify({
    domainBounds: {
      north: Number(domainBounds.north || 0).toFixed(6),
      south: Number(domainBounds.south || 0).toFixed(6),
      east: Number(domainBounds.east || 0).toFixed(6),
      west: Number(domainBounds.west || 0).toFixed(6),
    },
    validTimeRange: {
      start: new Date(validTimeRange.start).toISOString(),
      end: new Date(validTimeRange.end).toISOString(),
    },
  });

  return `ens_round_${crypto.createHash('sha256').update(payload).digest('hex').slice(0, 20)}`;
}

function deterministicMetricsFallback(submission) {
  const seed = crypto
    .createHash('sha256')
    .update(`${submission.modelId}:${submission.roundId}`)
    .digest();
  const normalized = seed[0] / 255;

  return {
    mae: Number((1.5 + normalized).toFixed(6)),
    rmse: Number((2 + normalized).toFixed(6)),
    bias: Number((normalized - 0.5).toFixed(6)),
    skill_score: Number((normalized * 0.35).toFixed(6)),
  };
}

function normalizeMetrics(metrics = {}) {
  return {
    mae: Number(Math.max(0, Number(metrics.mae || 0)).toFixed(6)),
    rmse: Number(Math.max(0, Number(metrics.rmse || 0)).toFixed(6)),
    bias: Number(Number(metrics.bias || 0).toFixed(6)),
    skill_score: Number(Math.max(0, Math.min(1, Number(metrics.skill_score || 0))).toFixed(6)),
  };
}

function ensureStanding(modelId, modelName) {
  const existing = ensembleStandings.get(modelId);
  if (existing) {
    return existing;
  }

  const standing = {
    modelId,
    modelName: modelName || modelId,
    rounds: 0,
    wins: 0,
    totalSkill: 0,
    lastSkillScore: 0,
    decayedSkillScore: 0,
    consecutiveBelowThreshold: 0,
    retired: false,
    lastScoredAt: null,
  };

  ensembleStandings.set(modelId, standing);
  return standing;
}

function computeDecayFactor(previousIso, currentIso, halfLifeDays) {
  if (!previousIso) return 0;
  const previousMs = Date.parse(previousIso);
  const currentMs = Date.parse(currentIso);
  if (!Number.isFinite(previousMs) || !Number.isFinite(currentMs) || currentMs <= previousMs) {
    return 0;
  }

  const deltaDays = (currentMs - previousMs) / (24 * 60 * 60 * 1000);
  return Number(Math.pow(0.5, deltaDays / Math.max(1, halfLifeDays)).toFixed(6));
}

function toLeaderboardStanding(standing) {
  const meanSkillScore = standing.rounds > 0
    ? Number((standing.totalSkill / standing.rounds).toFixed(6))
    : 0;
  const winRate = standing.rounds > 0
    ? Number((standing.wins / standing.rounds).toFixed(6))
    : 0;
  const multiplier = Number((0.5 + standing.decayedSkillScore).toFixed(6));

  return {
    model_id: standing.modelId,
    model_name: standing.modelName,
    rounds: standing.rounds,
    wins: standing.wins,
    win_rate: winRate,
    last_skill_score: standing.lastSkillScore,
    mean_skill_score: meanSkillScore,
    decayed_skill_score: standing.decayedSkillScore,
    retirement: {
      retired: standing.retired,
      threshold: ensembleConfig.retirementThreshold,
      rounds_to_retire: ensembleConfig.retirementRounds,
      consecutive_below_threshold: standing.consecutiveBelowThreshold,
    },
    pop_reward_weighting: {
      skill_score: standing.decayedSkillScore,
      multiplier,
    },
    last_scored_at: standing.lastScoredAt,
  };
}

async function scoreClosedEnsembleRounds(now = new Date()) {
  const nowMs = now.getTime();
  const roundGroups = new Map();

  for (const submission of ensembleSubmissions.values()) {
    if (submission.status !== 'pending') continue;
    const bucket = roundGroups.get(submission.roundId) || [];
    bucket.push(submission);
    roundGroups.set(submission.roundId, bucket);
  }

  const scoredRounds = [];
  for (const [roundId, submissions] of roundGroups.entries()) {
    if (!submissions.length) continue;
    const endMs = Date.parse(submissions[0].validTimeRange.end);
    if (!Number.isFinite(endMs) || endMs > nowMs) continue;

    const scoredAt = now.toISOString();
    let winnerModelId = null;
    let winnerSkill = -1;

    for (const submission of submissions) {
      const metrics = submission.metrics || deterministicMetricsFallback(submission);
      const skillScore = Number(Math.max(0, Math.min(1, metrics.skill_score)).toFixed(6));
      submission.metrics = metrics;
      submission.status = 'scored';
      submission.scoredAt = scoredAt;

      const standing = ensureStanding(submission.modelId, submission.modelName);
      const decayFactor = computeDecayFactor(
        standing.lastScoredAt,
        scoredAt,
        ensembleConfig.halfLifeDays
      );

      standing.rounds += 1;
      standing.totalSkill = Number((standing.totalSkill + skillScore).toFixed(6));
      standing.lastSkillScore = skillScore;
      standing.decayedSkillScore = standing.rounds === 1
        ? skillScore
        : Number((standing.decayedSkillScore * decayFactor + skillScore * (1 - decayFactor)).toFixed(6));
      standing.consecutiveBelowThreshold = skillScore < ensembleConfig.retirementThreshold
        ? standing.consecutiveBelowThreshold + 1
        : 0;
      standing.retired = standing.consecutiveBelowThreshold >= ensembleConfig.retirementRounds;
      standing.lastScoredAt = scoredAt;

      if (submission.contributorAddress) {
        try {
          const reputationModule = await import('./services/reputation/reputation-scoring-engine.js');
          await reputationModule.reputationScoringEngine.recordSignal({
            address: submission.contributorAddress,
            role: 'analyzer',
            eventType: 'forecast_ensemble_scoring',
            dataQuality: skillScore * 100,
            uptime: 100,
            verificationAccuracy: skillScore * 100,
            communityContribution: 40,
            details: {
              roundId,
              modelId: submission.modelId,
              skillScore,
              source: 'ensemble-competition',
            },
          });
        } catch {
          // Reputation linkage is best-effort.
        }
      }

      if (skillScore > winnerSkill) {
        winnerSkill = skillScore;
        winnerModelId = submission.modelId;
      }
    }

    if (winnerModelId) {
      const winner = ensembleStandings.get(winnerModelId);
      if (winner) {
        winner.wins += 1;
      }
    }

    const roundSummary = {
      round_id: roundId,
      scored_at: scoredAt,
      winner_model_id: winnerModelId,
      participants: submissions.length,
    };
    ensembleRounds.set(roundId, roundSummary);
    scoredRounds.push(roundSummary);
  }

  return scoredRounds;
}

function determineAdvisoryLevel(thresholds, score) {
  if (score >= thresholds.emergency) return 'emergency';
  if (score >= thresholds.warning) return 'warning';
  if (score >= thresholds.watch) return 'watch';
  if (score >= thresholds.monitor) return 'monitor';
  return 'none';
}

function summarizeAlertEvidence(alerts = []) {
  const bySeverity = {
    warning: 0,
    watch: 0,
    advisory: 0,
    statement: 0,
    unknown: 0,
  };

  const byType = {
    tornado: 0,
    wildfire_red_flag: 0,
    flood: 0,
    hurricane: 0,
    winter_storm: 0,
    other: 0,
  };

  for (const alert of alerts) {
    const severity = bySeverity[alert.severityClass] !== undefined ? alert.severityClass : 'unknown';
    const type = byType[alert.type] !== undefined ? alert.type : 'other';
    bySeverity[severity] += 1;
    byType[type] += 1;
  }

  return {
    total_alerts: alerts.length,
    by_severity: bySeverity,
    by_type: byType,
  };
}

function detectImageMime(buffer) {
  if (!buffer || buffer.length < 12) return null;

  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (isJpeg) return 'image/jpeg';

  const isPng = buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a;
  if (isPng) return 'image/png';

  const isWebp = buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP';
  if (isWebp) return 'image/webp';

  return null;
}

function resolveNetwork(networkId) {
  if (!networkId || typeof networkId !== 'string') return null;
  return aiNetworks[networkId.toLowerCase()] || null;
}

app.use(async (_req, _res, next) => {
  try {
    await modelRegistry.init();
    next();
  } catch (error) {
    next(error);
  }
});

app.use((req, _res, next) => {
  logger.info('AI/ML API Request', {
    ip: req.ip,
    method: req.method,
    path: req.path,
  });
  next();
});

// Network keys label local models; no third-party AI network client is wired.
app.get('/api/aiml/networks/status', (_req, res) => sendSidecarUnavailable(res, {
  capability: 'aiml.networks.status',
  message: 'No third-party AI network client is wired; network status is unavailable.',
}));

app.get('/api/ai/networks', (_req, res) => sendSidecarUnavailable(res, {
  capability: 'ai.networks',
  message: 'No third-party AI network client is wired.',
}));

app.get('/api/ai/networks/:network', (req, res) => {
  const networkInfo = resolveNetwork(req.params.network);
  if (!networkInfo) {
    return res.status(404).json({ success: false, error: 'Network not found' });
  }
  return sendSidecarUnavailable(res, {
    capability: 'ai.network',
    message: `No ${networkInfo.name} client is wired; live network data is unavailable.`,
  });
});

app.post('/api/ai/models', async (req, res) => {
  try {
    const { name, version, network, model_type: modelType, file_path: filePath, labels } = req.body || {};

    if (!name || !network || !modelType || !filePath) {
      return res.status(400).json({
        success: false,
        error: 'name, network, model_type, and file_path are required',
      });
    }

    const networkInfo = resolveNetwork(network);
    if (!networkInfo) {
      return res.status(404).json({ success: false, error: 'Network not found' });
    }

    const resolvedPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(MODEL_STORAGE_DIR, filePath);

    await fs.access(resolvedPath);

    const model = await modelRegistry.add({
      name,
      version,
      network: network.toLowerCase(),
      modelType,
      filePath: resolvedPath,
      labels,
    });

    return res.status(201).json({ success: true, model });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(400).json({ success: false, error: 'Model file not found' });
    }
    logger.error('Error registering AI model', { error: error.message });
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.get('/api/ai/models', (req, res) => {
  const models = modelRegistry.list({
    network: req.query.network ? String(req.query.network).toLowerCase() : undefined,
    modelType: req.query.model_type ? String(req.query.model_type) : undefined,
  });

  res.json({ success: true, models, total_models: models.length });
});

app.delete('/api/ai/models/:modelId', async (req, res) => {
  const deleted = await modelRegistry.delete(req.params.modelId);
  if (!deleted) {
    return res.status(404).json({ success: false, error: 'Model not found' });
  }

  return res.status(200).json({ success: true, deleted_model_id: req.params.modelId });
});

app.post('/api/ai/inference', async (req, res) => {
  try {
    const { model_id: modelId, model_type: modelType, network, input_data: inputData } = req.body || {};

    if (!inputData || (!modelId && (!modelType || !network))) {
      return res.status(400).json({
        success: false,
        error: 'input_data and either model_id or (model_type + network) are required',
      });
    }

    let model = null;
    if (modelId) {
      model = modelRegistry.getById(modelId);
    } else {
      model = modelRegistry.findByTypeAndNetwork(modelType, String(network).toLowerCase());
    }

    if (!model) {
      return res.status(404).json({ success: false, error: 'No matching model found' });
    }

    const inferenceId = `wrfcoin_ai_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const startedAt = new Date().toISOString();

    activeInferences.set(inferenceId, {
      id: inferenceId,
      modelId: model.id,
      modelType: model.modelType,
      network: aiNetworks[model.network]?.name || model.network,
      networkKey: model.network,
      status: 'processing',
      submitted_at: startedAt,
      input_size: JSON.stringify(inputData).length,
    });

    const result = await runOnnxInference(model, inputData);
    const completedAt = new Date().toISOString();

    activeInferences.set(inferenceId, {
      ...activeInferences.get(inferenceId),
      status: 'completed',
      completed_at: completedAt,
      result,
    });

    return res.status(200).json({
      success: true,
      inference_id: inferenceId,
      model_id: model.id,
      network: aiNetworks[model.network]?.name || model.network,
      model_type: model.modelType,
      // `network` above is the registry label; the model ran here, locally.
      // The label follows the engine that actually produced `result`: when
      // onnxruntime-node is unavailable the statistical fallback ran, not ONNX.
      executed_by: result.engine === 'onnxruntime-node' ? 'local_onnx' : 'local_statistical_fallback',
      status: 'completed',
      result,
    });
  } catch (error) {
    logger.error('Error submitting AI inference', { error: error.message });
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.post('/api/ai/ensemble/submissions', async (req, res) => {
  try {
    const {
      model_id: modelId,
      model_name: modelName,
      contributor_address: contributorAddress,
      domain_bounds: domainBounds,
      valid_time_range: validTimeRange,
      forecast_ref: forecastRef,
      metrics,
      metadata,
    } = req.body || {};

    if (!modelId || !domainBounds || !validTimeRange?.start || !validTimeRange?.end) {
      return res.status(400).json({
        success: false,
        error: 'model_id, domain_bounds, valid_time_range.start, and valid_time_range.end are required',
      });
    }

    const startMs = Date.parse(validTimeRange.start);
    const endMs = Date.parse(validTimeRange.end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
      return res.status(400).json({
        success: false,
        error: 'valid_time_range.start/end must be valid ISO timestamps and start < end',
      });
    }

    const roundId = computeEnsembleRoundId(domainBounds, validTimeRange);
    const submissionId = `ens_sub_${crypto.randomUUID().replace(/-/g, '')}`;
    const submission = {
      submissionId,
      roundId,
      modelId: String(modelId),
      modelName: typeof modelName === 'string' && modelName.trim() ? modelName : String(modelId),
      contributorAddress: typeof contributorAddress === 'string' ? contributorAddress : null,
      domainBounds,
      validTimeRange,
      forecastRef: forecastRef || {},
      metrics: metrics ? normalizeMetrics(metrics) : null,
      status: 'pending',
      submittedAt: new Date().toISOString(),
      scoredAt: null,
      metadata: metadata && typeof metadata === 'object' ? metadata : {},
    };

    ensembleSubmissions.set(submissionId, submission);
    const scoredRounds = await scoreClosedEnsembleRounds();

    return res.status(201).json({
      success: true,
      submission: {
        ...submission,
        scored_at: submission.scoredAt,
      },
      auto_scored_rounds: scoredRounds.filter(round => round.round_id === roundId).length,
    });
  } catch (error) {
    logger.error('Error registering ensemble submission', { error: error.message });
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.post('/api/ai/ensemble/score', async (_req, res) => {
  try {
    const scoredRounds = await scoreClosedEnsembleRounds();
    return res.status(200).json({
      success: true,
      scored_rounds: scoredRounds,
      total_scored_rounds: scoredRounds.length,
    });
  } catch (error) {
    logger.error('Error scoring ensemble rounds', { error: error.message });
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.get('/api/ai/ensemble/leaderboard', async (req, res) => {
  try {
    await scoreClosedEnsembleRounds();
    const sortBy = ['skill_score', 'decayed_skill', 'win_rate', 'rounds'].includes(req.query.sort_by)
      ? req.query.sort_by
      : 'decayed_skill';
    const order = req.query.order === 'asc' ? 'asc' : 'desc';
    const limit = Math.min(200, Math.max(1, Number.parseInt(String(req.query.limit || '50'), 10) || 50));

    const standings = Array.from(ensembleStandings.values()).map(toLeaderboardStanding);

    standings.sort((a, b) => {
      const direction = order === 'asc' ? 1 : -1;
      if (sortBy === 'skill_score') {
        return direction * (a.last_skill_score - b.last_skill_score);
      }
      if (sortBy === 'win_rate') {
        return direction * (a.win_rate - b.win_rate);
      }
      if (sortBy === 'rounds') {
        return direction * (a.rounds - b.rounds);
      }
      return direction * (a.decayed_skill_score - b.decayed_skill_score);
    });

    return res.status(200).json({
      success: true,
      leaderboard: standings.slice(0, limit),
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Error fetching ensemble leaderboard', { error: error.message });
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

async function resolveEnsembleModelStatus(
  modelId,
  dependencies = {
    scoreClosedEnsembleRounds,
    ensembleStandings,
    toLeaderboardStanding,
  }
) {
  await dependencies.scoreClosedEnsembleRounds();
  const standing = dependencies.ensembleStandings.get(modelId);
  if (!standing) {
    return {
      status: 404,
      body: { success: false, error: 'Model standing not found' },
    };
  }

  return {
    status: 200,
    body: {
      success: true,
      standing: dependencies.toLeaderboardStanding(standing),
    },
  };
}

async function handleEnsembleModelStatus(req, res, dependencies) {
  try {
    const result = await resolveEnsembleModelStatus(req.params.modelId, dependencies);
    return res.status(result.status).json(result.body);
  } catch (error) {
    logger.error('Error fetching ensemble model status', { error: error.message });
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

app.get('/api/ai/ensemble/models/:modelId/status', handleEnsembleModelStatus);

app.post('/api/aiml/advisories', async (req, res) => {
  try {
    const eventClass = typeof req.body?.event_class === 'string'
      ? req.body.event_class.toLowerCase()
      : null;
    if (!['storm', 'flood', 'heat'].includes(eventClass)) {
      return res.status(400).json({
        success: false,
        error: 'event_class must be one of: storm, flood, heat',
      });
    }

    let alerts = Array.isArray(req.body?.alerts) ? req.body.alerts : [];
    if (!alerts.length) {
      try {
        const weatherModule = await import('./services/weather/severe-weather-response-service.js');
        const service = new weatherModule.SevereWeatherResponseService();
        await service.pollNow();
        alerts = service.getActiveAlerts();
      } catch {
        alerts = [];
      }
    }

    const measurements = req.body?.measurements && typeof req.body.measurements === 'object'
      ? req.body.measurements
      : {};
    const thresholds = advisoryPolicyBundles[eventClass].thresholds;

    const warningCount = alerts.filter(alert => alert.severityClass === 'warning').length;
    const watchCount = alerts.filter(alert => alert.severityClass === 'watch').length;
    const eventSpecificCount = alerts.filter(alert => {
      if (eventClass === 'storm') {
        return alert.type === 'tornado' || String(alert.event || '').toLowerCase().includes('storm');
      }
      if (eventClass === 'flood') {
        return alert.type === 'flood';
      }
      return String(alert.event || '').toLowerCase().includes('heat');
    }).length;

    const matchedRules = [];
    if (eventSpecificCount > 0) {
      matchedRules.push({
        id: `${eventClass}-active-alerts`,
        description: 'Event-specific active alerts detected',
        weight: 0.45,
        score: Number((eventSpecificCount / Math.max(1, alerts.length)).toFixed(6)),
      });
    }
    if (warningCount > 0) {
      matchedRules.push({
        id: `${eventClass}-warning-severity`,
        description: 'Warning level alerts present',
        weight: 0.3,
        score: Number((warningCount / Math.max(1, alerts.length)).toFixed(6)),
      });
    }
    if (watchCount > 0) {
      matchedRules.push({
        id: `${eventClass}-watch-severity`,
        description: 'Watch level alerts present',
        weight: 0.2,
        score: Number((watchCount / Math.max(1, alerts.length)).toFixed(6)),
      });
    }

    if (eventClass === 'heat' && Number(measurements.heatIndexF || 0) >= 105) {
      matchedRules.push({
        id: 'heat-index-threshold',
        description: 'Heat index exceeds 105F',
        weight: 0.35,
        score: 1,
      });
    }
    if (eventClass === 'flood' && Number(measurements.rainRateInPerHour || 0) >= 2) {
      matchedRules.push({
        id: 'flood-rain-rate-threshold',
        description: 'Rain rate exceeds 2 in/hr',
        weight: 0.3,
        score: 1,
      });
    }
    if (eventClass === 'storm' && Number(measurements.windGustMph || 0) >= 55) {
      matchedRules.push({
        id: 'storm-gust-threshold',
        description: 'Wind gust exceeds 55 mph',
        weight: 0.3,
        score: 1,
      });
    }

    const totalWeight = matchedRules.reduce((sum, rule) => sum + rule.weight, 0);
    const weightedScore = matchedRules.reduce((sum, rule) => sum + rule.weight * rule.score, 0);
    const compositeRuleScore = totalWeight > 0 ? Number((weightedScore / totalWeight).toFixed(6)) : 0;
    const modelAssistEnabled = Boolean(req.body?.model_assist);

    const model = modelAssistEnabled
      ? { enabled: true, used: false, fallback_used: true, version: null, confidence: compositeRuleScore, feature_attribution: [] }
      : { enabled: false, used: false, fallback_used: false, version: null, confidence: compositeRuleScore, feature_attribution: [] };

    const blendedScore = Number((compositeRuleScore * 0.7 + model.confidence * 0.3).toFixed(6));
    const advisoryLevel = determineAdvisoryLevel(thresholds, blendedScore);

    return res.status(200).json({
      success: true,
      advisory: {
        advisory_id: `advisory_${crypto.randomUUID().replace(/-/g, '')}`,
        event_class: eventClass,
        advisory_level: advisoryLevel,
        policy_version: advisoryPolicyBundles[eventClass].version,
        rule_bundle_version: advisoryPolicyBundles[eventClass].version,
        generated_at: new Date().toISOString(),
        model,
        evidence_bundle: {
          matched_rules: matchedRules,
          alert_summary: summarizeAlertEvidence(alerts),
          measurements,
          composite_rule_score: compositeRuleScore,
        },
      },
    });
  } catch (error) {
    logger.error('Error generating advisory decision', { error: error.message });
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.get('/api/aiml/advisories/policies/:version', (req, res) => {
  const version = req.params.version || 'v1';
  const policies = Object.entries(advisoryPolicyBundles).map(([eventClass, bundle]) => ({
    event_class: eventClass,
    policy_id: `${eventClass}-policy`,
    version: bundle.version,
    thresholds: bundle.thresholds,
  })).filter(bundle => bundle.version === version);

  return res.status(200).json({
    success: true,
    policies,
    count: policies.length,
  });
});

app.post('/api/aiml/image/classify', imageUpload.single('image'), async (req, res) => {
  try {
    const imageFile = req.file;
    if (!imageFile || !Buffer.isBuffer(imageFile.buffer)) {
      return res.status(400).json({
        success: false,
        error: 'multipart/form-data image file is required under field \"image\"',
      });
    }

    const detectedMime = detectImageMime(imageFile.buffer);
    if (!detectedMime || !['image/jpeg', 'image/png', 'image/webp'].includes(detectedMime)) {
      return res.status(400).json({
        success: false,
        error: 'Unsupported image type. Allowed: JPEG, PNG, WebP',
      });
    }

    if (imageFile.mimetype && imageFile.mimetype !== detectedMime) {
      return res.status(400).json({
        success: false,
        error: 'Claimed MIME type does not match image signature',
      });
    }

    const model = modelRegistry.list({ modelType: 'weather_image_classification' })[0] || null;
    const labels = Array.isArray(model?.labels) && model.labels.length
      ? model.labels
      : ['clear_sky', 'cloudy', 'rain', 'storm', 'snow', 'fog'];

    let ranked;
    const engine = 'onnxruntime-node';
    const fallbackUsed = false;

    if (model) {
      try {
        const runtime = await loadOnnxRuntime();
        if (runtime) {
          const session = await runtime.InferenceSession.create(model.filePath);
          const inputName = session.inputNames[0];
          const featureSize = Math.min(1024, imageFile.buffer.length);
          const featureValues = new Float32Array(featureSize);
          for (let idx = 0; idx < featureSize; idx++) {
            featureValues[idx] = imageFile.buffer[idx] / 255;
          }

          const tensor = new runtime.Tensor('float32', featureValues, [1, featureSize]);
          const output = await session.run({ [inputName]: tensor });
          const outputName = session.outputNames[0];
          const logits = output[outputName]?.data ? Array.from(output[outputName].data) : [];
          if (logits.length >= labels.length && logits.every(Number.isFinite)) {
            const used = logits.slice(0, labels.length);
            const max = Math.max(...used);
            const exps = used.map(value => Math.exp(value - max));
            const sum = exps.reduce((acc, value) => acc + value, 0) || 1;
            ranked = labels.map((label, idx) => ({
              label,
              confidence: Number(((exps[idx] || 0) / sum).toFixed(6)),
            }));
            ranked.sort((a, b) => b.confidence - a.confidence);
          }
        }
      } catch (error) {
        logger.warn('Image classification ONNX inference unavailable', {
          error: error.message,
        });
      }
    }

    if (!ranked) {
      return sendSidecarUnavailable(res, {
        capability: 'aiml.image.classify',
        message: 'Image classification requires successful output from a registered ONNX model.',
      });
    }

    return res.status(200).json({
      success: true,
      result: {
        labels: ranked,
        top_label: ranked[0]?.label || 'unknown',
        model: {
          id: model?.id || null,
          version: model?.version || null,
          engine,
          fallback_used: fallbackUsed,
        },
        context: {
          station_id: typeof req.body?.station_id === 'string' ? req.body.station_id : null,
          region_id: typeof req.body?.region_id === 'string' ? req.body.region_id : null,
          captured_at: typeof req.body?.captured_at === 'string' &&
              Number.isFinite(Date.parse(req.body.captured_at))
            ? new Date(req.body.captured_at).toISOString()
            : null,
        },
      },
    });
  } catch (error) {
    logger.error('Error classifying weather image', { error: error.message });
    return res.status(500).json({
      success: false,
      error: 'Image classification failed',
      code: 'AIML_IMAGE_CLASSIFICATION_FAILED',
      fallback_available: true,
    });
  }
});

app.get('/api/ai/inference/:inferenceId', (req, res) => {
  const inference = activeInferences.get(req.params.inferenceId);
  if (!inference) {
    return res.status(404).json({ success: false, error: 'Inference not found' });
  }

  return res.json({ success: true, inference });
});

app.get('/api/ai/networks/:network/models', (req, res) => {
  const networkInfo = resolveNetwork(req.params.network);
  if (!networkInfo) {
    return res.status(404).json({ success: false, error: 'Network not found' });
  }

  const networkKey = req.params.network.toLowerCase();
  const models = modelRegistry.list({ network: networkKey });
  const modelDetails = models.map(model => ({
    id: model.id,
    name: model.name,
    type: model.modelType,
    version: model.version,
    status: model.status,
    labels: model.labels,
  }));

  return res.json({
    success: true,
    integration: AI_NETWORKS_NOTICE,
    network: networkInfo.name,
    scope: 'local ONNX model registry',
    models: modelDetails,
    total_models: modelDetails.length,
  });
});

app.get('/api/ai/metrics', (_req, res) => {
  const inferences = Array.from(activeInferences.values());
  const completed = inferences.filter(inference => inference.status === 'completed');

  res.json({
    success: true,
    metrics: {
      total_networks: Object.keys(aiNetworks).length,
      active_networks: 0,
      total_models: modelRegistry.list().length,
      inferences_processed: inferences.length,
      completed_inferences: completed.length,
      processing_inferences: inferences.filter(inference => inference.status === 'processing').length,
      // No inferences yet means no rate, not a perfect one.
      model_success_rate: inferences.length > 0
        ? Number((completed.length / inferences.length).toFixed(4))
        : null,
    },
  });
});

app.get('/api/ai/inference', (_req, res) => {
  const inferences = Array.from(activeInferences.values());

  res.json({
    success: true,
    inferences,
    total_inferences: inferences.length,
    processing_inferences: inferences.filter(inference => inference.status === 'processing').length,
    completed_inferences: inferences.filter(inference => inference.status === 'completed').length,
  });
});

app.use((err, _req, res, _next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ success: false, error: 'Internal server error' });
});

app.use((_req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint not found' });
});

let server;
if (require.main === module || process.env.NODE_ENV !== 'test') {
  server = app.listen(PORT, '0.0.0.0', () => {
    logger.info('AI/ML Networks Server started', {
      port: PORT,
      url: `http://0.0.0.0:${PORT}`,
    });
  });

  registerGracefulShutdown({
    serviceName: 'ai-ml-networks',
    server,
    logger,
    state: probeState,
  });
}

module.exports = app;
if (server) {
  module.exports.server = server;
}
module.exports.__testHooks = {
  computeEnsembleRoundId,
  resolveEnsembleModelStatus,
  handleEnsembleModelStatus,
};
