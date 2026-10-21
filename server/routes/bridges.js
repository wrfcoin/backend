const express = require('express');
const { crosschainLogger } = require('../utils/logger.js');
const { bridgeValidatorsActiveGauge } = require('../utils/metrics.js');
const { routeDurableStore } = require('../../shared/route-durable-store');

const BRIDGE_TRANSFER_CAPABILITY = 'bridge.transfer';

function getVerifiedValidators(validators) {
  return validators.filter(
    validator => validator && validator.address && validator.publicKey
  );
}

function recordBridgeValidatorState(activeValidators, validatorConfigSource, shouldWarn) {
  bridgeValidatorsActiveGauge.set(
    { bridge: BRIDGE_TRANSFER_CAPABILITY },
    activeValidators
  );

  if (shouldWarn && activeValidators === 0) {
    crosschainLogger.warn(
      'No active bridge validators configured at startup; bridge verification is unsafe until BRIDGE_VALIDATORS is populated',
      {
        service: 'bridges',
        bridge: BRIDGE_TRANSFER_CAPABILITY,
        validatorConfigSource,
        allowSimulatedMode: process.env.BRIDGE_ALLOW_SIMULATED_MODE === 'true',
      }
    );
  }
}

function parseBridgeValidators() {
  const raw = process.env.BRIDGE_VALIDATORS;
  if (!raw) {
    return { validators: [], source: 'missing' };
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return { validators: [], source: 'invalid' };
    }

    return { validators: parsed, source: 'configured' };
  } catch (_error) {
    console.error('Invalid BRIDGE_VALIDATORS JSON; using empty validator list', {
      error: _error instanceof Error ? _error.message : String(_error),
    });
    return { validators: [], source: 'invalid' };
  }
}

function buildBridgeCapability({
  bridgeSafety,
  verificationStats,
  routeStore,
  validatorConfigSource,
}) {
  const allowSimulatedMode = process.env.BRIDGE_ALLOW_SIMULATED_MODE === 'true';
  const minActiveValidators = Number.parseInt(
    process.env.BRIDGE_QUORUM_MINIMUM || '1',
    10
  );

  if (bridgeSafety.halted) {
    return {
      capabilityId: 'bridge.transfer',
      mode: 'degraded',
      reason: bridgeSafety.haltReason
        ? `Bridge operations are halted: ${bridgeSafety.haltReason}`
        : 'Bridge operations are halted',
      reasonCode: 'BRIDGE_HALTED',
      signals: {
        bridgeSafety: 'halted',
        durableStoreBackend: routeStore.backend,
        activeValidators: verificationStats.activeValidators,
      },
    };
  }

  if (verificationStats.activeValidators === 0) {
    return {
      capabilityId: 'bridge.transfer',
      mode: allowSimulatedMode ? 'simulated' : 'degraded',
      reason: allowSimulatedMode
        ? 'Bridge validators are disabled by BRIDGE_ALLOW_SIMULATED_MODE'
        : 'No active validators configured; bridge verification requires BRIDGE_VALIDATORS or BRIDGE_ALLOW_SIMULATED_MODE=true',
      reasonCode: allowSimulatedMode
        ? 'SIMULATED_MODE_ENABLED'
        : 'NO_ACTIVE_VALIDATORS',
      signals: {
        bridgeSafety: 'operational',
        durableStoreBackend: routeStore.backend,
        activeValidators: verificationStats.activeValidators,
        validatorConfigSource,
      },
    };
  }

  if (verificationStats.activeValidators < minActiveValidators) {
    return {
      capabilityId: 'bridge.transfer',
      mode: 'degraded',
      reason: `Only ${verificationStats.activeValidators} active validators configured; minimum quorum is ${minActiveValidators}`,
      reasonCode: 'VALIDATOR_QUORUM_TOO_LOW',
      signals: {
        bridgeSafety: 'operational',
        durableStoreBackend: routeStore.backend,
        activeValidators: verificationStats.activeValidators,
        validatorConfigSource,
      },
    };
  }

  return {
    capabilityId: 'bridge.transfer',
    mode:
      routeStore.backend === 'db' && verificationStats.activeValidators >= 3
        ? 'production-verified'
        : 'local-manager',
    reason:
      routeStore.backend === 'db' && verificationStats.activeValidators >= 3
        ? 'Bridge transfer is verified by active validators and DB-backed durability'
        : 'Bridge transfer is verified by active validators with local durability',
    reasonCode:
      routeStore.backend === 'db' && verificationStats.activeValidators >= 3
        ? 'PRODUCTION_VERIFIED'
        : 'LOCAL_MANAGER_MODE',
    signals: {
      bridgeSafety: 'operational',
      durableStoreBackend: routeStore.backend,
      activeValidators: verificationStats.activeValidators,
      validatorConfigSource,
    },
  };
}

