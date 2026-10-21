/**
 * Canonical API error response format.
 *
 * All route handlers should use `createApiError()` to produce error responses
 * so that every client (frontend, mobile, CLI, SDK) can parse errors with a
 * single code path.
 *
 * Shape:
 * ```json
 * {
 *   "success": false,
 *   "error": { "code": "ERROR_CODE", "message": "Human-readable message", "details": ... },
 *   "timestamp": "2026-03-16T..."
 * }
 * ```
 */

export interface ApiErrorBody {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  timestamp: string;
}

export interface PaginationQuery {
  limit: number;
  offset: number;
  page: number;
}

export interface ListPaginationOptions {
  defaultLimit?: number;
  maxLimit?: number;
}

interface ErrorLikeWithMetadata {
  code?: unknown;
  statusCode?: unknown;
}

function isErrorLike(details: unknown): details is ErrorLikeWithMetadata {
  return details instanceof Error;
}

export function sanitizeApiErrorDetails(details: unknown): unknown {
  if (!isErrorLike(details)) {
    return details;
  }

  const safeDetails: Record<string, unknown> = {};

  if (typeof details.code === 'string' && details.code.trim().length > 0) {
    safeDetails.code = details.code;
  }

  if (typeof details.statusCode === 'number') {
    safeDetails.statusCode = details.statusCode;
  }

  return Object.keys(safeDetails).length > 0 ? safeDetails : undefined;
}

/**
 * Build a canonical error response object.
 *
 * @param code    Machine-readable error code (e.g. `"WALLET_LOGIN_ERROR"`)
 * @param message Human-readable description
 * @param details Optional extra context (stack trace, validation errors, etc.)
 */
export function createApiError(
  code: string,
  message: string,
  details?: unknown,
): ApiErrorBody {
  return {
    success: false,
    error: { code, message, details: sanitizeApiErrorDetails(details) },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Build a canonical paginated list response.
 *
 * Keep this aligned with the CommonJS helper so Jest tests can import the
 * `.js` path and still receive the same API surface through path mapping.
 */
export function paginatedResponse<T>(
  data: T[],
  total: number,
  page: number,
  limit: number,
) {
  const totalPages = limit > 0 ? Math.ceil(total / limit) : 1;

  return {
    success: true,
    data,
    pagination: {
      total,
      page,
      limit,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    },
  };
}

/**
 * Parse bounded limit/offset query params with stable defaults.
 *
 * This centralizes read-path pagination parsing so list endpoints in CJS/ESM
 * route files stay aligned and always return a bounded first page.
 */
export function parseListPagination(
  query: Record<string, unknown>,
  options: ListPaginationOptions = {},
): PaginationQuery {
  const { defaultLimit = 50, maxLimit = 200 } = options;
  const defaultLimitValue = Number.isFinite(defaultLimit) ? defaultLimit : 50;
  const maxLimitValue = Number.isFinite(maxLimit) ? maxLimit : 200;

  const limitRaw = query.limit;
  const offsetRaw = query.offset;

  const limitCandidate =
    typeof limitRaw === 'string'
      ? Number.parseInt(limitRaw, 10)
      : typeof limitRaw === 'number'
        ? limitRaw
        : defaultLimitValue;
  const offsetCandidate =
    typeof offsetRaw === 'string'
      ? Number.parseInt(offsetRaw, 10)
      : typeof offsetRaw === 'number'
        ? offsetRaw
        : 0;

  const limit = Math.min(
    Math.max(1, Number.isFinite(limitCandidate) ? Math.floor(limitCandidate) : defaultLimitValue),
    maxLimitValue,
  );

  // `?page=` support (#909) — kept byte-for-byte equivalent to the CJS copy in
  // api-error.js. paginatedResponse advertises `page`/`hasNext`/`hasPrev`, so a
  // client following `page: 2` issues `?page=2`; before this only `?offset=`
  // was read and that request silently returned page 1 again.
  //
  // `offset` wins when both are supplied.
  const pageRawValue = query.page;
  const pageCandidate =
    typeof pageRawValue === 'string'
      ? Number.parseInt(pageRawValue, 10)
      : typeof pageRawValue === 'number'
        ? pageRawValue
        : undefined;
  const offsetProvided = offsetRaw !== undefined && offsetRaw !== null && offsetRaw !== '';
  const pageUsable =
    pageCandidate !== undefined && Number.isFinite(pageCandidate) && pageCandidate >= 1;

  const offset =
    !offsetProvided && pageUsable
      ? (Math.floor(pageCandidate as number) - 1) * limit
      : Math.max(0, Number.isFinite(offsetCandidate) ? Math.floor(offsetCandidate) : 0);
  const page = Math.floor(offset / limit) + 1;

  return { limit, offset, page };
}
