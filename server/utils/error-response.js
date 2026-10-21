/**
 * Canonical API error response format for route-level handlers.
 *
 * The backend standardizes on:
 *   { success: false, error: { message: string, code?: string } }
 */

function createErrorResponse(message, code, extras = {}) {
  const normalizedMessage =
    typeof message === 'string' && message.trim().length > 0
      ? message
      : String(message ?? 'Internal server error');

  const error = { message: normalizedMessage };

  if (typeof code === 'string' && code.trim().length > 0) {
    error.code = code;
  }

  if (extras && typeof extras === 'object' && 'details' in extras) {
    error.details = extras.details;
  }

  const response = {
    success: false,
    error,
  };

  if (extras && typeof extras === 'object' && 'timestamp' in extras) {
    response.timestamp = extras.timestamp;
  }

  return response;
}

module.exports = { createErrorResponse };
