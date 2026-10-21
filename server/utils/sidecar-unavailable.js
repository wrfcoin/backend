/** Unwired IoT/AI network surfaces use a stable service-unavailable contract. */
function sendSidecarUnavailable(res, { capability, message }) {
  return res.status(503).json({
    success: false,
    unavailable: true,
    reason: message,
    error: { code: 'SIDECAR_UNAVAILABLE', message, capability },
  });
}

module.exports = { sendSidecarUnavailable };
