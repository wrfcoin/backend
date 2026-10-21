import express, { type Request, type Response } from 'express';

// honest-gap.js is CommonJS and is copied as a .cjs shim in the production build.
const { sendNotWired } = require('../utils/honest-gap.js');

const router = express.Router();
const TIMEOUT_MS = 5_000;
const ADR = 'wrfcoin/defi-protocols ADR 0001';

export function defiNodeBaseUrl(): string | null {
  const configured = process.env.DEFI_NODE_URL?.trim();
  return configured ? configured.replace(/\/+$/, '') : null;
}

function notConfigured(res: Response) {
  return sendNotWired(res, {
    capability: 'defi',
    message: 'defi-node is not configured for this deployment',
    details: 'Set DEFI_NODE_URL only when the opt-in simulator is running.',
    see: ADR,
  });
}

function upstreamFailure(res: Response, code: string, message: string, details?: unknown) {
  return res.status(502).json({
    success: false,
    simulated: true,
    unavailable: true,
    error: { code, message, ...(details === undefined ? {} : { details }) },
    timestamp: new Date().toISOString(),
  });
}

interface ForwardInit {
  method?: string;
  body?: string;
}

async function forward(res: Response, path: string, init: ForwardInit = {}) {
  const baseUrl = defiNodeBaseUrl();
  if (!baseUrl) return notConfigured(res);

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        accept: 'application/json',
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      signal: globalThis.AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      return upstreamFailure(res, 'UPSTREAM_INVALID_JSON', 'defi-node returned invalid JSON');
    }

    if (
      response.ok &&
      (!payload || typeof payload !== 'object' || (payload as { simulated?: unknown }).simulated !== true)
    ) {
      return upstreamFailure(
        res,
        'UPSTREAM_CONTRACT_VIOLATION',
        'defi-node 2xx response omitted simulated:true',
      );
    }
    return res.status(response.status).json(payload);
  } catch (error) {
    return upstreamFailure(
      res,
      'DEFI_NODE_UNAVAILABLE',
      'defi-node is unavailable',
      error instanceof Error ? error.message : String(error),
    );
  }
}

router.get('/pools', (_req, res) => forward(res, '/api/defi/pools'));
router.post('/pools/:id/quote', (req, res) =>
  forward(res, `/api/defi/pools/${encodeURIComponent(req.params.id)}/quote`, {
    method: 'POST',
    body: JSON.stringify(req.body),
  }),
);

function portfolioUnavailable(_req: Request, res: Response) {
  if (!defiNodeBaseUrl()) return notConfigured(res);
  return sendNotWired(res, {
    capability: 'defi.portfolio',
    message: 'DeFi portfolio is unavailable because the simulator has no ledger',
    details: 'No balance-moving or custody route exists until the settlement ADR is accepted.',
    see: 'wrfcoin/defi-protocols ADR 0001 Story D',
  });
}

router.get('/portfolio', portfolioUnavailable);
router.get('/portfolio/:address', portfolioUnavailable);

export default router;
