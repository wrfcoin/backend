/**
 * Appeals adjudication REST routes -- implements backend#36.
 *
 * Mounts at /api/appeals. Provides endpoints for the full appeal lifecycle:
 * submission, reviewer assignment, decision recording, and outcome publication.
 */

import { Router, Request, Response } from 'express';
import { authenticateJWT } from '../middleware/auth.js';
import {
  AppealsService,
  type AppealPriority,
  type AppealStatus,
} from '../services/appeals-service.js';

const router = Router();

// All appeals operations require authentication (#231)
router.use(authenticateJWT);
const appealsService = new AppealsService();

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error occurred';
}

// ---------------------------------------------------------------------------
// POST /api/appeals -- Submit a new appeal
// ---------------------------------------------------------------------------

router.post('/', (req: Request, res: Response) => {
  try {
    const {
      sanctionId,
      offenseCode,
      severityTier,
      appellantId,
      actorClass,
      priority,
      policyHashReference,
    } = req.body;

    const appeal = appealsService.submitAppeal({
      sanctionId,
      offenseCode,
      severityTier,
      appellantId,
      actorClass,
      priority,
      policyHashReference,
    });

    res.status(201).json({ success: true, data: appeal, timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: getErrorMessage(error),
      timestamp: new Date().toISOString(),
    });
  }
});

// ---------------------------------------------------------------------------
// GET /api/appeals -- List appeals (optional query filters: status, priority)
// ---------------------------------------------------------------------------

router.get('/', (req: Request, res: Response) => {
  try {
    const status = req.query.status as AppealStatus | undefined;
    const priority = req.query.priority as AppealPriority | undefined;
    const appeals = appealsService.listAppeals({ status, priority });

    res.status(200).json({
      success: true,
      count: appeals.length,
      data: appeals,
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

// ---------------------------------------------------------------------------
// GET /api/appeals/sla/breaches -- List SLA-breached appeals
// NOTE: Must be registered before /:id to avoid route collision.
// ---------------------------------------------------------------------------

router.get('/sla/breaches', (_req: Request, res: Response) => {
  try {
    const breaches = appealsService.checkSlaBreaches();

    res.status(200).json({
      success: true,
      count: breaches.length,
      data: breaches,
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

// ---------------------------------------------------------------------------
// GET /api/appeals/publications -- List outcome publication events
// NOTE: Must be registered before /:id to avoid route collision.
// ---------------------------------------------------------------------------

router.get('/publications', (req: Request, res: Response) => {
  try {
    const rawLimit = Number.parseInt(String(req.query.limit ?? '100'), 10);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 5000)) : 100;
    const publications = appealsService.listOutcomePublications(limit);

    res.status(200).json({
      success: true,
      count: publications.length,
      data: publications,
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

// ---------------------------------------------------------------------------
// GET /api/appeals/:id -- Get appeal detail
// ---------------------------------------------------------------------------

router.get('/:id', (req: Request, res: Response) => {
  try {
    const appeal = appealsService.getAppeal(req.params.id);
    if (!appeal) {
      res.status(404).json({
        success: false,
        error: `Appeal not found: "${req.params.id}"`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.status(200).json({ success: true, data: appeal, timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: getErrorMessage(error),
      timestamp: new Date().toISOString(),
    });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/appeals/:id/assign -- Assign a reviewer
// ---------------------------------------------------------------------------

router.put('/:id/assign', (req: Request, res: Response) => {
  try {
    const { reviewerId } = req.body;
    const appeal = appealsService.assignReviewer(req.params.id, reviewerId);

    res.status(200).json({ success: true, data: appeal, timestamp: new Date().toISOString() });
  } catch (error) {
    const msg = getErrorMessage(error);
    const status = msg.includes('not found') ? 404 : 400;
    res.status(status).json({
      success: false,
      error: msg,
      timestamp: new Date().toISOString(),
    });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/appeals/:id/transition -- Transition status
// ---------------------------------------------------------------------------

router.put('/:id/transition', (req: Request, res: Response) => {
  try {
    const { status } = req.body;
    const appeal = appealsService.transitionStatus(req.params.id, status);

    res.status(200).json({ success: true, data: appeal, timestamp: new Date().toISOString() });
  } catch (error) {
    const msg = getErrorMessage(error);
    const statusCode = msg.includes('not found') ? 404 : 400;
    res.status(statusCode).json({
      success: false,
      error: msg,
      timestamp: new Date().toISOString(),
    });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/appeals/:id/decide -- Record a decision
// ---------------------------------------------------------------------------

router.put('/:id/decide', (req: Request, res: Response) => {
  try {
    const { verdict, reasoning, evidenceReferences, policyHashReference, decidedBy } = req.body;
    const appeal = appealsService.recordDecision(req.params.id, {
      verdict,
      reasoning,
      evidenceReferences: evidenceReferences || [],
      policyHashReference: policyHashReference || '',
      decidedBy,
    });

    res.status(200).json({ success: true, data: appeal, timestamp: new Date().toISOString() });
  } catch (error) {
    const msg = getErrorMessage(error);
    const statusCode = msg.includes('not found') ? 404 : 400;
    res.status(statusCode).json({
      success: false,
      error: msg,
      timestamp: new Date().toISOString(),
    });
  }
});

// ---------------------------------------------------------------------------
// POST /api/appeals/:id/publish -- Publish the outcome
// ---------------------------------------------------------------------------

router.post('/:id/publish', (req: Request, res: Response) => {
  try {
    const appeal = appealsService.publishDecision(req.params.id);

    res.status(200).json({ success: true, data: appeal, timestamp: new Date().toISOString() });
  } catch (error) {
    const msg = getErrorMessage(error);
    const statusCode = msg.includes('not found') ? 404 : 400;
    res.status(statusCode).json({
      success: false,
      error: msg,
      timestamp: new Date().toISOString(),
    });
  }
});

// ---------------------------------------------------------------------------
// Reviewer management (convenience for testing / bootstrap)
// ---------------------------------------------------------------------------

router.post('/reviewers', (req: Request, res: Response) => {
  try {
    const { reviewerId } = req.body;
    appealsService.addReviewer(reviewerId);

    res.status(201).json({
      success: true,
      data: { reviewerId },
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

export default router;
