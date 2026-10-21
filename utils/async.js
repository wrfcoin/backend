/**
 * Async utilities for Wrfcoin
 *
 * Helper functions for asynchronous operations
 */

/**
 * Sleep for the specified number of milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry an async function with exponential backoff
 * @param {Function} fn - Function to retry
 * @param {Object} options - Retry options
 * @param {number} options.maxRetries - Maximum number of retries
 * @param {number} options.initialDelay - Initial delay in milliseconds
 * @param {number} options.maxDelay - Maximum delay in milliseconds
 * @returns {Promise<any>}
 */
async function retry(fn, options = {}) {
  const maxRetries = options.maxRetries || 3;
  const initialDelay = options.initialDelay || 1000;
  const maxDelay = options.maxDelay || 10000;

  let retries = 0;
  let delay = initialDelay;

  while (true) {
    try {
      return await fn();
    } catch (error) {
      if (retries >= maxRetries) {
        throw error;
      }

      retries++;
      await sleep(delay);
      delay = Math.min(delay * 2, maxDelay);
    }
  }
}

/**
 * Run multiple async tasks in parallel with a concurrency limit
 * @param {Array<Function>} tasks - Array of async functions to execute
 * @param {number} concurrency - Maximum number of concurrent tasks
 * @returns {Promise<Array<any>>}
 */
async function parallel(tasks, concurrency = Infinity) {
  const results = [];
  const executing = new Set();

  for (const [index, task] of tasks.entries()) {
    const promise = Promise.resolve().then(() => task());
    results[index] = promise;

    // Add the promise to the set of executing promises
    executing.add(promise);

    // Clean up executing set after task completes
    const cleanup = () => executing.delete(promise);
    promise.then(cleanup, cleanup);

    // If we've reached concurrency limit, wait for a task to complete
    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }

  return Promise.all(results);
}

module.exports = {
  sleep,
  retry,
  parallel,
};
