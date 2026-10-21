/**
 * Retired OpenForis public surface (backend#1154).
 *
 * The former implementation returned in-memory projects, fixed climate data,
 * and invented chain receipts. No configured OpenForis provider or canonical
 * receipt verifier exists, so every direct use fails honestly and this router
 * is not mounted by the release server.
 */
import { Router, type Request, type Response } from 'express';

const router = Router();

function retired(_req: Request, res: Response) {
  return res.status(410).json({
    success: false,
    available: false,
    proofClass: 'UNAVAILABLE',
    code: 'OPENFORIS_INTEGRATION_RETIRED',
    error:
      'OpenForis is unavailable: no configured provider and canonical chain-receipt verifier exist',
  });
}

router.use(retired);

export default router;
