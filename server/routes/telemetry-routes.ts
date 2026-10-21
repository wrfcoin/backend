/**
 * Frontend telemetry endpoint (#685).
 *
 * Lightweight, unauthenticated, rate-limited endpoint that the frontend
 * pings to record page views and frontend-driven funnel events
 * (e.g. `code_shared`, `code_entered`) that have no natural backend
 * hook. The handler does no DB work — it only increments Prometheus
 * counters defined in `utils/metrics.ts`.
 *
 *   POST /api/telemetry/page-view     { page, referrerType? }
 *   POST /api/telemetry/funnel        { funnel, step }
 *
 * Anything that smells like cardinality blow-up (free-form `page` or
 * unknown `step`) is normalized or rejected before the counter is
 * touched, so the metrics registry stays bounded.
 */

import { Router, Request, Response } from 'express';
import {
  recordPageView,
  recordReferralFunnelStep,
  recordContributionFunnelStep,
  CONTRIBUTION_FUNNEL_STEPS,
  REFERRAL_FUNNEL_STEPS,
  type ContributionFunnelStep,
  type ReferralFunnelStep,
} from '../utils/metrics.js';
import { createApiError } from '../utils/api-error.js';

const router = Router();

const MAX_PAGE_LABEL_LEN = 80;
const ALLOWED_REFERRER_TYPES = new Set(['direct', 'referral', 'organic', 'social']);

const REFERRAL_STEPS = new Set<string>(REFERRAL_FUNNEL_STEPS);
const CONTRIBUTION_STEPS = new Set<string>(CONTRIBUTION_FUNNEL_STEPS);

function sanitizePage(raw: string): string | null {
  // Allow alphanumerics, dash, underscore, slash. Reject anything else
  // so a hostile client cannot blow up label cardinality with random URLs.
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_PAGE_LABEL_LEN) {
    return null;
  }
  return /^[A-Za-z0-9_\-/]+$/.test(raw) ? raw : null;
}

router.post('/page-view', (req: Request, res: Response) => {
  const { page, referrerType } = (req.body ?? {}) as {
    page?: string;
    referrerType?: string;
  };

  const cleanPage = page ? sanitizePage(page) : null;
  if (!cleanPage) {
    return res
      .status(400)
      .json(createApiError('INVALID_PAGE_LABEL', 'invalid page label'));
  }

  const cleanReferrer =
    referrerType && ALLOWED_REFERRER_TYPES.has(referrerType) ? referrerType : 'direct';

  recordPageView(cleanPage, cleanReferrer);
  return res.status(204).end();
});

router.post('/funnel', (req: Request, res: Response) => {
  const { funnel, step } = (req.body ?? {}) as {
    funnel?: string;
    step?: string;
  };

  if (typeof funnel !== 'string' || typeof step !== 'string') {
    return res
      .status(400)
      .json(createApiError('MISSING_FUNNEL_OR_STEP', 'funnel and step required'));
  }

  if (funnel === 'referral') {
    if (!REFERRAL_STEPS.has(step)) {
      return res
        .status(400)
        .json(createApiError('UNKNOWN_REFERRAL_STEP', 'unknown referral step'));
    }
    recordReferralFunnelStep(step as ReferralFunnelStep);
    return res.status(204).end();
  }

  if (funnel === 'contribution') {
    if (!CONTRIBUTION_STEPS.has(step)) {
      return res
        .status(400)
        .json(
          createApiError('UNKNOWN_CONTRIBUTION_STEP', 'unknown contribution step'),
        );
    }
    recordContributionFunnelStep(step as ContributionFunnelStep);
    return res.status(204).end();
  }

  return res
    .status(400)
    .json(createApiError('UNKNOWN_FUNNEL', 'unknown funnel'));
});

export default router;
