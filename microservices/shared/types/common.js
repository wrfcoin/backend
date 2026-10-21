/**
 * Common types shared across all microservices
 */
/**
 * Common error codes used across services
 */
export var ErrorCodes;
(function (ErrorCodes) {
  // Authentication errors
  ErrorCodes['MISSING_TOKEN'] = 'MISSING_TOKEN';
  ErrorCodes['INVALID_TOKEN'] = 'INVALID_TOKEN';
  ErrorCodes['INVALID_TOKEN_PAYLOAD'] = 'INVALID_TOKEN_PAYLOAD';
  ErrorCodes['AUTHENTICATION_REQUIRED'] = 'AUTHENTICATION_REQUIRED';
  ErrorCodes['INSUFFICIENT_PERMISSIONS'] = 'INSUFFICIENT_PERMISSIONS';
  // Service errors
  ErrorCodes['SERVICE_UNAVAILABLE'] = 'SERVICE_UNAVAILABLE';
  ErrorCodes['SERVICE_AUTH_ERROR'] = 'SERVICE_AUTH_ERROR';
  ErrorCodes['INVALID_SERVICE_TOKEN'] = 'INVALID_SERVICE_TOKEN';
  ErrorCodes['MISSING_SERVICE_INFO'] = 'MISSING_SERVICE_INFO';
  // Common API errors
  ErrorCodes['NOT_FOUND'] = 'NOT_FOUND';
  ErrorCodes['VALIDATION_ERROR'] = 'VALIDATION_ERROR';
  ErrorCodes['INTERNAL_ERROR'] = 'INTERNAL_ERROR';
  ErrorCodes['BAD_REQUEST'] = 'BAD_REQUEST';
  // Business logic errors
  ErrorCodes['RESOURCE_NOT_FOUND'] = 'RESOURCE_NOT_FOUND';
  ErrorCodes['DUPLICATE_RESOURCE'] = 'DUPLICATE_RESOURCE';
  ErrorCodes['OPERATION_FAILED'] = 'OPERATION_FAILED';
})(ErrorCodes || (ErrorCodes = {}));
//# sourceMappingURL=common.js.map
