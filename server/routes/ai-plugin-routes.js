/**
 * Retired AI plugin HTTP surface (backend#1157).
 *
 * The former router advertised hardcoded providers as active and returned
 * canned analysis without invoking them. Neither release server mounts this
 * module. It remains only as an honest boundary for direct legacy imports.
 */
const express = require('express');

const router = express.Router();

router.use((_req, res) => {
  res.status(503).json({
    success: false,
    available: false,
    proofClass: 'UNAVAILABLE',
    code: 'AI_PROVIDER_UNAVAILABLE',
    error:
      'AI analysis is unavailable: no configured, authenticated, health-proven provider is wired to this route',
  });
});

module.exports = router;
