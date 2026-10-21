/**
 * Data Lineage & Provenance API
 * REST endpoints for querying, verifying, and exporting data lineage chains.
 * Issue #213 — Data lineage + provenance API
 */

import express, { Request, Response, NextFunction } from 'express';
import { param, query, validationResult } from 'express-validator';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import winston from 'winston';
import { lineageService } from '../server/services/lineage-service.js';

const router = express.Router();

// Logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/lineage-api.log' }),
    new winston.transports.Console({ format: winston.format.simple() }),
  ],
});

// Security
router.use(helmet());

// Rate limiting
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { success: false, error: 'Too many requests from this IP' },
});

// Response helpers
interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: string;
  requestId: string;
}

const successResponse = <T>(data: T, requestId: string): ApiResponse<T> => ({
  success: true,
  data,
  timestamp: new Date().toISOString(),
  requestId,
});

const errorResponse = (error: string, requestId: string): ApiResponse<never> => ({
  success: false,
  error,
  timestamp: new Date().toISOString(),
  requestId,
});

const getRequestId = (req: Request): string =>
  (req.headers['x-request-id'] as string) || `lin-${Date.now()}`;

// Validation middleware
const handleValidationErrors = (req: Request, res: Response, next: NextFunction): void => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json(
      errorResponse(
        `Validation failed: ${errors.array().map((e) => e.msg).join(', ')}`,
        getRequestId(req)
      )
    );
    return;
  }
  next();
};

// ─── GET /api/lineage/:lineageId ─────────────────────────────────────────────

router.get(
  '/:lineageId',
  generalLimiter,
  [param('lineageId').isString().isLength({ min: 1, max: 128 }).withMessage('Invalid lineage ID')],
  handleValidationErrors,
  async (req: Request, res: Response): Promise<void> => {
    const requestId = getRequestId(req);
    try {
      const record = await lineageService.getRecord(req.params.lineageId);
      if (!record) {
        res.status(404).json(errorResponse('Lineage record not found', requestId));
        return;
      }
      res.json(successResponse(record, requestId));
    } catch (error) {
      logger.error('Error fetching lineage record', { error: error instanceof Error ? error.message : String(error), requestId });
      res.status(500).json(errorResponse('Failed to fetch lineage record', requestId));
    }
  }
);

// ─── GET /api/lineage/:lineageId/ancestors ───────────────────────────────────

router.get(
  '/:lineageId/ancestors',
  generalLimiter,
  [
    param('lineageId').isString().isLength({ min: 1, max: 128 }),
    query('maxDepth').optional().isInt({ min: 1, max: 100 }).toInt(),
  ],
  handleValidationErrors,
  async (req: Request, res: Response): Promise<void> => {
    const requestId = getRequestId(req);
    try {
      const maxDepth = (req.query.maxDepth as unknown as number) || 50;
      const ancestors = await lineageService.getAncestors(req.params.lineageId, maxDepth);
      if (ancestors.length === 0) {
        res.status(404).json(errorResponse('Lineage record not found', requestId));
        return;
      }
      res.json(successResponse({ ancestors, count: ancestors.length }, requestId));
    } catch (error) {
      logger.error('Error fetching ancestors', { error: error instanceof Error ? error.message : String(error), requestId });
      res.status(500).json(errorResponse('Failed to fetch ancestors', requestId));
    }
  }
);

// ─── GET /api/lineage/:lineageId/descendants ─────────────────────────────────

router.get(
  '/:lineageId/descendants',
  generalLimiter,
  [
    param('lineageId').isString().isLength({ min: 1, max: 128 }),
    query('maxDepth').optional().isInt({ min: 1, max: 100 }).toInt(),
  ],
  handleValidationErrors,
  async (req: Request, res: Response): Promise<void> => {
    const requestId = getRequestId(req);
    try {
      const maxDepth = (req.query.maxDepth as unknown as number) || 50;
      const descendants = await lineageService.getDescendants(req.params.lineageId, maxDepth);
      if (descendants.length === 0) {
        res.status(404).json(errorResponse('Lineage record not found', requestId));
        return;
      }
      res.json(successResponse({ descendants, count: descendants.length }, requestId));
    } catch (error) {
      logger.error('Error fetching descendants', { error: error instanceof Error ? error.message : String(error), requestId });
      res.status(500).json(errorResponse('Failed to fetch descendants', requestId));
    }
  }
);

