/**
 * WebAuthn Routes
 * Task 94.14: API endpoints for WebAuthn/FIDO2 authentication
 *
 * Provides endpoints for:
 * - Credential registration (security keys, biometrics, passkeys)
 * - Authentication
 * - Credential management
 */

import { Router, Request, Response } from 'express';
import { authenticateJWT } from '../middleware/auth.js';
import { body, param, validationResult } from 'express-validator';
import { webauthnService } from '../services/webauthn-service.js';
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from '@simplewebauthn/types';
import { securityLogger, logError } from '../utils/logger.js';

const router = Router();

// Authentication endpoints (/authenticate/*) are public — the user is
// trying to log in. Registration and credential management need auth.

// Standard API response helpers
const successResponse = <T>(data: T) => ({
  success: true,
  data,
  timestamp: new Date().toISOString(),
});

const errorResponse = (message: string, code?: string) => ({
  success: false,
  error: {
    code: code || 'WEBAUTHN_ERROR',
    message,
  },
  timestamp: new Date().toISOString(),
});

// Middleware to extract user from request
const getUserFromRequest = (req: Request): { id: number; username: string; email?: string } | null => {
  const user = (req as any).user;
  if (!user || !user.id) {
    return null;
  }
  return {
    id: typeof user.id === 'string' ? parseInt(user.id, 10) : user.id,
    username: user.username || user.email || `user_${user.id}`,
    email: user.email,
  };
};

// ==============================================
// REGISTRATION ENDPOINTS
// ==============================================

/**
 * POST /api/webauthn/register/options
 * Generate registration options for a new WebAuthn credential
 */
router.post('/register/options', authenticateJWT, async (req: Request, res: Response) => {
  try {
    const user = getUserFromRequest(req);
    if (!user) {
      return res.status(401).json(errorResponse('Authentication required', 'UNAUTHORIZED'));
    }

    const result = await webauthnService.generateRegistrationOptions(user);

    return res.status(200).json(successResponse({
      challengeId: result.challengeId,
      options: result.options,
    }));
  } catch (error) {
    logError(securityLogger, 'WebAuthn registration options error', error as Error, { service: 'webauthn' });
    return res.status(500).json(
      errorResponse(
        error instanceof Error ? error.message : 'Failed to generate registration options',
        'REGISTRATION_OPTIONS_ERROR'
      )
    );
  }
});

/**
 * POST /api/webauthn/register/verify
 * Verify registration response and store credential
 */
router.post(
  '/register/verify',
  authenticateJWT,
  [
    body('challengeId').isString().notEmpty(),
    body('response').isObject(),
    body('friendlyName').optional().isString().isLength({ min: 1, max: 100 }),
  ],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json(errorResponse('Invalid request data', 'VALIDATION_ERROR'));
      }

      const user = getUserFromRequest(req);
      if (!user) {
        return res.status(401).json(errorResponse('Authentication required', 'UNAUTHORIZED'));
      }

      const { challengeId, response, friendlyName } = req.body;

      const result = await webauthnService.verifyRegistration(
        user.id,
        challengeId,
        response as RegistrationResponseJSON,
        friendlyName
      );

      if (!result.success) {
        return res.status(400).json(errorResponse(result.message || 'Registration failed', 'REGISTRATION_FAILED'));
      }

      return res.status(200).json(successResponse({
        message: 'WebAuthn credential registered successfully',
        credential: result.credential ? {
          id: result.credential.id,
          friendlyName: result.credential.friendlyName,
          deviceType: result.credential.deviceType,
          createdAt: result.credential.createdAt,
        } : undefined,
      }));
    } catch (error) {
      logError(securityLogger, 'WebAuthn registration verification error', error as Error, { service: 'webauthn' });
      return res.status(500).json(
        errorResponse(
          error instanceof Error ? error.message : 'Failed to verify registration',
          'REGISTRATION_VERIFY_ERROR'
        )
      );
    }
  }
);

// ==============================================
// AUTHENTICATION ENDPOINTS
// ==============================================

/**
 * POST /api/webauthn/authenticate/options
 * Generate authentication options
 */
router.post('/authenticate/options', async (req: Request, res: Response) => {
  try {
    // User ID is optional for usernameless authentication
    const user = getUserFromRequest(req);
    const userId = user?.id;

    const result = await webauthnService.generateAuthenticationOptions(userId);

    return res.status(200).json(successResponse({
      challengeId: result.challengeId,
      options: result.options,
    }));
  } catch (error) {
    logError(securityLogger, 'WebAuthn authentication options error', error as Error, { service: 'webauthn' });
    return res.status(500).json(
      errorResponse(
        error instanceof Error ? error.message : 'Failed to generate authentication options',
        'AUTHENTICATION_OPTIONS_ERROR'
      )
    );
  }
});

/**
 * POST /api/webauthn/authenticate/verify
 * Verify authentication response
 */
