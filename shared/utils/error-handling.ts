/**
 * Shared Error Handling Utilities
 *
 * Provides type-safe error handling utilities for consistent error processing
 * across the entire TypeScript codebase.
 */

import { appLogger } from '../../server/utils/logger.js';

/**
 * Safely extracts an error message from an unknown error type.
 * This is particularly useful in catch blocks where TypeScript
 * treats the error as 'unknown' in strict mode.
 *
 * @param error - The error object of unknown type
 * @returns A string representation of the error message
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as any).message);
  }
  return 'An unknown error occurred';
}

/**
 * Safely extracts an error stack trace from an unknown error type.
 *
 * @param error - The error object of unknown type
 * @returns A string representation of the error stack, or undefined if not available
 */
export function getErrorStack(error: unknown): string | undefined {
  if (error instanceof Error && error.stack) {
    return error.stack;
  }
  if (
    error &&
    typeof error === 'object' &&
    'stack' in error &&
    typeof (error as any).stack === 'string'
  ) {
    return (error as any).stack;
  }
  return undefined;
}

/**
 * Creates a standardized error object for API responses.
 *
 * @param error - The original error of unknown type
 * @param message - Optional custom message to override the error message
 * @returns An object with message and optional stack trace for debugging
 */
export function createErrorResponse(
  error: unknown,
  message?: string
): { message: string; stack?: string } {
  const errorMessage = message || getErrorMessage(error);
  const stack = getErrorStack(error);

  return {
    message: errorMessage,
    ...(process.env.NODE_ENV === 'development' && stack && { stack }),
  };
}

/**
 * Type guard to check if an error is an Error instance
 *
 * @param error - The error to check
 * @returns True if the error is an Error instance
 */
export function isError(error: unknown): error is Error {
  return error instanceof Error;
}

/**
 * Type guard to check if an error has a specific property
 *
 * @param error - The error to check
 * @param property - The property name to check for
 * @returns True if the error has the specified property
 */
export function hasErrorProperty(error: unknown, property: string): boolean {
  return error !== null && typeof error === 'object' && property in error;
}

/**
 * Safely gets a specific property from an error object
 *
 * @param error - The error object
 * @param property - The property name to extract
 * @returns The property value or undefined if not available
 */
export function getErrorProperty(error: unknown, property: string): unknown {
  if (hasErrorProperty(error, property)) {
    return (error as any)[property];
  }
  return undefined;
}

/**
 * Advanced error handler for Express.js route handlers
 * Provides consistent error response formatting
 *
 * @param error - The error that occurred
 * @param fallbackMessage - Fallback message if error message cannot be extracted
 * @returns Standardized error response object
 */
export function handleRouteError(
  error: unknown,
  fallbackMessage: string = 'Internal server error'
) {
  const message = getErrorMessage(error);
  const stack = getErrorStack(error);

  // Log the full error for debugging
  appLogger.error('Route error', { module: 'ErrorHandling', message, stack, originalError: error instanceof Error ? error.message : String(error) });

  return {
    success: false,
    error: message || fallbackMessage,
    ...(process.env.NODE_ENV === 'development' && stack && { stack }),
  };
}

/**
 * Wraps an async function to provide consistent error handling
 *
 * @param fn - The async function to wrap
 * @returns A wrapped function that handles errors consistently
 */
export function withErrorHandling<T extends (...args: any[]) => Promise<any>>(
  fn: T
): (...args: Parameters<T>) => Promise<ReturnType<T>> {
  return async (...args: Parameters<T>): Promise<ReturnType<T>> => {
    try {
      return await fn(...args);
    } catch (error) {
      appLogger.error('Error in wrapped function', { module: 'ErrorHandling', error: getErrorMessage(error) });
      throw error;
    }
  };
}

// Export error types for better type safety
export interface StandardError {
  message: string;
  code?: string;
  stack?: string;
}

export interface ApiError extends StandardError {
  statusCode: number;
}

/**
 * Creates a standardized API error
 *
 * @param message - Error message
 * @param statusCode - HTTP status code
 * @param code - Optional error code
 * @returns StandardError object
 */
export function createApiError(
  message: string,
  statusCode: number = 500,
  code?: string
): ApiError {
  return {
    message,
    statusCode,
    ...(code && { code }),
  };
}
