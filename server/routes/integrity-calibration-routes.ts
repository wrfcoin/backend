/**
 * Integrity threshold calibration routes -- implements backend#37.
 *
 * Mount path: /api/integrity/calibration
 */

import { Router, Request, Response } from 'express';
import { authenticateJWT } from '../middleware/auth.js';
import {
  IntegrityThresholdCalibrationService,
  integrityThresholdCalibrationService,
} from '../services/integrity-threshold-calibration-service.js';

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error occurred';
}

export function createIntegrityCalibrationRouter(
  service?: IntegrityThresholdCalibrationService,
): Router {
  const router = Router();
  const calibrationService = service ?? integrityThresholdCalibrationService;

  // Calibration governs the anti-abuse / anti-sybil thresholds; activate and
  // rollback are privileged operations. Gate the whole family behind
  // authenticateJWT, matching every sibling in the /api/integrity/* family
  // (abuse-risk-routes.ts, sybil-detection-routes.ts). See #901.
  router.use(authenticateJWT);

  router.get('/config/active', (_req: Request, res: Response) => {
    try {
      res.status(200).json({
        success: true,
        data: calibrationService.getActiveConfig(),
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error),
        timestamp: new Date().toISOString(),
      });
    }
  });

  router.get('/config', (_req: Request, res: Response) => {
    try {
      const configs = calibrationService.listConfigs();
      res.status(200).json({
        success: true,
        count: configs.length,
        data: configs,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error),
        timestamp: new Date().toISOString(),
      });
    }
  });

  router.get('/jobs', (_req: Request, res: Response) => {
    try {
      const jobs = calibrationService.listRuns();
      res.status(200).json({
        success: true,
        count: jobs.length,
        data: jobs,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error),
        timestamp: new Date().toISOString(),
      });
    }
  });

  router.post('/jobs/run', (req: Request, res: Response) => {
    try {
      const report = calibrationService.runCalibrationJob({
        requestedBy: req.body?.requestedBy,
        samples: req.body?.samples,
        notes: req.body?.notes,
        activateCandidate: Boolean(req.body?.activateCandidate),
        referenceSuites: req.body?.referenceSuites,
      });

      res.status(201).json({
        success: true,
        data: report,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(400).json({
        success: false,
        error: getErrorMessage(error),
        timestamp: new Date().toISOString(),
      });
    }
  });

  router.post('/config/activate', (req: Request, res: Response) => {
    try {
      const config = calibrationService.activateConfig(
        req.body?.version,
        req.body?.requestedBy,
      );

      res.status(200).json({
        success: true,
        data: config,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(400).json({
        success: false,
        error: getErrorMessage(error),
        timestamp: new Date().toISOString(),
      });
    }
  });

  router.post('/config/rollback', (req: Request, res: Response) => {
    try {
      const config = calibrationService.rollbackConfig({
        targetVersion: req.body?.targetVersion,
        requestedBy: req.body?.requestedBy,
        reason: req.body?.reason,
      });

      res.status(200).json({
        success: true,
        data: config,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(400).json({
        success: false,
        error: getErrorMessage(error),
        timestamp: new Date().toISOString(),
      });
    }
  });

  router.get('/metrics', (_req: Request, res: Response) => {
    try {
      res.status(200).json({
        success: true,
        data: calibrationService.getLatestMetrics(),
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error),
        timestamp: new Date().toISOString(),
      });
    }
  });

  router.get('/audit', (_req: Request, res: Response) => {
    try {
      const events = calibrationService.listAuditEvents();
      res.status(200).json({
        success: true,
        count: events.length,
        data: events,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error),
        timestamp: new Date().toISOString(),
      });
    }
  });

  router.get('/rollback/runbook', (_req: Request, res: Response) => {
    try {
      res.status(200).json({
        success: true,
        data: calibrationService.getRollbackMetadata(),
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error),
        timestamp: new Date().toISOString(),
      });
    }
  });

  return router;
}

const defaultRouter = createIntegrityCalibrationRouter();
export default defaultRouter;