// ─── GET /api/lineage/by-commit/:commitId ────────────────────────────────────

router.get(
  '/by-commit/:commitId',
  generalLimiter,
  [param('commitId').isString().isLength({ min: 1, max: 128 }).withMessage('Invalid commit ID')],
  handleValidationErrors,
  async (req: Request, res: Response): Promise<void> => {
    const requestId = getRequestId(req);
    try {
      const records = await lineageService.getByCommitId(req.params.commitId);
      res.json(successResponse({ records, count: records.length }, requestId));
    } catch (error) {
      logger.error('Error fetching by commit ID', { error: error instanceof Error ? error.message : String(error), requestId });
      res.status(500).json(errorResponse('Failed to fetch lineage by commit ID', requestId));
    }
  }
);

// ─── GET /api/lineage/by-station/:stationId ──────────────────────────────────

router.get(
  '/by-station/:stationId',
  generalLimiter,
  [
    param('stationId').isString().isLength({ min: 1, max: 128 }).withMessage('Invalid station ID'),
    query('limit').optional().isInt({ min: 1, max: 1000 }).toInt(),
  ],
  handleValidationErrors,
  async (req: Request, res: Response): Promise<void> => {
    const requestId = getRequestId(req);
    try {
      const limit = (req.query.limit as unknown as number) || 100;
      const records = await lineageService.getByStationId(req.params.stationId, limit);
      res.json(successResponse({ records, count: records.length }, requestId));
    } catch (error) {
      logger.error('Error fetching by station ID', { error: error instanceof Error ? error.message : String(error), requestId });
      res.status(500).json(errorResponse('Failed to fetch lineage by station ID', requestId));
    }
  }
);

// ─── GET /api/lineage/:lineageId/integrity ───────────────────────────────────

router.get(
  '/:lineageId/integrity',
  generalLimiter,
  [param('lineageId').isString().isLength({ min: 1, max: 128 })],
  handleValidationErrors,
  async (req: Request, res: Response): Promise<void> => {
    const requestId = getRequestId(req);
    try {
      const report = await lineageService.verifyIntegrity(req.params.lineageId);
      res.json(successResponse(report, requestId));
    } catch (error) {
      logger.error('Error verifying integrity', { error: error instanceof Error ? error.message : String(error), requestId });
      res.status(500).json(errorResponse('Failed to verify lineage integrity', requestId));
    }
  }
);

// ─── GET /api/lineage/:lineageId/export ──────────────────────────────────────

router.get(
  '/:lineageId/export',
  generalLimiter,
  [
    param('lineageId').isString().isLength({ min: 1, max: 128 }),
    query('format').optional().isIn(['json', 'iso19115']).withMessage('Format must be json or iso19115'),
  ],
  handleValidationErrors,
  async (req: Request, res: Response): Promise<void> => {
    const requestId = getRequestId(req);
    try {
      const format = (req.query.format as 'json' | 'iso19115') || 'json';
      const exported = await lineageService.exportChain(req.params.lineageId, format);
      res.json(successResponse(exported, requestId));
    } catch (error) {
      logger.error('Error exporting lineage', { error: error instanceof Error ? error.message : String(error), requestId });
      res.status(500).json(errorResponse('Failed to export lineage chain', requestId));
    }
  }
);

// Error handler
router.use((error: Error, req: Request, res: Response, _next: NextFunction) => {
  const requestId = getRequestId(req);
  logger.error('Lineage API error', {
    error: error.message,
    stack: error.stack,
    requestId,
  });
  res.status(500).json(errorResponse('Internal server error', requestId));
});

export { router as lineageAPI };
