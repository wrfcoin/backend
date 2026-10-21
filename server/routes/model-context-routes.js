/**
 * Retired Model Context HTTP surface (backend#1156).
 *
 * The former router exposed unauthenticated, in-memory CRUD and invented
 * validation/export results. It is not mounted by either release server. This
 * fail-closed router remains only for direct legacy imports.
 */
const express = require('express');

const router = express.Router();

router.use((_req, res) => {
  res.status(410).json({
    success: false,
    available: false,
    proofClass: 'UNAVAILABLE',
    code: 'MODEL_CONTEXT_API_RETIRED',
    error:
      'Model Context API is unavailable: no durable context store, validation provenance, or export artifact provider is configured',
  });
});

module.exports = router;
