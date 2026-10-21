import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import type {
  CrossPostCreateInput,
  CrossPostStore,
} from '../services/wrfsentinel-crosspost-store.js';

const SEVERITIES = new Set([
  'info',
  'low',
  'medium',
  'high',
  'critical',
  'emergency',
]);

// The four cross-post write paths this router owns. Auth is bound to exactly
// these, never to the router as a whole.
const CROSS_POST_PATHS = [
  '/api/social/feed',
  '/api/environment/reports',
  '/v1/social-feed',
  '/v1/reports',
];

export function createWrfsentinelCrossPostRouter(options: {
  authenticate: RequestHandler;
  store: CrossPostStore;
}): Router {
  const router = Router();

  // Cross-post writes require authentication + crosspost:write (#961). Scoped
  // to this router's own paths: the router is mounted at bare '/' in
  // enhanced_unified_api_optimized.ts, so an unscoped
  // router.use(authenticate, ...) runs for EVERY request into the app and 401s
  // every route registered after the mount — including the public login
  // handshake GET /api/auth/nonce/:address and POST /api/auth/wallet-login,
  // which are served by the inline catch-all dispatcher. Same class of bug,
  // and same fix, as the '/weather/alerts' scoping in
  // weather-alerts-routes.ts (#880).
  router.use(CROSS_POST_PATHS, options.authenticate, requireCrossPostWrite);

  const socialHandler = createHandler('social', options.store);
  const reportHandler = createHandler('report', options.store);

  router.post('/api/social/feed', socialHandler);
  router.post('/api/environment/reports', reportHandler);
  router.post('/v1/social-feed', socialHandler);
  router.post('/v1/reports', reportHandler);

  return router;
}

function requireCrossPostWrite(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const permissions = getPermissions(req);
  if (
    permissions.some(permission =>
      ['*', 'admin', 'write', 'crosspost:write'].includes(permission)
    )
  ) {
    next();
    return;
  }

  res.status(403).json({
    success: false,
    error: {
      code: 'CROSSPOST_WRITE_FORBIDDEN',
      message: 'crosspost:write permission is required',
    },
  });
}

function createHandler(
  kind: 'social' | 'report',
  store: CrossPostStore
): RequestHandler {
  return async (req, res) => {
    try {
      const input = normalizeInput(kind, req);
      const record = await store.create(input);
      res.status(201).json(record);
    } catch (error) {
      const validationError =
        error instanceof CrossPostValidationError ? error : null;
      res.status(validationError ? 400 : 503).json({
        success: false,
        error: {
          code: validationError
            ? 'INVALID_CROSSPOST'
            : 'CROSSPOST_STORE_UNAVAILABLE',
          message: validationError
            ? validationError.message
            : 'Cross-post storage is temporarily unavailable',
        },
      });
    }
  };
}

function normalizeInput(
  kind: 'social' | 'report',
  req: Request
): CrossPostCreateInput {
  const body = (req.body || {}) as Record<string, unknown>;
  const principal = getPrincipal(req);
  const content = requiredString(body.content, 'content', 10_000);
  const location = normalizeLocation(body.location);
  const severity = optionalString(body.severity, 'severity', 32) || 'info';
  if (!SEVERITIES.has(severity)) {
    throw new CrossPostValidationError(
      `severity must be one of: ${[...SEVERITIES].join(', ')}`
    );
  }

  const input: CrossPostCreateInput = {
    kind,
    principal,
    author:
      optionalString(body.author, 'author', 200) || 'WrfSentinel System',
    content,
    location,
    severity,
    tags: stringArray(body.tags, 'tags', 20, 80),
    metrics: plainObject(body.metrics, 'metrics'),
    mediaUrls: mediaUrls(body.mediaUrls),
    idempotencyKey: normalizeIdempotencyKey(req.get('idempotency-key')),
  };

  if (kind === 'social') {
    input.expiresAt = optionalDate(body.expiresAt, 'expiresAt');
  } else {
    input.title = requiredString(body.title, 'title', 300);
    input.summary =
      optionalString(body.summary, 'summary', 1_000) || input.title;
    input.category =
      optionalString(body.category, 'category', 100) || 'incident';
    input.validFrom = optionalDate(body.validFrom, 'validFrom');
    input.validUntil = optionalDate(body.validUntil, 'validUntil');
    if (
      input.validFrom &&
      input.validUntil &&
      input.validUntil < input.validFrom
    ) {
      throw new CrossPostValidationError(
        'validUntil must be at or after validFrom'
      );
    }
  }

  return input;
}

