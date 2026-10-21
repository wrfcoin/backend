'use strict';

/**
 * Keep unknown API requests from falling through to the production SPA.
 * This must be mounted after every real API router and before static/index
 * fallback handling.
 */
function apiNotFound(req, res, next) {
  const requestPath = req.path || '';
  if (requestPath !== '/api' && !requestPath.startsWith('/api/')) {
    return next();
  }

  return res.status(404).json({
    success: false,
    available: false,
    proofClass: 'UNAVAILABLE',
    code: 'API_ROUTE_NOT_FOUND',
    message: 'The requested API route is not available.',
  });
}

module.exports = apiNotFound;
