/**
 * Academic Partnership Routes — .edu verification + auto-provisioned pro keys
 * Issue #252
 *
 * POST /api/academic/apply   — submit an academic partnership application
 * GET  /api/academic/status  — check application status
 */

import { Router, Request, Response } from 'express';
import { academicService } from '../services/academic-service.js';

const router = Router();

router.post('/apply', async (req: Request, res: Response) => {
  try {
    const userId: string | undefined = (req as any).user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const { email, institution, researchDescription } = req.body as {
      email?: string;
      institution?: string;
      researchDescription?: string;
    };

    if (!email || !institution || !researchDescription) {
      return res.status(400).json({
        success: false,
        error: 'email, institution, and researchDescription are required',
      });
    }

    const result = await academicService.apply(userId, email, institution, researchDescription);
    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
        timestamp: new Date().toISOString(),
      });
    }

    return res.status(201).json({
      success: true,
      data: {
        applicationId: result.applicationId,
        status: result.status,
        message: 'Application received. You will be notified once reviewed.',
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: (err as Error).message,
      timestamp: new Date().toISOString(),
    });
  }
});

router.get('/status', async (req: Request, res: Response) => {
  try {
    const userId: string | undefined = (req as any).user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const status = await academicService.getStatus(userId);
    if (!status) {
      return res.status(404).json({
        success: false,
        error: 'No academic application found for this user',
        timestamp: new Date().toISOString(),
      });
    }

    return res.json({
      success: true,
      data: status,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: (err as Error).message,
      timestamp: new Date().toISOString(),
    });
  }
});

export default router;
