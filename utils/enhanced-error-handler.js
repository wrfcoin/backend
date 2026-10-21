/**
 * Enhanced Error Handling Middleware
 */

const handleAsyncErrors = fn => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

const errorHandler = (err, req, res, next) => {
  console.error('Error:', err.message);

  // Rate limit errors
  if (
    err.code === 'ERR_ERL_PERMISSIVE_TRUST_PROXY' ||
    err.code === 'ERR_ERL_UNEXPECTED_X_FORWARDED_FOR'
  ) {
    return res.status(429).json({
      error: 'Rate limit configuration issue',
      message: 'Please try again later',
    });
  }

  // WebSocket errors
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
    return res.status(503).json({
      error: 'Service temporarily unavailable',
      message: 'Connection issue detected',
    });
  }

  // Default error response
  res.status(500).json({
    error: 'Internal server error',
    message: 'An unexpected error occurred',
  });
};

module.exports = { handleAsyncErrors, errorHandler };
