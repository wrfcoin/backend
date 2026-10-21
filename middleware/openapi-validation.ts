/**
 * OpenAPI Request Validation Middleware
 *
 * Lightweight middleware that validates incoming requests against the
 * OpenAPI spec without requiring express-openapi-validator. Validates:
 * - Content-Type for POST/PUT/PATCH requests with bodies
 * - Required path parameters exist and are non-empty
 * - Returns 422 Unprocessable Entity for validation failures
 *
 * The spec is loaded once at startup and cached in memory.
 */

import { Request, Response, NextFunction } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';

interface OpenApiSpec {
  paths: Record<string, Record<string, any>>;
  [key: string]: any;
}

// Cached spec — loaded once at module initialization
let cachedSpec: OpenApiSpec | null = null;

/**
 * Load and cache the OpenAPI specification from disk.
 * Returns null if the file cannot be read or parsed.
 */
function loadSpec(): OpenApiSpec | null {
  if (cachedSpec) return cachedSpec;

  try {
    const specPath = path.resolve(
      __dirname,
      '../api/documentation/openapi.yaml'
    );
    const raw = fs.readFileSync(specPath, 'utf8');
    cachedSpec = yaml.parse(raw) as OpenApiSpec;
    return cachedSpec;
  } catch (err) {
    console.error('[openapi-validation] Failed to load OpenAPI spec:', err);
    return null;
  }
}

/**
 * Convert an Express route path (e.g. /api/bridges/:bridgeId/status)
 * to an OpenAPI path template (e.g. /api/bridges/{bridgeId}/status).
 */
function expressPathToOpenApi(expressPath: string): string {
  return expressPath.replace(/:([a-zA-Z0-9_]+)/g, '{$1}');
}

/**
 * Match a request path against OpenAPI path templates.
 * Returns the matching template string or null.
 */
function matchPath(
  requestPath: string,
  specPaths: string[]
): string | null {
  // Try exact match first
  if (specPaths.includes(requestPath)) return requestPath;

  // Try template matching
  for (const template of specPaths) {
    const regex = new RegExp(
      '^' +
        template
          .replace(/\{[^}]+\}/g, '([^/]+)')
          .replace(/\//g, '\\/') +
        '$'
    );
    if (regex.test(requestPath)) return template;
  }

  return null;
}

/**
 * Extract required path parameter names from an OpenAPI path template.
 */
function extractPathParams(template: string): string[] {
  const matches = template.match(/\{([^}]+)\}/g);
  if (!matches) return [];
  return matches.map((m) => m.slice(1, -1));
}

export interface ValidationOptions {
  /** If true, requests to paths not in the spec are rejected (default: false) */
  rejectUnknownPaths?: boolean;
  /** If true, skip validation entirely and just pass through (default: false) */
  disabled?: boolean;
  /**
   * If true, validate that required requestBody fields are present for POST/PUT/PATCH.
   * Defaults to true in non-production environments (NODE_ENV !== 'production').
   * Issue #474: enforce spec at runtime.
   */
  validateRequiredFields?: boolean;
}

/**
 * Create an OpenAPI validation middleware instance.
 *
 * Usage:
 *   import { createOpenApiValidation } from '../middleware/openapi-validation.js';
 *   app.use(createOpenApiValidation());
 */
export function createOpenApiValidation(
  options: ValidationOptions = {}
) {
  const isNonProd = process.env.NODE_ENV !== 'production';
  const {
    rejectUnknownPaths = false,
    disabled = false,
    // Enable required-field validation in non-production by default (Issue #474)
    validateRequiredFields = isNonProd,
  } = options;

  // Pre-load spec at creation time
  const spec = loadSpec();

  return function openApiValidation(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    // Skip if disabled or spec failed to load
    if (disabled || !spec) {
      next();
      return;
    }

    const method = req.method.toLowerCase();
    const reqPath = req.path;

    // Skip non-API paths (health checks, static files, etc.)
    if (!reqPath.startsWith('/api')) {
      next();
      return;
    }

    const specPaths = Object.keys(spec.paths);
    const matchedTemplate = matchPath(reqPath, specPaths);

    // If path is not in the spec
    if (!matchedTemplate) {
      if (rejectUnknownPaths) {
        res.status(404).json({
          success: false,
          error: `Path ${reqPath} is not documented in the API specification`,
          code: 'UNKNOWN_PATH',
        });
        return;
      }
      // Allow undocumented paths through (graceful degradation)
      next();
      return;
    }

    const pathSpec = spec.paths[matchedTemplate];
    const operationSpec = pathSpec?.[method];

    // If the HTTP method is not documented for this path
    if (!operationSpec && method !== 'options' && method !== 'head') {
      if (rejectUnknownPaths) {
        res.status(405).json({
          success: false,
          error: `Method ${req.method} is not allowed for ${reqPath}`,
          code: 'METHOD_NOT_ALLOWED',
        });
        return;
      }
      next();
      return;
    }

    // Validate Content-Type for requests that should have a body
    if (['post', 'put', 'patch'].includes(method)) {
      const hasRequestBody = operationSpec?.requestBody;
      if (hasRequestBody && req.headers['content-length'] !== '0') {
        const contentType = req.headers['content-type'];
        if (contentType && !contentType.includes('application/json') && !contentType.includes('multipart/form-data') && !contentType.includes('application/x-www-form-urlencoded')) {
          res.status(422).json({
            success: false,
            error: `Unsupported Content-Type: ${contentType}. Expected application/json`,
            code: 'VALIDATION_ERROR',
            details: [
              {
                field: 'Content-Type',
                message:
                  'Request body must be sent as application/json, multipart/form-data, or application/x-www-form-urlencoded',
              },
            ],
          });
          return;
        }
      }
    }

    // Validate required path parameters are present and non-empty
    const requiredParams = extractPathParams(matchedTemplate);
    const missingParams: Array<{ field: string; message: string }> = [];

    for (const paramName of requiredParams) {
      const value = req.params[paramName];
      if (!value || value.trim() === '') {
        missingParams.push({
          field: paramName,
          message: `Path parameter '${paramName}' is required and must not be empty`,
        });
      }
    }

    if (missingParams.length > 0) {
      res.status(422).json({
        success: false,
        error: 'Missing or empty required path parameters',
        code: 'VALIDATION_ERROR',
        details: missingParams,
      });
      return;
    }

    // Validate required requestBody fields in non-production (Issue #474)
    if (
      validateRequiredFields &&
      operationSpec &&
      ['post', 'put', 'patch'].includes(method) &&
      req.body &&
      typeof req.body === 'object'
    ) {
      const bodySchema =
        operationSpec.requestBody?.content?.['application/json']?.schema;
      const requiredBodyFields: string[] = bodySchema?.required ?? [];
      const missingBodyFields: Array<{ field: string; message: string }> = [];

      for (const field of requiredBodyFields) {
        if (req.body[field] === undefined || req.body[field] === null) {
          missingBodyFields.push({
            field,
            message: `Request body field '${field}' is required`,
          });
        }
      }

      if (missingBodyFields.length > 0) {
        res.status(422).json({
          success: false,
          error: 'Missing required request body fields',
          code: 'VALIDATION_ERROR',
          details: missingBodyFields,
        });
        return;
      }
    }

    next();
  };
}

/**
 * Get the loaded OpenAPI spec (useful for serving at /api-spec).
 */
export function getOpenApiSpec(): OpenApiSpec | null {
  return loadSpec();
}

export default createOpenApiValidation;
