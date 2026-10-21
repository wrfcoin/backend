/**
 * Privacy Routes
 *
 * This module defines routes for the privacy API endpoints.
 */

import express, { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticateJWT } from '../middleware/auth.js';
import { hasAdminRole } from '../utils/admin-role.js';
import * as privacyController from '../controllers/privacyController.js';
import { requireWiredStorage } from '../middleware/require-wired-storage.js';
import {
  fetchCore4Json,
  extractCore4Data,
  sendCore4Error,
  sendCore4Unavailable,
} from '../../shared/core4-route-client.js';
import { blockchainLogger } from '../utils/logger.js';

import { core4OperatorHeaders, configuredAdminPayload, requireEmptyAdminBody, auditedAdminWrite, sendAdminPolicyError } from '../utils/core4-admin-policy.js';

const router: Router = express.Router();

// All privacy operations require authentication (#231)
router.use(authenticateJWT);

// Owner policy: this creates an ephemeral secret in core4's registry.
// Only verified admins may trigger it, with fixed configured public keys.
router.post('/stealth-address', (req: Request, res: Response, next: NextFunction) => {
  // authenticateJWT already verified issuer, algorithm, session and revocation.
  // Check its roles without re-verifying an RS256 bearer as HS256.
  if (!hasAdminRole(req.user)) {
    return res.status(403).json({ success: false, error: 'Admin privilege required for this operation.' });
  }
  next();
}, async (req: Request, res: Response) => {
  try {
    requireEmptyAdminBody(req.body);
    const payload = configuredAdminPayload('WRFCOIN_ADMIN_STEALTH_CONFIG');
    const headers = core4OperatorHeaders(req.headers as Record<string, string>);
    let core4;
    try {
      core4 = await auditedAdminWrite(req, 'privacy.stealth_address', { source: 'config' }, () => fetchCore4Json('/privacy/stealth-address/create', {
        method: 'POST',
        headers,
        body: payload,
      }));
    } catch (error) {
      return sendCore4Unavailable(res, error, 'Privacy node unavailable');
    }
    if (!core4.ok) {
      return sendCore4Error(res, core4, 'core4 stealth-address creation failed');
    }

    const data = (extractCore4Data(core4.payload) || {}) as Record<string, unknown>;
    // Mobile reads `stealthAddress` from the (unwrapped) response body.
    return res.json({
      success: true,
      stealthAddress: data.one_time_address ?? null,
      transactionKey: data.transaction_key ?? null,
      data,
    });
  } catch (error) {
    if (sendAdminPolicyError(res, error)) return;
    blockchainLogger.error('Error creating stealth address', {
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({ success: false, error: 'Error creating stealth address' });
  }
});

// backend#1145: the controller-backed routes below branch on req.storage and
// otherwise answer default/mock settings and unverified "proofs" as success.
// The live entrypoint never injects req.storage and server/storage.ts does not
// implement the privacy methods, so guard them with an honest 501. The
// /stealth-address route above is core4-backed and stays live.
router.use(requireWiredStorage('privacy', { see: 'wrfcoin/backend#1145' }));

// Get privacy status (using getPrivacySettings)
router.get('/status', privacyController.getPrivacySettings);

// Update privacy settings
router.post('/settings', privacyController.updatePrivacySettings);

// Get details for a specific privacy feature (using getPrivacySettings)
router.get('/features/:feature', privacyController.getPrivacySettings);

// Get privacy statistics (using getPrivacySettings)
router.get('/stats', privacyController.getPrivacySettings);

// Apply privacy protections to a transaction (using createZKProof)
router.post('/apply', privacyController.createZKProof);

// Verify a privacy-enhanced transaction (using verifyZKProof)
router.post('/verify', privacyController.verifyZKProof);

export default router;
