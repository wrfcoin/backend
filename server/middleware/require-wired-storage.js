/**
 * Not-wired guard for controller families that only have a development mock
 * branch (backend#1145).
 *
 * `achievementController`, `privacyController` and `n8nController` branch on
 * `req.storage` / `req.n8nService` and fall back to hard-coded "Mock …" data
 * when the dependency is absent. Only the non-live `server/api.js` ever
 * injected `req.storage` (and only for other controllers); the live entrypoint
 * `enhanced_unified_api_optimized.ts` never does, and `server/storage.ts`'s
 * `IStorage` does not implement the achievement / privacy / n8n methods those
 * branches call. So on the testnet every request to these families reached
 * the mock branch and answered fabricated 200s.
 *
 * This guard answers `501 NOT_IMPLEMENTED` with the same honest-gap envelope
 * backend#1118 established (`{ success: false, unavailable: true, reason,
 * error: { code, message, capability } }`) whenever the required dependency is
 * not on the request, so the mock branches are unreachable in production. When
 * a real implementation is injected upstream, the guard passes through
 * unchanged.
 */

const NOT_WIRED_CODE = 'NOT_IMPLEMENTED';

/**
 * @param {object} opts
 * @param {string} opts.capability  short slug, e.g. 'privacy.settings'
 * @param {string} opts.message     one-line human explanation
 * @param {string} [opts.details]   what would have to exist for this to work
 * @param {string} [opts.see]       pointer to the real route / issue, if any
 */
function notWiredEnvelope({ capability, message, details, see }) {
  return {
    success: false,
    unavailable: true,
    reason: message,
    error: {
      code: NOT_WIRED_CODE,
      message,
      capability,
      ...(details ? { details } : {}),
      ...(see ? { see } : {}),
    },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Express middleware factory.
 *
 * @param {string} capability   family slug used in the envelope
 * @param {object} [opts]
 * @param {string} [opts.needs='storage']  request property that a real wiring
 *                                          would inject (`storage`, `n8nService`)
 * @param {string} [opts.see]               issue / route pointer
 */
function requireWiredStorage(capability, { needs = 'storage', see } = {}) {
  return function requireWiredStorageGuard(req, res, next) {
    if (req && req[needs]) {
      return next();
    }
    return res.status(501).json(
      notWiredEnvelope({
        capability,
        message: `${capability} is not wired on this API: no ${needs} implementation is injected for this route family`,
        details:
          `The controller behind this route only has a development mock branch for a missing req.${needs}; ` +
          'the live entrypoint never injects one, so the mock would have answered. Inject a real implementation upstream to enable it.',
        ...(see ? { see } : {}),
      }),
    );
  };
}

module.exports = { requireWiredStorage, notWiredEnvelope, NOT_WIRED_CODE };