router.post(
  '/authenticate/verify',
  [
    body('challengeId').isString().notEmpty(),
    body('response').isObject(),
  ],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json(errorResponse('Invalid request data', 'VALIDATION_ERROR'));
      }

      const { challengeId, response } = req.body;

      // Get expected user if authenticated
      const user = getUserFromRequest(req);
      const expectedUserId = user?.id;

      const result = await webauthnService.verifyAuthentication(
        challengeId,
        response as AuthenticationResponseJSON,
        expectedUserId
      );

      if (!result.success) {
        return res.status(401).json(errorResponse(result.message || 'Authentication failed', 'AUTHENTICATION_FAILED'));
      }

      return res.status(200).json(successResponse({
        message: 'WebAuthn authentication successful',
        userId: result.userId,
        credential: result.credential ? {
          id: result.credential.id,
          friendlyName: result.credential.friendlyName,
          lastUsedAt: result.credential.lastUsedAt,
        } : undefined,
      }));
    } catch (error) {
      logError(securityLogger, 'WebAuthn authentication verification error', error as Error, { service: 'webauthn' });
      return res.status(500).json(
        errorResponse(
          error instanceof Error ? error.message : 'Failed to verify authentication',
          'AUTHENTICATION_VERIFY_ERROR'
        )
      );
    }
  }
);

// ==============================================
// CREDENTIAL MANAGEMENT ENDPOINTS
// ==============================================

/**
 * GET /api/webauthn/credentials
 * Get all WebAuthn credentials for the authenticated user
 */
router.get('/credentials', authenticateJWT, async (req: Request, res: Response) => {
  try {
    const user = getUserFromRequest(req);
    if (!user) {
      return res.status(401).json(errorResponse('Authentication required', 'UNAUTHORIZED'));
    }

    const credentials = await webauthnService.getUserCredentials(user.id);

    // Return safe credential data (no public keys or sensitive data)
    const safeCredentials = credentials.map(cred => ({
      id: cred.id,
      friendlyName: cred.friendlyName,
      deviceType: cred.deviceType,
      lastUsedAt: cred.lastUsedAt,
      createdAt: cred.createdAt,
      // Truncate credential ID for display
      credentialIdPreview: cred.credentialId.substring(0, 8) + '...',
    }));

    return res.status(200).json(successResponse({
      credentials: safeCredentials,
      count: safeCredentials.length,
    }));
  } catch (error) {
    logError(securityLogger, 'Get WebAuthn credentials error', error as Error, { service: 'webauthn' });
    return res.status(500).json(
      errorResponse('Failed to get credentials', 'GET_CREDENTIALS_ERROR')
    );
  }
});

/**
 * PATCH /api/webauthn/credentials/:credentialId
 * Update credential friendly name
 */
router.patch(
  '/credentials/:credentialId',
  authenticateJWT,
  [
    param('credentialId').isString().notEmpty(),
    body('friendlyName').isString().isLength({ min: 1, max: 100 }),
  ],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json(errorResponse('Invalid request data', 'VALIDATION_ERROR'));
      }

      const user = getUserFromRequest(req);
      if (!user) {
        return res.status(401).json(errorResponse('Authentication required', 'UNAUTHORIZED'));
      }

      const { credentialId } = req.params;
      const { friendlyName } = req.body;

      await webauthnService.updateCredentialName(user.id, credentialId, friendlyName);

      return res.status(200).json(successResponse({
        message: 'Credential updated successfully',
      }));
    } catch (error) {
      logError(securityLogger, 'Update WebAuthn credential error', error as Error, { service: 'webauthn' });
      return res.status(500).json(
        errorResponse(
          error instanceof Error ? error.message : 'Failed to update credential',
          'UPDATE_CREDENTIAL_ERROR'
        )
      );
    }
  }
);

/**
 * DELETE /api/webauthn/credentials/:credentialId
 * Delete a WebAuthn credential
 */
router.delete(
  '/credentials/:credentialId',
  authenticateJWT,
  [param('credentialId').isString().notEmpty()],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json(errorResponse('Invalid request data', 'VALIDATION_ERROR'));
      }

      const user = getUserFromRequest(req);
      if (!user) {
        return res.status(401).json(errorResponse('Authentication required', 'UNAUTHORIZED'));
      }

      const { credentialId } = req.params;

      await webauthnService.deleteCredential(user.id, credentialId);

      return res.status(200).json(successResponse({
        message: 'Credential deleted successfully',
      }));
    } catch (error) {
      logError(securityLogger, 'Delete WebAuthn credential error', error as Error, { service: 'webauthn' });
      return res.status(500).json(
        errorResponse(
          error instanceof Error ? error.message : 'Failed to delete credential',
          'DELETE_CREDENTIAL_ERROR'
        )
      );
    }
  }
);

/**
 * GET /api/webauthn/status
 * Check if WebAuthn is enabled for the user
 */
router.get('/status', authenticateJWT, async (req: Request, res: Response) => {
  try {
    const user = getUserFromRequest(req);
    if (!user) {
      return res.status(401).json(errorResponse('Authentication required', 'UNAUTHORIZED'));
    }

    const hasWebAuthn = await webauthnService.hasWebAuthn(user.id);
    const credentials = await webauthnService.getUserCredentials(user.id);

    return res.status(200).json(successResponse({
      webauthnEnabled: hasWebAuthn,
      credentialCount: credentials.length,
    }));
  } catch (error) {
    logError(securityLogger, 'WebAuthn status error', error as Error, { service: 'webauthn' });
    return res.status(500).json(
      errorResponse('Failed to get WebAuthn status', 'STATUS_ERROR')
    );
  }
});

export default router;
