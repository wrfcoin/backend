import express from 'express';
import { authenticateJWT } from '../middleware/auth.js';
import rateLimit from 'express-rate-limit';
import {
  ForecastJobOrchestrator,
  ForecastJobOrchestratorOptions,
} from '../services/forecast/forecast-job-orchestrator.js';
import { ForecastJobRecord } from '../services/forecast/forecast-job-types.js';

export function createForecastJobRouter(
  options: ForecastJobOrchestratorOptions = {}
): express.Router {
  const router = express.Router();
  const orchestrator = new ForecastJobOrchestrator(options);

  // All forecast job operations require authentication (#231)
  router.use(authenticateJWT);

  // Enforce 256KB body limit at the parser level (not bypassable via headers)
  router.use(express.json({ limit: '256kb' }));

  const submissionLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: {
      success: false,
      error: 'Rate limit exceeded for forecast job submissions.',
    },
    standardHeaders: true,
    legacyHeaders: false,
  });

  router.post('/forecast-jobs', submissionLimiter, (req, res) => {
    try {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        return res
          .status(400)
          .json({ success: false, error: 'Request body must be a JSON object.' });
      }

      const job = orchestrator.submitJob(req.body as Record<string, unknown>);
      return res.status(202).json({
        success: true,
        jobId: job.jobId,
        status: job.status,
        submittedAt: job.submittedAt,
      });
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to submit forecast job',
      });
    }
  });

  router.get('/forecast-jobs/:jobId', (req, res) => {
    const jobId = req.params.jobId;
    const job = orchestrator.getJob(jobId);
    if (!job) {
      return res.status(404).json({
        success: false,
        error: 'Forecast job not found.',
      });
    }

    return res.json({
      success: true,
      job: sanitizeJobRecord(job),
    });
  });

  router.get('/forecast-jobs', (req, res) => {
    const rawLimit = Number.parseInt(String(req.query.limit || '50'), 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 50;
    const jobs = orchestrator.listJobs(limit).map(sanitizeJobRecord);
    return res.json({
      success: true,
      jobs,
      total: orchestrator.jobCount(),
    });
  });

  router.post('/forecast-jobs/:jobId/cancel', (req, res) => {
    const job = orchestrator.cancelJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({
        success: false,
        error: 'Forecast job not found.',
      });
    }
    return res.json({
      success: true,
      job: sanitizeJobRecord(job),
    });
  });

  return router;
}

function sanitizeJobRecord(job: ForecastJobRecord) {
  return {
    jobId: job.jobId,
    status: job.status,
    progress: job.progress,
    submittedAt: job.submittedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    failedAt: job.failedAt,
    outputCid: job.outputCid,
    error: job.error,
    request: {
      model: job.request.model,
      domainBounds: job.request.domainBounds,
      resolutionKm: job.request.resolutionKm,
      forecastHours: job.request.forecastHours,
      datasets: job.request.datasets,
      computeEnvironment: job.request.computeEnvironment,
      validation: job.request.validation,
      requestedBy: job.request.requestedBy,
    },
  };
}
