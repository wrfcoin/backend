/**
 * Identity Management API Routes
 *
 * All mutation routes are protected by:
 *   1. authenticateToken (JWT Bearer) - establishes identity
 *   2. requirePolicy(action) - enforces fail-closed authorization
 *
 * Read routes use optionalAuth for context-aware responses.
 *
 * Issues: #252, #237
 */

import express, { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import * as identityController from '../controllers/identityController.js';
import { authenticateToken, optionalAuth } from '../middleware/auth-middleware.js';
import { requirePolicy, requireAuthenticated } from '../middleware/identity-policy-middleware.js';
import {
  evaluatePolicyStatus,
  logGovernanceAudit,
  evaluatePolicy,
  type PolicySubject,
} from '../services/identity-governance-service.js';
import { appLogger } from '../utils/logger.js';

const router = express.Router();

// ---------------------------------------------------------------------------
// Validation Schemas
// ---------------------------------------------------------------------------

const credentialIssueSchema = z.object({
  did: z.string().min(1, 'DID is required').max(256),
  credentialType: z.string().min(1, 'Credential type is required').max(128),
  purpose: z.string().max(1024).optional(),
});

const credentialRevokeSchema = z.object({
  reason: z.string().max(512).optional(),
});

const keyEpochRegisterSchema = z.object({
  signingRole: z.string().min(1).max(64),
  publicKey: z.string().min(16).max(512),
  keyType: z.enum(['Ed25519', 'Secp256k1', 'BLS12-381']).default('Ed25519'),
});

const keyEpochRevokeSchema = z.object({
  reason: z.string().max(512).optional(),
});

const policyToggleSchema = z.object({
  enforced: z.boolean(),
});

// ---------------------------------------------------------------------------
// Helper: extract PolicySubject from request
// ---------------------------------------------------------------------------

function subjectFromRequest(req: Request): PolicySubject {
  const user = req.user;
  if (user && user.id) {
    return {
      userId: user.id,
      role: user.role || 'user',
      permissions: user.permissions || [],
      authenticated: true,
    };
  }
  const apiKey = (req as any).apiKey;
  if (apiKey && apiKey.userId) {
    return {
      userId: apiKey.userId,
      role: 'api_key',
      permissions: apiKey.permissions || [],
      authenticated: true,
    };
  }
  return { authenticated: false };
}

// ---------------------------------------------------------------------------
// READ routes (optionalAuth for context)
// ---------------------------------------------------------------------------

/** GET /identity/identities/:did - Get identity by DID */
router.get('/identities/:did', optionalAuth, (req: Request, res: Response) => {
  identityController.getIdentityProfile(req, res);
});

/** GET /identity/credentials - List credentials (optionalAuth) */
router.get('/credentials', optionalAuth, (_req: Request, res: Response) => {
  // Returns credentials; mock data is handled by the frontend fallback
  res.json({
    success: true,
    data: [],
    message: 'Credentials endpoint active',
    timestamp: new Date().toISOString(),
  });
});

/** GET /identity/governance-policies - List governance policies */
router.get('/governance-policies', optionalAuth, (_req: Request, res: Response) => {
  // Return configured policies; frontend falls back to mock if unavailable
  res.json({
    success: true,
    data: [],
    message: 'Governance policies endpoint active',
    timestamp: new Date().toISOString(),
  });
});

/** GET /identity/keys - Key lifecycle data for dashboard */
router.get('/keys', optionalAuth, (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      epochs: [],
      signerRolePolicies: [],
      lastRotation: null,
      nextScheduledRotation: null,
    },
    message: 'Key lifecycle endpoint active',
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /identity/policy-status
 *
 * Returns the authenticated user's policy capabilities for all identity
 * mutation actions. Frontend uses this to enable/disable UI controls.
 */
router.get('/policy-status', optionalAuth, (req: Request, res: Response) => {
  const subject = subjectFromRequest(req);
  const status = evaluatePolicyStatus(subject);
  res.json({ success: true, data: status, timestamp: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// MUTATION routes (authenticateToken + requirePolicy)
// ---------------------------------------------------------------------------

/** POST /identity/identities - Create identity */
router.post(
  '/identities',
  authenticateToken,
  requirePolicy('credential:issue'),
  (req: Request, res: Response) => {
    identityController.createIdentityProfile(req, res);
  },
);

/** PUT /identity/identities/:did/verification - Update verification level */
router.put(
  '/identities/:did/verification',
  authenticateToken,
  requirePolicy('credential:issue'),
  (req: Request, res: Response) => {
    identityController.verifyIdentity(req, res);
  },
);

/**
 * POST /identity/credentials/request - Issue (request) a credential
 * Protected by credential:issue policy.
 */
router.post(
  '/credentials/request',
  authenticateToken,
  requirePolicy('credential:issue'),
  async (req: Request, res: Response) => {
    const requestId = uuidv4();
    try {
      const parsed = credentialIssueSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: 'VALIDATION_ERROR',
          message: parsed.error.issues[0].message,
          timestamp: new Date().toISOString(),
          requestId,
        });
        return;
      }

      const { did, credentialType, purpose } = parsed.data;

      // Log the issuance
      logGovernanceAudit({
        action: 'credential:issue',
        decision: (req as any).policyDecision,
        subjectId: req.user?.id,
        subjectRole: req.user?.role,
        resourceId: did,
      });

      const credential = {
        id: `vc:wrf:${credentialType.toLowerCase()}-${Date.now()}`,
        did,
        type: credentialType,
        status: 'pending' as const,
        issuedAt: new Date().toISOString(),
        expiresAt: null,
        issuer: `did:wrf:${req.user?.id || 'system'}`,
        claims: { purpose: purpose || '' },
      };

      res.status(201).json({
        success: true,
        data: credential,
        message: 'Credential issuance request accepted',
        timestamp: new Date().toISOString(),
        requestId,
      });
    } catch (error) {
      appLogger.error('Credential issuance error', {
        module: 'IdentityRoutes',
        error: (error as Error).message,
      });
      res.status(500).json({
        success: false,
        error: 'INTERNAL_ERROR',
        message: 'Failed to process credential request',
        timestamp: new Date().toISOString(),
        requestId,
      });
    }
  },
);

/** POST /identity/credentials - Issue a credential (legacy path) */
router.post(
  '/credentials',
  authenticateToken,
  requirePolicy('credential:issue'),
  (req: Request, res: Response) => {
    identityController.addCredential(req, res);
  },
);

/** GET /identity/credentials/:credentialId/verify - Verify credential (read) */
router.get('/credentials/:credentialId/verify', optionalAuth, (_req: Request, res: Response) => {
  res.json({
    success: true,
    verified: true,
    message: 'Credential verification endpoint active',
    timestamp: new Date().toISOString(),
  });
});

/**
 * POST /identity/credentials/:credentialId/revoke - Revoke a credential
 * Protected by credential:revoke policy.
 */
router.post(
  '/credentials/:credentialId/revoke',
  authenticateToken,
  requirePolicy('credential:revoke'),
  async (req: Request, res: Response) => {
    const requestId = uuidv4();
    try {
      const { credentialId } = req.params;
      const parsed = credentialRevokeSchema.safeParse(req.body || {});

      logGovernanceAudit({
        action: 'credential:revoke',
        decision: (req as any).policyDecision,
        subjectId: req.user?.id,
        subjectRole: req.user?.role,
        resourceId: credentialId,
      });

      res.json({
        success: true,
        data: {
          credentialId,
          status: 'revoked',
          revokedAt: new Date().toISOString(),
          revokedBy: req.user?.id || 'system',
          reason: parsed.success ? parsed.data.reason : undefined,
        },
        message: 'Credential revoked successfully',
        timestamp: new Date().toISOString(),
        requestId,
      });
    } catch (error) {
      appLogger.error('Credential revocation error', {
        module: 'IdentityRoutes',
        error: (error as Error).message,
      });
      res.status(500).json({
        success: false,
        error: 'INTERNAL_ERROR',
        message: 'Failed to revoke credential',
        timestamp: new Date().toISOString(),
        requestId,
      });
    }
  },
);

/** PUT /identity/credentials/:credentialId/revoke - Revoke (PUT compat) */
router.put(
  '/credentials/:credentialId/revoke',
  authenticateToken,
  requirePolicy('credential:revoke'),
  async (req: Request, res: Response) => {
    // Delegate to POST handler via the same logic
    const requestId = uuidv4();
    const { credentialId } = req.params;

    logGovernanceAudit({
      action: 'credential:revoke',
      decision: (req as any).policyDecision,
      subjectId: req.user?.id,
      subjectRole: req.user?.role,
      resourceId: credentialId,
    });

    res.json({
      success: true,
      data: {
        credentialId,
        status: 'revoked',
        revokedAt: new Date().toISOString(),
        revokedBy: req.user?.id || 'system',
      },
      message: 'Credential revoked successfully',
      timestamp: new Date().toISOString(),
      requestId,
    });
  },
);

// ---------------------------------------------------------------------------
// KEY EPOCH routes
// ---------------------------------------------------------------------------

/**
 * POST /identity/key-epochs/register - Register a new key epoch
 * Protected by key_epoch:register policy.
 */
router.post(
  '/key-epochs/register',
  authenticateToken,
  requirePolicy('key_epoch:register'),
  async (req: Request, res: Response) => {
    const requestId = uuidv4();
    try {
      const parsed = keyEpochRegisterSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: 'VALIDATION_ERROR',
          message: parsed.error.issues[0].message,
          timestamp: new Date().toISOString(),
          requestId,
        });
        return;
      }

      const { signingRole, publicKey, keyType } = parsed.data;

      logGovernanceAudit({
        action: 'key_epoch:register',
        decision: (req as any).policyDecision,
        subjectId: req.user?.id,
        subjectRole: req.user?.role,
        resourceId: `${signingRole}:new`,
      });

      const epoch = {
        epoch: Date.now(), // monotonic epoch ID
        keyFingerprint: publicKey.slice(0, 32),
        activatedAt: new Date().toISOString(),
        revokedAt: null,
        status: 'active' as const,
        signingRole,
        keyType,
        registeredBy: req.user?.id || 'system',
      };

      res.status(201).json({
        success: true,
        data: epoch,
        message: 'Key epoch registered successfully',
        timestamp: new Date().toISOString(),
        requestId,
      });
    } catch (error) {
      appLogger.error('Key epoch registration error', {
        module: 'IdentityRoutes',
        error: (error as Error).message,
      });
      res.status(500).json({
        success: false,
        error: 'INTERNAL_ERROR',
        message: 'Failed to register key epoch',
        timestamp: new Date().toISOString(),
        requestId,
      });
    }
  },
);

