const {
  GracefulShutdown,
  ShutdownPriority,
} = require('../../shared/graceful-shutdown/index.js');

function createHttpServerShutdownHandler(server, options = {}) {
  const { name = 'http-server', timeout = 10000 } = options;

  return {
    name,
    priority: ShutdownPriority.DRAIN_HTTP_CONNECTIONS,
    timeout,
    handler: () =>
      new Promise((resolve, reject) => {
        server.close(error => {
          if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

function registerGracefulShutdown(options) {
  const {
    serviceName,
    server,
    logger,
    state = { draining: false },
    cleanupFns = [],
    timeoutMs = parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '30000', 10),
  } = options;

  const shutdown = GracefulShutdown.getInstance({
    globalTimeout: timeoutMs,
    logger: (message, level) => {
      if (!logger) {
        return;
      }
      if (level === 'error' && logger.error) {
        logger.error(message);
      } else if (level === 'warn' && logger.warn) {
        logger.warn(message);
      } else if (logger.info) {
        logger.info(message);
      }
    },
  });

  shutdown.registerHandler({
    name: `${serviceName}-drain-state`,
    priority: ShutdownPriority.STOP_ACCEPTING_CONNECTIONS,
    timeout: 1000,
    handler: () => {
      state.draining = true;
      if (logger?.info) {
        logger.info(`${serviceName} entering draining state`);
      }
    },
  });

  shutdown.registerHandler(
    createHttpServerShutdownHandler(server, {
      name: `${serviceName}-http-server`,
      timeout: Math.min(timeoutMs, 10000),
    })
  );

  cleanupFns.forEach((cleanup, index) => {
    shutdown.registerHandler({
      name: cleanup.name || `${serviceName}-cleanup-${index + 1}`,
      priority: cleanup.priority ?? ShutdownPriority.CLEANUP,
      timeout: cleanup.timeout ?? 5000,
      handler: cleanup.handler,
    });
  });

  shutdown.setupSignalHandlers();
  return shutdown;
}

module.exports = {
  registerGracefulShutdown,
};
