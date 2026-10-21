/**
 * Sanctions orchestration routes -- implements backend#33 and backend#40.
 *
 * Mount path: /api/sanctions/orchestration
 */

import { Router, Request, Response } from 'express';
import { authenticateJWT } from '../middleware/auth.js';
import {
  GuardrailHaltError,
  SanctionsOrchestrationService,
  sanctionsOrchestrationService,
  type ActorClass,
  type ParityGuardrailHalt,
  type SanctionLifecycleStatus,
  type SanctionTransitionAction,
} from '../services/sanctions-orchestration-service.js';

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error occurred';
}

export function createSanctionsOrchestrationRouter(service?: SanctionsOrchestrationService): Router {
  const router = Router();

  // All sanctions orchestration operations require authentication (#231)
  router.use(authenticateJWT);
  const orchestrationService = service ?? sanctionsOrchestrationService;

  router.post('/cases', (req: Request, res: Response) => {
    try {
      const created = orchestrationService.createSanctionCase({
        actorId: req.body?.actorId,
        actorClass: req.body?.actorClass,
        offenseCode: req.body?.offenseCode,
        severityTier: req.body?.severityTier,
        rationale: req.body?.rationale,
        policyHashReference: req.body?.policyHashReference,
        policyVersion: req.body?.policyVersion,
        requestedBy: req.body?.requestedBy,
        temporaryBanBlocks: req.body?.temporaryBanBlocks,
        slashBps: req.body?.slashBps,
        cooldownBlocks: req.body?.cooldownBlocks,
      });

      res.status(201).json({
        success: true,
        data: created,
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

  router.get('/cases', (req: Request, res: Response) => {
    try {
      const status = req.query.status as SanctionLifecycleStatus | undefined;
      const actorClass = req.query.actorClass as ActorClass | undefined;
      const cases = orchestrationService.listSanctionCases({ status, actorClass });

      res.status(200).json({
        success: true,
        count: cases.length,
        data: cases,
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

  router.get('/metrics', (_req: Request, res: Response) => {
    try {
      res.status(200).json({
        success: true,
        data: orchestrationService.getMetrics(),
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
      const events = orchestrationService.listAuditTrail();
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

  router.get('/guardrail/status', (_req: Request, res: Response) => {
    try {
      res.status(200).json({
        success: true,
        data: orchestrationService.getGuardrailState(),
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

  router.get('/guardrail/halts', (req: Request, res: Response) => {
    try {
      const status = req.query.status as ParityGuardrailHalt['status'] | undefined;
      const sanctionCaseId = req.query.sanctionCaseId as string | undefined;
      const halts = orchestrationService.listGuardrailHalts({ status, sanctionCaseId });

      res.status(200).json({
        success: true,
        count: halts.length,
        data: halts,
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

  router.post('/guardrail/config', (req: Request, res: Response) => {
    try {
      const state = orchestrationService.updateGuardrailConfig({
        requestedBy: req.body?.requestedBy,
        enabled: req.body?.enabled,
        maxRelativeDelta: req.body?.maxRelativeDelta,
        minComparableCases: req.body?.minComparableCases,
        escalationChannel: req.body?.escalationChannel,
        reason: req.body?.reason,
      });

      res.status(200).json({
        success: true,
        data: state,
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

  router.get('/cases/:id', (req: Request, res: Response) => {
    try {
      const found = orchestrationService.getSanctionCase(req.params.id);
      if (!found) {
        res.status(404).json({
          success: false,
          error: `Sanction case not found: ${req.params.id}`,
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

  router.get('/cases/:id/audit', (req: Request, res: Response) => {
    try {
      const found = orchestrationService.getSanctionCase(req.params.id);
      if (!found) {
        res.status(404).json({
          success: false,
          error: `Sanction case not found: ${req.params.id}`,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const events = orchestrationService.listAuditTrail(req.params.id);
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

  router.post('/cases/:id/transitions', (req: Request, res: Response) => {
    try {
      const transitioned = orchestrationService.transitionSanctionCase(req.params.id, {
        action: req.body?.action as SanctionTransitionAction,
        requestedBy: req.body?.requestedBy,
        currentBlock: req.body?.currentBlock,
        reason: req.body?.reason,
        evidenceReferences: req.body?.evidenceReferences,
        slashTxReference: req.body?.slashTxReference,
        guardrailOverride: req.body?.guardrailOverride,
      });

      res.status(200).json({
        success: true,
        data: transitioned,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      if (error instanceof GuardrailHaltError) {
        res.status(409).json({
          success: false,
          error: error.message,
          code: 'PARITY_GUARDRAIL_HALT',
          halt: error.halt,
          escalation: {
            channel: error.halt.escalationChannel,
            message: 'Sanction transition halted pending parity review or audited override.',
          },
          timestamp: new Date().toISOString(),
        });
        return;
      }

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

const defaultRouter = createSanctionsOrchestrationRouter();
export default defaultRouter;
