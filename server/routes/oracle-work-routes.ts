import { AsyncLocalStorage } from 'node:async_hooks';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import {
  assertOraclePrincipalOwnsOracle,
  assertVerifiedOraclePrincipal,
  ORACLE_WORK_SCOPES,
  OracleWorkBroker,
  OracleWorkBrokerError,
  type VerifiedOraclePrincipal,
  type VerifiedMinedApproval,
} from '../services/oracle-work-broker.js';
export { requireOracleWorkRoutingDependencies } from '../services/oracle-work-routing-gate.js';
import type {
  OracleMinedApprovalResolver,
  OraclePrincipalResolver,
  OracleWorkRoutingDependencies as RoutingDependencies,
} from '../services/oracle-work-routing-gate.js';
export type { OracleMinedApprovalResolver, OraclePrincipalResolver } from '../services/oracle-work-routing-gate.js';

export type OracleWorkRoutingDependencies = RoutingDependencies<OraclePrincipalResolver, OracleMinedApprovalResolver>;

/**
 * Production is intentionally disabled until deployment selects a dedicated
 * worker credential verifier (mTLS or workload identity) and maps its verified
 * subject to exactly one allowed oracle. User JWTs, request properties, and
 * caller-supplied oracle IDs are never an oracle credential contract.
 */
export function resolveUnconfiguredOracleWorker(_request: Request): VerifiedOraclePrincipal | null {
  return null;
}

export function resolveUnconfiguredMinedApproval(_request: Request): VerifiedMinedApproval | null {
  return null;
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof OracleWorkBrokerError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  res.status(503).json({ error: { code: 'ORACLE_WORK_UNAVAILABLE', message: 'oracle work service unavailable' } });
}

const verifiedPrincipalContext = new AsyncLocalStorage<VerifiedOraclePrincipal>();

function principalFromAuthenticatedContext(): VerifiedOraclePrincipal | undefined {
  return verifiedPrincipalContext.getStore();
}

export function createOracleWorkRouter(options: {
  broker: OracleWorkBroker;
  resolvePrincipal: OraclePrincipalResolver;
  resolveMinedApproval: OracleMinedApprovalResolver;
}): ReturnType<typeof Router> {
  const router = Router();

  const resolve: RequestHandler = async (req, res, next) => {
    try {
      const principal = await options.resolvePrincipal(req);
      if (!principal) {
        res.status(401).json({ error: { code: 'ORACLE_PRINCIPAL_REQUIRED', message: 'verified oracle principal is required' } });
        return;
      }
      verifiedPrincipalContext.run(principal, next);
    } catch (error) {
      sendError(res, error);
    }
  };

  router.use(resolve);

  router.get('/:workId', async (req, res) => {
    try {
      const principal = principalFromAuthenticatedContext();
      assertVerifiedOraclePrincipal(principal, ORACLE_WORK_SCOPES.read);
      res.json(await options.broker.getWork(principal, req.params.workId));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/:workId/claim', async (req, res) => {
    try {
      const principal = principalFromAuthenticatedContext();
      assertVerifiedOraclePrincipal(principal, ORACLE_WORK_SCOPES.claim);
      res.json(await options.broker.claimWork(principal, req.params.workId));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/:workId/result', async (req, res) => {
    try {
      const principal = principalFromAuthenticatedContext();
      assertVerifiedOraclePrincipal(principal, ORACLE_WORK_SCOPES.result);
      res.json(await options.broker.recordResult(principal, {
        ...(req.body || {}),
        workId: req.params.workId,
      }));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/:workId/mined-approval', async (req, res) => {
    try {
      const principal = assertVerifiedOraclePrincipal(principalFromAuthenticatedContext(), ORACLE_WORK_SCOPES.result);
      const readback = await options.resolveMinedApproval(req);
      if (!readback) {
        throw new OracleWorkBrokerError('CORE4_READBACK_REQUIRED', 'verified Core4 mined readback is required', 503);
      }
      if (readback.workId !== req.params.workId) {
        throw new OracleWorkBrokerError('CORE4_READBACK_BINDING_INVALID', 'Core4 readback work ID does not match the route', 409);
      }
      assertOraclePrincipalOwnsOracle(principal, readback.oracleId);
      res.json(await options.broker.reconcileMinedApproval(readback));
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
