/**
 * Canonical API error response format.
 *
 * All route handlers should use createApiError() to produce error responses
 * so that every client (frontend, mobile, CLI, SDK) can parse errors with a
 * single code path.
 */

/**
 * Build a canonical error response object.
 *
 * @param {string} code    Machine-readable error code (e.g. "WALLET_LOGIN_ERROR")
 * @param {string} message Human-readable description
 * @param {*} [details]    Optional extra context
 * @returns {{ success: false, error: { code: string, message: string, details?: * }, timestamp: string }}
 */
function sanitizeApiErrorDetails(details) {
  if (!(details instanceof Error)) {
    return details;
  }

  const safeDetails = {};

  if (typeof details.code === 'string' && details.code.trim().length > 0) {
    safeDetails.code = details.code;
  }

  if (typeof details.statusCode === 'number') {
    safeDetails.statusCode = details.statusCode;
  }

  return Object.keys(safeDetails).length > 0 ? safeDetails : undefined;
}

function createApiError(code, message, details) {
  return {
    success: false,
    error: { code, message, details: sanitizeApiErrorDetails(details) },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Build a canonical paginated list response.
 *
 * All paginated list endpoints must use this helper so the frontend can
 * parse pagination metadata with a single code path (#458).
 *
 * @param {Array}  data        The page of items
 * @param {number} total       Total number of matching items (before pagination)
 * @param {number} page        Current 1-based page number
 * @param {number} limit       Items per page
 * @returns {{ success: true, data: Array, pagination: { total, page, limit, totalPages, hasNext, hasPrev } }}
 */
function paginatedResponse(data, total, page, limit) {
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
 * Keeps list endpoints in CJS/ESM aligned and guarantees bounded first-page behavior.
 * @param {Record<string, unknown>} query
 * @param {{ defaultLimit?: number, maxLimit?: number }} [options]
 * @returns {{ limit: number, offset: number, page: number }}
 */
function parseListPagination(query, options = {}) {
  const defaultLimit = Number.isFinite(options.defaultLimit) ? options.defaultLimit : 50;
  const maxLimit = Number.isFinite(options.maxLimit) ? options.maxLimit : 200;
  const rawLimit = query?.limit;
  const rawOffset = query?.offset;
  const limitRaw = typeof rawLimit === 'string'
    ? Number.parseInt(rawLimit, 10)
    : typeof rawLimit === 'number'
      ? rawLimit
      : defaultLimit;
  const offsetRaw = typeof rawOffset === 'string'
    ? Number.parseInt(rawOffset, 10)
    : typeof rawOffset === 'number'
      ? rawOffset
      : 0;

  const limit = Math.min(
    Math.max(1, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : defaultLimit),
    maxLimit,
  );

  // `?page=` support (#909). paginatedResponse advertises `page`, `hasNext` and
  // `hasPrev`, so a client that follows `page: 2` reasonably issues `?page=2`.
  // Before this, only `?offset=` was read, so that request silently returned
  // page 1 again — the metadata described a navigation the API did not accept.
  //
  // `offset` wins when both are supplied: it is the pre-existing contract and
  // the more precise of the two.
  const rawPage = query?.page;
  const pageRaw = typeof rawPage === 'string'
    ? Number.parseInt(rawPage, 10)
    : typeof rawPage === 'number'
      ? rawPage
      : undefined;
  const offsetProvided = rawOffset !== undefined && rawOffset !== null && rawOffset !== '';
  const pageUsable = pageRaw !== undefined && Number.isFinite(pageRaw) && pageRaw >= 1;

  const offset = !offsetProvided && pageUsable
    ? (Math.floor(pageRaw) - 1) * limit
    : Math.max(0, Number.isFinite(offsetRaw) ? Math.floor(offsetRaw) : 0);
  const page = Math.floor(offset / limit) + 1;

  return { limit, offset, page };
}

module.exports = {
  createApiError,
  sanitizeApiErrorDetails,
  paginatedResponse,
  parseListPagination,
};
