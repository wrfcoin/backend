import { Router, Request, Response } from 'express';
import { authenticateJWT } from '../middleware/auth.js';
import {
  environmentPhase2ReportsService,
  EnvironmentDomain,
} from '../services/environment-phase2-reports-service.js';

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error occurred';
}

export function createEnvironmentReportsRouter(): Router {
  const router = Router();

  // All environment report operations require authentication (#231)
  router.use(authenticateJWT);

  router.post('/soil/ingest', (req: Request, res: Response) => {
    try {
      const report = environmentPhase2ReportsService.ingestSoil(req.body);
      res.status(201).json({ success: true, data: report, timestamp: new Date().toISOString() });
    } catch (error) {
      res.status(400).json({
        success: false,
        error: getErrorMessage(error),
        timestamp: new Date().toISOString(),
      });
    }
  });

  router.post('/ocean/ingest', (req: Request, res: Response) => {
    try {
      const report = environmentPhase2ReportsService.ingestOcean(req.body);
      res.status(201).json({ success: true, data: report, timestamp: new Date().toISOString() });
    } catch (error) {
      res.status(400).json({
        success: false,
        error: getErrorMessage(error),
        timestamp: new Date().toISOString(),
      });
    }
  });

  router.post('/hydrology/ingest', (req: Request, res: Response) => {
    try {
      const report = environmentPhase2ReportsService.ingestHydrology(req.body);
      res.status(201).json({ success: true, data: report, timestamp: new Date().toISOString() });
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
      const domain = req.query.domain as EnvironmentDomain | undefined;
      const region = req.query.region as string | undefined;
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const data = environmentPhase2ReportsService.listReports({ domain, region, limit });
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

  router.get('/summary', (_req: Request, res: Response) => {
    res.status(200).json({
      success: true,
      data: environmentPhase2ReportsService.getPhase2Overview(),
      timestamp: new Date().toISOString(),
    });
  });

  router.get('/summary/:domain', (req: Request, res: Response) => {
    const domain = req.params.domain as EnvironmentDomain;
    if (!['soil', 'ocean', 'hydrology'].includes(domain)) {
      res.status(400).json({
        success: false,
        error: 'domain must be one of: soil, ocean, hydrology',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: environmentPhase2ReportsService.getDomainSummary(domain),
      timestamp: new Date().toISOString(),
    });
  });

  router.get('/docs', (_req: Request, res: Response) => {
    res.status(200).json({
      success: true,
      data: {
        schemaVersion: 'env-phase2-v1',
        endpoints: [
          { method: 'POST', path: '/api/environment/reports/soil/ingest' },
          { method: 'POST', path: '/api/environment/reports/ocean/ingest' },
          { method: 'POST', path: '/api/environment/reports/hydrology/ingest' },
          { method: 'GET', path: '/api/environment/reports/reports?domain=<soil|ocean|hydrology>&region=<region>&limit=<n>' },
          { method: 'GET', path: '/api/environment/reports/summary' },
          { method: 'GET', path: '/api/environment/reports/summary/<domain>' },
          { method: 'GET', path: '/api/environment/reports/docs' },
        ],
        notes: [
          'Inputs are normalized into deterministic canonical output per domain.',
          'Outputs are privacy-safe and contain no participant identifiers.',
        ],
      },
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}

const defaultRouter = createEnvironmentReportsRouter();
export default defaultRouter;
