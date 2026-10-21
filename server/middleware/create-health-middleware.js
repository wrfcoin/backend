const express = require('express');
const { hasOperatorOrReaderToken } = require('./operator-token-auth');

/**
 * backend#1224: probe bodies used to carry dependency detail (core4 URL, DB
 * error text), version and uptime for any anonymous caller. Anonymous callers
 * now get the status word and the same HTTP code — all that uptime checks and
 * container healthchecks read — while an operator/reader bearer token still
 * gets the full body.
 */
function sendProbe(req, res, statusCode, body) {
  if (hasOperatorOrReaderToken(req)) {
    return res.status(statusCode).json(body);
  }
  return res.status(statusCode).json({ status: body.status, timestamp: body.timestamp });
}

function normalizeDependencyResult(result, critical) {
  if (typeof result === 'boolean') {
    return {
      status: result ? 'up' : 'down',
      critical,
    };
  }

  if (result && typeof result === 'object') {
    return {
      critical,
      ...result,
      status: result.status || 'up',
    };
  }

  return {
    status: 'up',
    critical,
  };
}

function createHealthMiddleware(serviceName, dependencyChecks = {}, options = {}) {
  const state = options.state || { draining: false };
  const version = options.version || process.env.npm_package_version || 'unknown';
  const router = express.Router();

  async function evaluateDependencies() {
    const entries = await Promise.all(
      Object.entries(dependencyChecks).map(async ([name, config]) => {
        const descriptor =
          typeof config === 'function' ? { check: config, critical: false } : config;

        try {
          const result = await descriptor.check();
          return [
            name,
            normalizeDependencyResult(result, descriptor.critical === true),
          ];
        } catch (error) {
          return [
            name,
            {
              status: 'down',
              critical: descriptor.critical === true,
              error: error instanceof Error ? error.message : String(error),
            },
          ];
        }
      })
    );

    return Object.fromEntries(entries);
  }

  function summarizeStatus(dependencies) {
    if (state.draining) {
      return 'draining';
    }

    const values = Object.values(dependencies);
    if (values.some(dep => dep.critical && dep.status !== 'up')) {
      return 'unhealthy';
    }
    if (values.some(dep => dep.status !== 'up')) {
      return 'degraded';
    }
    return 'healthy';
  }

  async function healthHandler(req, res) {
    const dependencies = await evaluateDependencies();
    const status = summarizeStatus(dependencies);

    sendProbe(req, res, status === 'unhealthy' ? 503 : 200, {
      status,
      service: serviceName,
      version,
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      dependencies,
      draining: state.draining,
    });
  }

  async function readinessHandler(req, res) {
    const dependencies = await evaluateDependencies();
    const criticalUnavailable = Object.values(dependencies).some(
      dep => dep.critical && dep.status !== 'up'
    );
    const ready = !state.draining && !criticalUnavailable;

    sendProbe(req, res, ready ? 200 : 503, {
      status: ready ? 'ready' : 'not_ready',
      service: serviceName,
      timestamp: new Date().toISOString(),
      draining: state.draining,
      dependencies,
    });
  }

  function livenessHandler(req, res) {
    sendProbe(req, res, 200, {
      status: 'alive',
      service: serviceName,
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
    });
  }

  router.get('/health', healthHandler);
  router.get('/ready', readinessHandler);
  router.get('/live', livenessHandler);

  return {
    router,
    state,
    markDraining() {
      state.draining = true;
    },
    clearDraining() {
      state.draining = false;
    },
    evaluateDependencies,
    healthHandler,
    readinessHandler,
    livenessHandler,
  };
}

module.exports = {
  createHealthMiddleware,
  sendProbe,
};