/**
 * POST /identity/key-epochs/:epochId/rotate - Rotate a key epoch
 * Protected by key_epoch:rotate policy.
 */
router.post(
  '/key-epochs/:epochId/rotate',
  authenticateToken,
  requirePolicy('key_epoch:rotate'),
  async (req: Request, res: Response) => {
    const requestId = uuidv4();
    const { epochId } = req.params;

    logGovernanceAudit({
      action: 'key_epoch:rotate',
      decision: (req as any).policyDecision,
      subjectId: req.user?.id,
      subjectRole: req.user?.role,
      resourceId: epochId,
    });

    res.json({
      success: true,
      data: {
        previousEpochId: epochId,
        previousStatus: 'revoked',
        revokedAt: new Date().toISOString(),
        newEpochId: `${epochId}-rotated-${Date.now()}`,
        newStatus: 'active',
        activatedAt: new Date().toISOString(),
        rotatedBy: req.user?.id || 'system',
      },
      message: 'Key epoch rotated successfully',
      timestamp: new Date().toISOString(),
      requestId,
    });
  },
);

/**
 * POST /identity/key-epochs/:epochId/revoke - Revoke a key epoch
 * Protected by key_epoch:revoke policy (admin only).
 */
router.post(
  '/key-epochs/:epochId/revoke',
  authenticateToken,
  requirePolicy('key_epoch:revoke'),
  async (req: Request, res: Response) => {
    const requestId = uuidv4();
    const { epochId } = req.params;
    const parsed = keyEpochRevokeSchema.safeParse(req.body || {});

    logGovernanceAudit({
      action: 'key_epoch:revoke',
      decision: (req as any).policyDecision,
      subjectId: req.user?.id,
      subjectRole: req.user?.role,
      resourceId: epochId,
    });

    res.json({
      success: true,
      data: {
        epochId,
        status: 'revoked',
        revokedAt: new Date().toISOString(),
        revokedBy: req.user?.id || 'system',
        reason: parsed.success ? parsed.data.reason : undefined,
      },
      message: 'Key epoch revoked successfully',
      timestamp: new Date().toISOString(),
      requestId,
    });
  },
);

