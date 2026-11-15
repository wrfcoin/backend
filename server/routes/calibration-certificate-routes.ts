/**
 * Station calibration certificates (core4#388/#435, backend#931). Mounted at /api/calibration-certificates.
 *
 *   GET  /station/:alias   public: the station's calibration status, its newest certificate (full
 *                          signed JSON, so anyone can re-verify it), up to 5 older ones and the
 *                          configured trust-root public keys. `status` is calibrated | expired |
 *                          revoked | not_trusted | invalid | none, re-checked on every read.
 *   POST /                 submit a signed certificate (body = the artifact JSON). The trust root's
 *                          ed25519 signature is the authorization: nothing unsigned is stored.
 *   POST /revocations      submit a revocation signed by an active trust root.
 *
 * Default OFF: every path is 404 unless CALIBRATION_CERTIFICATES_ENABLED=true. Trust roots come only
 * from CALIBRATION_TRUST_ROOTS_JSON (public keys); with none configured, submissions answer 503
 * CAL_TRUST_ROOT_UNCONFIGURED and reads report no trust roots. The public edge admits the GET only;
 * the two POSTs are reached from the operator's network with scripts/calibration-certificate.ts.
 *
 * Stations are named by their public alias (`st_` + 12 hex) only. A raw station id can carry a
 * personal name (owner ruling 2026-09-27), so a raw id is 404 here and is never stored or returned.
 * Needs migration 0038 (calibration_certificates); a read with the table missing is 503.
 */
import express, { type RequestHandler } from 'express';
import {
  calibrationCertificatesEnabled,
  calibrationTrustRoots,
  defaultCalibrationCertificateStore,
  stationCalibrationView,
  submitCalibrationCertificate,
  submitCalibrationRevocation,
  type CalibrationCertificateContext,
  type CalibrationCertificateStore,
} from '../services/calibration-certificates.js';
import type { CalibrationRevocationEntry, CalibrationTrustRoot } from '../services/calibration-attestation-verifier.js';
import { isStationAlias, resolveStationAlias } from '../utils/station-alias.js';

export const CALIBRATION_CERTIFICATE_MAX_BODY_BYTES = 16 * 1024;

export interface CalibrationCertificateDeps {
  store?: CalibrationCertificateStore;
  trustRoots?: () => CalibrationTrustRoot[];
  revokedCertificates?: () => CalibrationRevocationEntry[];
  stationExists?: CalibrationCertificateContext['stationExists'];
  enabled?: () => boolean;
  now?: () => Date;
  /** `null` disables rate limiting (tests); undefined resolves the shared Redis limiters lazily. */
  readRateLimit?: RequestHandler | null;
  writeRateLimit?: RequestHandler | null;
}

async function redisLimiter(keyPrefix: string, maxRequests: number): Promise<RequestHandler | null> {
  try {
    const mod = await import('../../shared/middleware/rate-limit-redis.js');
    return mod.createRateLimitMiddleware({
      windowMs: 60 * 1000,
      maxRequests,
      keyPrefix,
      keyGenerator: mod.apiIpBudgetKey,
      message: 'Too many calibration certificate requests, please try again later.',
    });
  } catch {
    return null;
  }
}

async function defaultStationExists(alias: string): Promise<'found' | 'not_found' | 'unavailable'> {
  try {
    const { pool } = await import('../../database/db.js');
    const resolved = await resolveStationAlias(
      async (sql: string, params: unknown[]) => (await pool.query(sql, params)).rows,
      alias,
    );
    // An ambiguous alias (48-bit collision) is not a station we can certify.
    return resolved.status === 'found' ? 'found' : 'not_found';
  } catch {
    return 'unavailable';
  }
}

const notFound = (res: express.Response) => res.status(404).json({ error: { code: 'NOT_FOUND' } });

