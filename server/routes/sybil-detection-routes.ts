import { Router, Request, Response } from 'express';
import { authenticateJWT } from '../middleware/auth.js';
import {
  SybilDetectionService,
  SybilRiskLevel,
  sybilDetectionService,
} from '../services/sybil-detection-service.js';

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error occurred';
}

export function createSybilDetectionRouter(service?: SybilDetectionService): Router {
  const router = Router();

  // All Sybil detection operations require authentication (#231)
  router.use(authenticateJWT);

  const detectionService = service ?? sybilDetectionService;

  router.get('/thresholds', (_req: Request, res: Response) => {
    res.status(200).json({
      success: true,
      data: detectionService.getThresholdConfig(),
      timestamp: new Date().toISOString(),
    });
  });

  router.post('/detect', (req: Request, res: Response) => {
    try {
      const report = detectionService.detect({
        participantId: req.body?.participantId,
        actorClass: req.body?.actorClass,
        indicators: req.body?.indicators ?? {},
        source: req.body?.source,
        observedAt: req.body?.observedAt,
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

  router.get('/reports', (req: Request, res: Response) => {
    try {
      const riskLevel = req.query.riskLevel as SybilRiskLevel | undefined;
      const data = detectionService.listReports({ riskLevel });
      res.status(200).json({
        success: true,
        count: data.length,
        data,
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

  router.get('/reports/:id', (req: Request, res: Response) => {
    try {
      const report = detectionService.getReport(req.params.id);
      if (!report) {
        res.status(404).json({
          success: false,
          error: `Report not found: ${req.params.id}`,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: report,
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

  router.get('/reports/:id/evidence', (req: Request, res: Response) => {
    try {
      const report = detectionService.getReport(req.params.id);
      if (!report) {
        res.status(404).json({
          success: false,
          error: `Report not found: ${req.params.id}`,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const evidence = detectionService.getEvidence(req.params.id);
      res.status(200).json({
        success: true,
        count: evidence.length,
        data: evidence,
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

  router.post('/reports/:id/evidence', (req: Request, res: Response) => {
    try {
      const artifact = detectionService.appendEvidence(req.params.id, {
        type: req.body?.type,
        summary: req.body?.summary,
        opaqueReference: req.body?.opaqueReference,
      });
      res.status(201).json({
        success: true,
        data: artifact,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      const message = getErrorMessage(error);
      const statusCode = message.includes('not found') ? 404 : 400;
      res.status(statusCode).json({
        success: false,
        error: message,
        timestamp: new Date().toISOString(),
      });
    }
  });

  return router;
}

const defaultRouter = createSybilDetectionRouter();
export default defaultRouter;