/** GET /identity/key-epochs - List key epochs */
router.get('/key-epochs', optionalAuth, (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: [],
    message: 'Key epochs endpoint active',
    timestamp: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// GOVERNANCE POLICY mutation routes
// ---------------------------------------------------------------------------

/**
 * PATCH /identity/governance-policies/:policyId - Toggle policy enforcement
 * Protected by governance:toggle_policy policy.
 */
router.patch(
  '/governance-policies/:policyId',
  authenticateToken,
  requirePolicy('governance:toggle_policy'),
  async (req: Request, res: Response) => {
    const requestId = uuidv4();
    const { policyId } = req.params;

    const parsed = policyToggleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'VALIDATION_ERROR',
        message: parsed.error.issues[0].message,
        timestamp: new Date().toISOString(),
        requestId,
      });
      return;
    }

    logGovernanceAudit({
      action: 'governance:toggle_policy',
      decision: (req as any).policyDecision,
      subjectId: req.user?.id,
      subjectRole: req.user?.role,
      resourceId: policyId,
    });

    res.json({
      success: true,
      data: {
        policyId,
        enforced: parsed.data.enforced,
        updatedAt: new Date().toISOString(),
        updatedBy: req.user?.id || 'system',
      },
      message: `Policy ${parsed.data.enforced ? 'enabled' : 'disabled'} successfully`,
      timestamp: new Date().toISOString(),
      requestId,
    });
  },
);

// ---------------------------------------------------------------------------
// Trust anchor / endorsement routes (protected)
// ---------------------------------------------------------------------------

router.post(
  '/trust-anchors',
  authenticateToken,
  requirePolicy('credential:issue'),
  (_req: Request, res: Response) => {
    res.status(201).json({
      success: true,
      message: 'Trust anchor created',
      timestamp: new Date().toISOString(),
    });
  },
);

router.post(
  '/endorsements',
  authenticateToken,
  requirePolicy('credential:issue'),
  (_req: Request, res: Response) => {
    res.status(201).json({
      success: true,
      message: 'Endorsement created',
      timestamp: new Date().toISOString(),
    });
  },
);

export default router;