function buildVerificationCapability({
  verificationStats,
  routeStore,
  validatorConfigSource,
}) {
  const allowSimulatedMode = process.env.BRIDGE_ALLOW_SIMULATED_MODE === 'true';
  const minActiveValidators = Number.parseInt(
    process.env.BRIDGE_QUORUM_MINIMUM || '1',
    10
  );

  if (verificationStats.activeValidators === 0) {
    return {
      capabilityId: 'bridge.verification',
      mode: allowSimulatedMode ? 'simulated' : 'degraded',
      reason: allowSimulatedMode
        ? 'Bridge validators are explicitly allowed to run in simulated mode'
        : 'No active validators configured; verification must fail loud or be explicitly enabled',
      reasonCode: allowSimulatedMode
        ? 'SIMULATED_MODE_ENABLED'
        : 'NO_ACTIVE_VALIDATORS',
      signals: {
        activeValidators: verificationStats.activeValidators,
        registeredValidators: verificationStats.registeredValidators,
        validatorConfigSource,
      },
    };
  }

  if (verificationStats.activeValidators < minActiveValidators) {
    return {
      capabilityId: 'bridge.verification',
      mode: 'degraded',
      reason: `Bridge validator quorum is below the minimum threshold of ${minActiveValidators}`,
      reasonCode: 'VALIDATOR_QUORUM_TOO_LOW',
      signals: {
        activeValidators: verificationStats.activeValidators,
        registeredValidators: verificationStats.registeredValidators,
        validatorConfigSource,
      },
    };
  }

  return {
    capabilityId: 'bridge.verification',
    mode:
      routeStore.backend === 'db' && verificationStats.activeValidators >= 3
        ? 'production-verified'
        : 'local-manager',
    reason:
      routeStore.backend === 'db' && verificationStats.activeValidators >= 3
        ? 'Bridge verification is backed by DB durability and active validators'
        : 'Bridge verification is backed by local durability and active validators',
    reasonCode:
      routeStore.backend === 'db' && verificationStats.activeValidators >= 3
        ? 'PRODUCTION_VERIFIED'
        : 'LOCAL_MANAGER_MODE',
    signals: {
      activeValidators: verificationStats.activeValidators,
      registeredValidators: verificationStats.registeredValidators,
      validatorConfigSource,
    },
  };
}

function buildRouteStoreCapability(routeStore) {
  if (routeStore.health === 'failed') {
    return {
      capabilityId: 'route.store',
      mode: 'unavailable',
      reason: 'Route store health check failed',
      reasonCode: 'ROUTE_STORE_UNAVAILABLE',
      signals: {
        readMode: routeStore.readMode,
        health: routeStore.health,
        backend: routeStore.backend,
      },
    };
  }

  if (routeStore.health === 'degraded') {
    return {
      capabilityId: 'route.store',
      mode: 'degraded',
      reason: 'Route store is running in degraded mode',
      reasonCode: 'ROUTE_STORE_DEGRADED',
      signals: {
        readMode: routeStore.readMode,
        health: routeStore.health,
        backend: routeStore.backend,
      },
    };
  }

  return {
    capabilityId: 'route.store',
    mode: 'production-verified',
    reason: 'Route store is healthy',
    reasonCode: 'ROUTE_STORE_HEALTHY',
    signals: {
      readMode: routeStore.readMode,
      health: routeStore.health,
      backend: routeStore.backend,
    },
  };
}

function determineOverallMode(capabilities) {
  const severity = {
    unavailable: 4,
    degraded: 3,
    simulated: 2,
    'local-manager': 1,
    'production-verified': 0,
  };

  return capabilities.reduce((worst, capability) => {
    if (severity[capability.mode] > severity[worst]) {
      return capability.mode;
    }
    return worst;
  }, 'production-verified');
}

function createBridgesRouter() {
  const router = express.Router();

  router.get('/capabilities/readiness', async (_req, res) => {
    try {
      const routeStore = routeDurableStore.getConsistencyState();
      const bridgeSafety = await routeDurableStore.getBridgeSafety();
      const validatorConfig = parseBridgeValidators();
      const verifiedValidators = getVerifiedValidators(validatorConfig.validators);
      recordBridgeValidatorState(
        verifiedValidators.length,
        validatorConfig.source,
        false
      );
      const verificationStats = {
        registeredValidators: verifiedValidators.length,
        activeValidators: verifiedValidators.length,
      };

      const capabilities = {
        'bridge.transfer': buildBridgeCapability({
          bridgeSafety,
          verificationStats,
          routeStore,
          validatorConfigSource: validatorConfig.source,
        }),
        'bridge.verification': buildVerificationCapability({
          verificationStats,
          routeStore,
          validatorConfigSource: validatorConfig.source,
        }),
        'route.store': buildRouteStoreCapability(routeStore),
      };

      const capabilityList = Object.values(capabilities);

      res.json({
        success: true,
        overallMode: determineOverallMode(capabilityList),
        modes: [
          'unavailable',
          'simulated',
          'local-manager',
          'production-verified',
          'degraded',
        ],
        capabilities,
        signals: {
          bridgeSafety: bridgeSafety.halted ? 'halted' : 'operational',
          validatorConfigSource: validatorConfig.source,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Failed to build bridge capability readiness', {
        service: 'bridges',
        error: { message: error.message, stack: error.stack },
      });
      res.status(500).json({
        success: false,
        error: 'Failed to build bridge capability readiness',
      });
    }
  });

  return router;
}

const startupValidatorConfig = parseBridgeValidators();
const startupVerifiedValidators = getVerifiedValidators(
  startupValidatorConfig.validators
);
recordBridgeValidatorState(
  startupVerifiedValidators.length,
  startupValidatorConfig.source,
  true
);

const router = createBridgesRouter();

module.exports = router;
module.exports.default = router;
module.exports.createBridgesRouter = createBridgesRouter;
