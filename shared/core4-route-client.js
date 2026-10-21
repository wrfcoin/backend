// error-response.js is CJS (module.exports). The build script generates a
// .cjs shim that Node can load from ESM via default import. Named imports from
// the plain .js form don't work in Node 20 because "type":"module" treats .js
// as ESM, which has no exports in that file.
import _errRespModule from '../server/utils/error-response.js';
const { createErrorResponse } = _errRespModule;

import { nodeHttpFetch } from './core4-node-http.js';

const DEFAULT_CORE4_BASE_URL = 'http://localhost:8556';
const DEFAULT_TIMEOUT_MS = 5000;

const _LEGACY_CORE4_VARS = ['BLOCKCHAIN_NODE_URL', 'BLOCKCHAIN_SERVICE_URL', 'RUST_BLOCKCHAIN_URL'];
let _core4UrlWarnDone = false;

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

/** Canonical resolver for the core4 REST API URL (JS callers). */
export function getCore4BaseUrl() {
  if (process.env.CORE4_API_URL) {
    return trimTrailingSlash(process.env.CORE4_API_URL);
  }
  for (const name of _LEGACY_CORE4_VARS) {
    if (process.env[name]) {
      if (!_core4UrlWarnDone) {
        console.warn(`[core4] env var ${name} is deprecated — set CORE4_API_URL instead (default: ${DEFAULT_CORE4_BASE_URL})`);
        _core4UrlWarnDone = true;
      }
      return trimTrailingSlash(process.env[name]);
    }
  }
  return DEFAULT_CORE4_BASE_URL;
}

/** True when any recognized core4 URL env var is explicitly set. */
export function isCore4ApiConfigured() {
  return !!(process.env.CORE4_API_URL || _LEGACY_CORE4_VARS.some(n => process.env[n]));
}

export function buildCore4Url(path, query = null) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`${getCore4BaseUrl()}${normalizedPath}`);

  if (query && typeof query === 'object') {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') {
        continue;
      }
      url.searchParams.set(key, String(value));
    }
  }

  return url.toString();
}

export async function fetchCore4Json(path, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    query = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;
  const url = buildCore4Url(path, query);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // The node is never a browser target: no Sec-Fetch-* on any request (#1395).
    const response = await nodeHttpFetch(url, {
      method,
      headers: body === undefined
        ? headers
        : {
            'content-type': 'application/json',
            ...headers,
          },
      body:
        body === undefined
          ? undefined
          : typeof body === 'string'
            ? body
            : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;

    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }

    return {
      ok: response.ok,
      status: response.status,
      payload,
      url,
    };
  } catch (error) {
    if (error instanceof Error) {
      error.core4Url = url;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function extractCore4Data(payload) {
  if (
    payload &&
    typeof payload === 'object' &&
    ('success' in payload || 'ok' in payload) &&
    'data' in payload
  ) {
    return payload.data ?? null;
  }

  return payload ?? null;
}

export function getCore4ErrorMessage(payload, fallbackMessage) {
  const nestedErrorMessage =
    payload &&
    typeof payload === 'object' &&
    payload.error &&
    typeof payload.error === 'object'
      ? payload.error.message
      : null;

  if (typeof payload === 'string' && payload.trim()) {
    return payload;
  }

  if (payload && typeof payload === 'object') {
    if (typeof nestedErrorMessage === 'string' && nestedErrorMessage.trim()) {
      return nestedErrorMessage;
    }
    if (
      nestedErrorMessage &&
      typeof nestedErrorMessage === 'object' &&
      typeof nestedErrorMessage.message === 'string' &&
      nestedErrorMessage.message.trim()
    ) {
      return nestedErrorMessage.message;
    }
    if (typeof payload.message === 'string' && payload.message.trim()) {
      return payload.message;
    }
    if (typeof payload.error === 'string' && payload.error.trim()) {
      return payload.error;
    }
  }

  return fallbackMessage;
}

export function forwardCore4Headers(requestHeaders = {}, extraHeaders = {}) {
  const forwarded = {};

  for (const headerName of [
    'authorization',
    'x-api-key',
    'x-request-id',
    'x-correlation-id',
  ]) {
    const value = requestHeaders[headerName];
    if (typeof value === 'string' && value.length > 0) {
      forwarded[headerName] = value;
    }
  }

  return {
    ...forwarded,
    ...extraHeaders,
  };
}

export function sendCore4Unavailable(res, _error, message = 'Blockchain node unavailable') {
  // Transport exceptions can embed credentials, internal URLs or coordinates.
  // Route-owned messages and the closed error code are the public diagnostic.
  return res.status(503).json(
    createErrorResponse(message, 'CORE4_UNAVAILABLE', {
      timestamp: new Date().toISOString(),
    })
  );
}

export function sendCore4Error(res, response, fallbackMessage) {
  const message = getCore4ErrorMessage(response?.payload, fallbackMessage);

  return res.status(response?.status || 502).json(
    createErrorResponse(message, 'CORE4_ERROR', {
      details: response?.payload ?? null,
      timestamp: new Date().toISOString(),
    })
  );
}

export function sendNotImplemented(
  res,
  message,
  details = 'This backend route has no matching core4 API yet.'
) {
  return res.status(501).json(
    createErrorResponse(message, 'NOT_IMPLEMENTED', {
      details,
      timestamp: new Date().toISOString(),
    })
  );
}

export function toNullable(value) {
  return value ?? null;
}
