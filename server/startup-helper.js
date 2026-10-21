// OpenTelemetry must be initialized before other imports for auto-instrumentation
const { initializeOTel } = require('./utils/otel-setup.js');
initializeOTel().catch(() => {});

/**
 * Enhanced Server Startup Helper
 * Provides retry logic and graceful error handling for all servers
 */

const { appLogger } = require('./utils/logger');

function startServerWithRetry(app, port, serviceName, maxRetries = 3) {
  let retries = 0;

  const tryStart = currentPort => {
    return new Promise((resolve, reject) => {
      const server = app.listen(currentPort, '0.0.0.0', () => {
        appLogger.info(`${serviceName} started successfully`, { module: 'StartupHelper', operation: 'serverStart', serviceName, port: currentPort });
        resolve(server);
      });

      server.on('error', err => {
        if (err.code === 'EADDRINUSE' && retries < maxRetries) {
          retries++;
          appLogger.warn(`Port ${currentPort} in use, trying next port`, { module: 'StartupHelper', operation: 'portRetry', port: currentPort, nextPort: currentPort + 1 });
          setTimeout(() => {
            tryStart(currentPort + 1)
              .then(resolve)
              .catch(reject);
          }, 1000);
        } else if (err.code === 'EADDRINUSE') {
          appLogger.error(`${serviceName} failed to bind to any port after retries`, { module: 'StartupHelper', operation: 'portBindFail', serviceName, maxRetries });
          reject(new Error(`Port binding failed after ${maxRetries} attempts`));
        } else {
          appLogger.error(`${serviceName} error`, { module: 'StartupHelper', operation: 'serverError', serviceName, error: err.message });
          if (retries < maxRetries) {
            retries++;
            appLogger.info(`Retrying ${serviceName} startup`, { module: 'StartupHelper', operation: 'retry', serviceName, attempt: retries + 1, maxAttempts: maxRetries + 1 });
            setTimeout(() => {
              tryStart(currentPort).then(resolve).catch(reject);
            }, 2000);
          } else {
            reject(err);
          }
        }
      });
    });
  };

  return tryStart(port);
}

module.exports = { startServerWithRetry };