function getPrincipal(req: Request): string {
  const authReq = req as Request & {
    user?: { userId?: string; id?: string };
    apiKey?: { userId?: string; id?: string };
  };
  const principal =
    authReq.user?.userId ||
    authReq.user?.id ||
    authReq.apiKey?.userId ||
    authReq.apiKey?.id;
  if (!principal) {
    throw new CrossPostValidationError(
      'Authenticated principal is unavailable'
    );
  }
  return principal;
}

function getPermissions(req: Request): string[] {
  const authReq = req as Request & {
    user?: { permissions?: string[] };
    apiKey?: { permissions?: string[] };
  };
  return authReq.user?.permissions || authReq.apiKey?.permissions || [];
}

function normalizeLocation(value: unknown): { lat: number; lng: number } {
  const location = plainObject(value, 'location');
  const lat = location.lat;
  const lng = location.lng;
  if (
    typeof lat !== 'number' ||
    !Number.isFinite(lat) ||
    lat < -90 ||
    lat > 90
  ) {
    throw new CrossPostValidationError(
      'location.lat must be between -90 and 90'
    );
  }
  if (
    typeof lng !== 'number' ||
    !Number.isFinite(lng) ||
    lng < -180 ||
    lng > 180
  ) {
    throw new CrossPostValidationError(
      'location.lng must be between -180 and 180'
    );
  }
  return { lat, lng };
}

function requiredString(
  value: unknown,
  field: string,
  maxLength: number
): string {
  const normalized = optionalString(value, field, maxLength);
  if (!normalized) {
    throw new CrossPostValidationError(`${field} is required`);
  }
  return normalized;
}

function optionalString(
  value: unknown,
  field: string,
  maxLength: number
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new CrossPostValidationError(`${field} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new CrossPostValidationError(
      `${field} must be at most ${maxLength} characters`
    );
  }
  return normalized || undefined;
}

function stringArray(
  value: unknown,
  field: string,
  maxItems: number,
  maxItemLength: number
): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new CrossPostValidationError(
      `${field} must be an array with at most ${maxItems} items`
    );
  }
  return value.map((item, index) =>
    requiredString(item, `${field}[${index}]`, maxItemLength)
  );
}

function mediaUrls(value: unknown): string[] {
  return stringArray(value, 'mediaUrls', 10, 2_000).map(value => {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'https:') {
        throw new Error('not https');
      }
      return parsed.toString();
    } catch {
      throw new CrossPostValidationError(
        'mediaUrls entries must be valid HTTPS URLs'
      );
    }
  });
}

function plainObject(
  value: unknown,
  field: string
): Record<string, unknown> {
  if (
    value === undefined ||
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    if (field === 'metrics' && (value === undefined || value === null)) {
      return {};
    }
    throw new CrossPostValidationError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalDate(value: unknown, field: string): string | undefined {
  const raw = optionalString(value, field, 100);
  if (!raw) return undefined;
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) {
    throw new CrossPostValidationError(`${field} must be an ISO-8601 date`);
  }
  return new Date(timestamp).toISOString();
}

function normalizeIdempotencyKey(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > 128) {
    throw new CrossPostValidationError(
      'Idempotency-Key must be between 1 and 128 characters'
    );
  }
  return normalized;
}

class CrossPostValidationError extends Error {}
