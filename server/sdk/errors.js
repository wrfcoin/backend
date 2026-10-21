/**
 * Error classes for SDK adapter communication
 *
 * These custom error classes help handle and distinguish different types of errors
 * that can occur when communicating with the Rust SDK.
 */

/**
 * Base class for SDK-related errors
 */
class SDKError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = this.constructor.name;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Error indicating a problem with FFI calls to the Rust SDK
 */
class FFIError extends SDKError {
  constructor(message, options = {}) {
    super(message, options);
    this.cause = options.cause;
    this.code = options.code || 'FFI_ERROR';
    this.context = options.context || {};
  }
}

/**
 * Error indicating the SDK is not initialized
 */
class SDKNotInitializedError extends SDKError {
  constructor(message = 'SDK is not initialized', options = {}) {
    super(message, options);
    this.code = 'SDK_NOT_INITIALIZED';
  }
}

/**
 * Error indicating invalid parameters were provided to the SDK
 */
class InvalidParamsError extends SDKError {
  constructor(message, options = {}) {
    super(message, options);
    this.code = 'INVALID_PARAMS';
    this.params = options.params;
  }
}

/**
 * Error indicating a timeout when communicating with the SDK
 */
class SDKTimeoutError extends SDKError {
  constructor(message = 'SDK operation timed out', options = {}) {
    super(message, options);
    this.code = 'SDK_TIMEOUT';
    this.operationName = options.operationName;
    this.timeoutMs = options.timeoutMs;
  }
}

module.exports = {
  SDKError,
  FFIError,
  SDKNotInitializedError,
  InvalidParamsError,
  SDKTimeoutError,
};
