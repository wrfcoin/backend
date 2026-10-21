import express, { Request, Response } from 'express';
import crypto from 'crypto';
import {
  calibrationAttestationVerifier,
  CalibrationAttestationVerifierService,
  canonicalizeCalibrationAttestationCid,
  type CalibrationVerificationStatus,
} from '../services/calibration-attestation-verifier.js';

function readRequiredString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

interface EnvelopeErrorBody {
  code: string;
  message: string;
}

function resolveRequestId(req: Request): string {
  const headerValue = req.headers['x-request-id'];
  if (typeof headerValue === 'string' && headerValue.trim().length > 0) {
    return headerValue.trim();
  }
  return `req_${crypto.randomUUID()}`;
}

function envelopeSuccess(
  req: Request,
  res: Response,
  statusCode: number,
  data: unknown,
): void {
  const requestId = resolveRequestId(req);
  const timestamp = new Date().toISOString();
  res
    .status(statusCode)
    .setHeader('X-Request-Id', requestId)
    .json({
      ok: true,
      data,
      error: null,
      meta: {
        request_id: requestId,
        timestamp,
        api_version: 'v1',
      },
      // Backward compatibility for existing backend consumers.
      success: true,
      timestamp,
    });
}

function envelopeError(
  req: Request,
  res: Response,
  statusCode: number,
  error: EnvelopeErrorBody,
): void {
  const requestId = resolveRequestId(req);
  const timestamp = new Date().toISOString();
  res
    .status(statusCode)
    .setHeader('X-Request-Id', requestId)
    .json({
      ok: false,
      data: null,
      error,
      meta: {
        request_id: requestId,
        timestamp,
        api_version: 'v1',
      },
      // Backward compatibility for existing backend consumers.
      success: false,
      timestamp,
    });
}

export function createCalibrationAttestationVerifierRouters(
  service: CalibrationAttestationVerifierService = calibrationAttestationVerifier,
): {
  apiRouter: express.Router;
  indexerRouter: express.Router;
} {
  const apiRouter = express.Router();
  const indexerRouter = express.Router();

  apiRouter.post('/verify', async (req: Request, res: Response): Promise<void> => {
    const commitId = readRequiredString(req.body?.commitId);
    const stationId = readRequiredString(req.body?.stationId);
    const calibrationAttestationCid = readRequiredString(req.body?.calibrationAttestationCid);
    const canonicalCalibrationAttestationCid = readOptionalString(
      req.body?.canonicalCalibrationAttestationCid,
    );

    if (!commitId || !stationId || !calibrationAttestationCid) {
      envelopeError(req, res, 400, {
        code: 'INVALID_PARAMS',
        message: 'commitId, stationId, and calibrationAttestationCid are required',
      });
      return;
    }

    try {
      const summary = await service.verifyCalibrationAttestation({
        commitId,
        stationId,
        calibrationAttestationCid,
        canonicalCalibrationAttestationCid,
      });
      envelopeSuccess(req, res, summary.status === 'error' ? 502 : 200, summary);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      envelopeError(req, res, 500, {
        code: 'VERIFICATION_ERROR',
        message: `Failed to verify calibration attestation artifact: ${detail}`,
      });
    }
  });

  apiRouter.get('/status/:verificationId', (req: Request, res: Response): void => {
    const verificationId = readRequiredString(req.params.verificationId);
    if (!verificationId) {
      envelopeError(req, res, 400, {
        code: 'INVALID_PARAMS',
        message: 'verificationId is required',
      });
      return;
    }

    const summary = service.getSummaryByVerificationId(verificationId);
    if (!summary) {
      envelopeError(req, res, 404, {
        code: 'VERIFICATION_NOT_FOUND',
        message: 'Verification summary not found',
      });
      return;
    }

    envelopeSuccess(req, res, 200, summary);
  });

  apiRouter.get('/status/by-commit/:commitId', (req: Request, res: Response): void => {
    const commitId = readRequiredString(req.params.commitId);
    if (!commitId) {
      envelopeError(req, res, 400, {
        code: 'INVALID_PARAMS',
        message: 'commitId is required',
      });
      return;
    }

    const summary = service.getSummaryByCommitId(commitId);
    if (!summary) {
      envelopeError(req, res, 404, {
        code: 'VERIFICATION_NOT_FOUND',
        message: 'Verification summary not found for commit',
      });
      return;
    }

    envelopeSuccess(req, res, 200, summary);
  });

  indexerRouter.get('/verification-summaries', (req: Request, res: Response): void => {
    const commitId = readOptionalString(req.query.commitId);
    const stationId = readOptionalString(req.query.stationId);
    const rawCanonicalCid = readOptionalString(req.query.canonicalCalibrationAttestationCid);
    const status = readOptionalString(req.query.status) as CalibrationVerificationStatus | undefined;
    const limitRaw = readOptionalString(req.query.limit);
    const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;

    let canonicalCalibrationAttestationCid: string | undefined;
    if (rawCanonicalCid) {
      const canonicalized = canonicalizeCalibrationAttestationCid(rawCanonicalCid);
      if (!canonicalized) {
        envelopeError(req, res, 400, {
          code: 'INVALID_PARAMS',
          message: 'canonicalCalibrationAttestationCid is invalid',
        });
        return;
      }
      canonicalCalibrationAttestationCid = canonicalized;
    }

    if (status && !['verified', 'rejected', 'error'].includes(status)) {
      envelopeError(req, res, 400, {
        code: 'INVALID_PARAMS',
        message: 'status must be one of: verified, rejected, error',
      });
      return;
    }

    const summaries = service.querySummaries({
      commitId,
      stationId,
      canonicalCalibrationAttestationCid,
      status,
      limit: Number.isFinite(limit) ? limit : undefined,
    });

    envelopeSuccess(req, res, 200, {
      summaries,
      count: summaries.length,
    });
  });

  return { apiRouter, indexerRouter };
}

const routers = createCalibrationAttestationVerifierRouters();

export const calibrationAttestationVerifierApiRoutes = routers.apiRouter;
export const calibrationAttestationVerifierIndexerRoutes = routers.indexerRouter;
