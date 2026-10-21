import { Router, Request, Response } from 'express';
import { authenticateJWT } from '../middleware/auth.js';
import {
  AbuseRiskService,
  RiskBand,
  RiskOutcome,
  abuseRiskService,
} from '../services/abuse-risk-service.js';

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error occurred';
}

export function createAbuseRiskRouter(service?: AbuseRiskService): Router {
  const router = Router();

  // All abuse risk operations require authentication (#231)
  router.use(authenticateJWT);

  const riskService = service ?? abuseRiskService;

  // Risk factor catalog is published as auditable policy metadata.
  router.get('/factors', (_req: Request, res: Response) => {
    res.status(200).json({
      success: true,
      count: riskService.getFactorDefinitions().length,
      data: riskService.getFactorDefinitions(),
      timestamp: new Date().toISOString(),
    });
  });

  router.get('/metrics', (_req: Request, res: Response) => {
    try {
      res.status(200).json({
        success: true,
        data: riskService.getMetrics(),
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

  router.post('/assess', (req: Request, res: Response) => {
    try {
      const {
        participantId,
        actorClass,
        indicators = {},
        evidenceConfidence,
        appealOverturnRate,
        observedAt,
      } = req.body;

      const assessment = riskService.assessParticipant({
        participantId,
        actorClass,
        indicators,
        evidenceConfidence,
        appealOverturnRate,
        observedAt,
      });

      res.status(201).json({
        success: true,
        data: assessment,
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

  router.get('/', (req: Request, res: Response) => {
    try {
      const riskBand = req.query.riskBand as RiskBand | undefined;
      const data = riskService.listAssessments({ riskBand });
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

  router.get('/:id', (req: Request, res: Response) => {
    try {
      const found = riskService.getAssessment(req.params.id);
      if (!found) {
        res.status(404).json({
          success: false,
          error: `Assessment not found: ${req.params.id}`,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: found,
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

  router.post('/:id/outcome', (req: Request, res: Response) => {
    try {
      const outcome = req.body?.outcome as RiskOutcome | undefined;
      if (!outcome) {
        throw new Error('outcome is required');
      }

      const updated = riskService.recordOutcome(req.params.id, outcome);
      res.status(200).json({
        success: true,
        data: {
          assessmentId: updated.assessmentId,
          outcome,
          metrics: riskService.getMetrics(),
        },
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

const defaultRouter = createAbuseRiskRouter();
export default defaultRouter;