export function createCalibrationCertificateRouter(deps: CalibrationCertificateDeps = {}): express.Router {
  const router = express.Router();
  const enabled = deps.enabled ?? calibrationCertificatesEnabled;
  let store: CalibrationCertificateStore | null = deps.store ?? null;
  const ctx = (): CalibrationCertificateContext => ({
    store: (store ||= defaultCalibrationCertificateStore()),
    trustRoots: deps.trustRoots ?? calibrationTrustRoots,
    revokedCertificates: deps.revokedCertificates,
    stationExists: deps.stationExists ?? defaultStationExists,
    now: deps.now,
  });

  const limiter = (configured: RequestHandler | null | undefined, prefix: string, max: number) => {
    let promise: Promise<RequestHandler | null> | null = null;
    const get = () => {
      if (configured !== undefined) return Promise.resolve(configured);
      if (!promise) promise = redisLimiter(prefix, max);
      return promise;
    };
    return (handle: RequestHandler): RequestHandler => async (req, res, next) => {
      const rl = await get();
      if (!rl) return handle(req, res, next);
      rl(req, res, (err?: unknown) => {
        if (err) return next(err as Error);
        void handle(req, res, next);
      });
    };
  };
  const readLimited = limiter(deps.readRateLimit, 'ratelimit:calibration-read', 30);
  const writeLimited = limiter(deps.writeRateLimit, 'ratelimit:calibration-write', 10);

  // Flag first, before any limiter or body handling: OFF means the route does not exist.
  router.use((_req, res, next) => (enabled() ? next() : notFound(res)));

  const tooLarge = (body: unknown) => {
    try {
      return Buffer.byteLength(JSON.stringify(body ?? null), 'utf8') > CALIBRATION_CERTIFICATE_MAX_BODY_BYTES;
    } catch {
      return true;
    }
  };

  router.get('/station/:alias', readLimited(async (req, res) => {
    const alias = String(req.params.alias ?? '');
    if (!isStationAlias(alias)) return notFound(res);
    try {
      const view = await stationCalibrationView(ctx(), alias);
      res.set('Cache-Control', 'public, max-age=60');
      return res.json({ success: true, ...view });
    } catch {
      return res.status(503).json({ error: { code: 'CALIBRATION_UNAVAILABLE', message: 'Calibration records are not available right now.' } });
    }
  }));

  router.post('/', express.json({ limit: CALIBRATION_CERTIFICATE_MAX_BODY_BYTES }), writeLimited(async (req, res) => {
    if (tooLarge(req.body)) return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE' } });
    try {
      const outcome = await submitCalibrationCertificate(ctx(), req.body);
      res.set('Cache-Control', 'no-store');
      if (outcome.kind === 'rejected') {
        return res.status(outcome.http).json({ success: false, error: { code: outcome.code, reasonCodes: outcome.reasonCodes ?? [] } });
      }
      const { kind: _kind, created, ...rest } = outcome;
      return res.status(created ? 201 : 200).json({ success: true, created, status: 'calibrated', ...rest });
    } catch {
      return res.status(503).json({ error: { code: 'CALIBRATION_UNAVAILABLE', message: 'Calibration records are not available right now.' } });
    }
  }));

  router.post('/revocations', express.json({ limit: CALIBRATION_CERTIFICATE_MAX_BODY_BYTES }), writeLimited(async (req, res) => {
    if (tooLarge(req.body)) return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE' } });
    try {
      const outcome = await submitCalibrationRevocation(ctx(), req.body);
      res.set('Cache-Control', 'no-store');
      if (outcome.kind === 'rejected') return res.status(outcome.http).json({ success: false, error: { code: outcome.code } });
      const { kind: _kind, created, ...rest } = outcome;
      return res.status(created ? 201 : 200).json({ success: true, created, ...rest });
    } catch {
      return res.status(503).json({ error: { code: 'CALIBRATION_UNAVAILABLE', message: 'Calibration records are not available right now.' } });
    }
  }));

  return router;
}

export default createCalibrationCertificateRouter();
