'use strict';

const axios = require('axios');
const { getCore4ApiUrl } = require('../../shared/core4-url.cjs');

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function probeCore4Health(options = {}) {
  const expected = options.expected !== false;
  const url = `${trimTrailingSlash(
    options.baseUrl || getCore4ApiUrl()
  )}/health`;

  if (!expected) {
    return {
      status: 'up',
      expected: false,
      reachable: false,
      url,
      httpStatus: null,
      lastCheckedAt: new Date().toISOString(),
      lastError: null,
    };
  }

  try {
    const response = await axios.get(url, {
      headers: options.headers || {},
      timeout: parsePositiveInt(options.timeoutMs, 2000),
      validateStatus: () => true,
    });
    const reachable = response.status >= 200 && response.status < 300;

    return {
      status: reachable ? 'up' : 'down',
      expected: true,
      reachable,
      url,
      httpStatus: response.status,
      lastCheckedAt: new Date().toISOString(),
      lastError: reachable ? null : `core4 /health returned ${response.status}`,
      payload: response.data ?? null,
    };
  } catch (error) {
    return {
      status: 'down',
      expected: true,
      reachable: false,
      url,
      httpStatus: null,
      lastCheckedAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message : String(error),
    };
  }
}

async function probeCore4Readiness(options = {}) {
  const expected = options.expected !== false;
  const url = `${trimTrailingSlash(
    options.baseUrl || getCore4ApiUrl()
  )}/readyz`;

  if (!expected) {
    return {
      status: 'up',
      expected: false,
      reachable: false,
      url,
      httpStatus: null,
      readinessStatus: 'skipped',
      lastCheckedAt: new Date().toISOString(),
      lastError: null,
    };
  }

  try {
    const response = await axios.get(url, {
      headers: options.headers || {},
      timeout: parsePositiveInt(options.timeoutMs, 2000),
      validateStatus: () => true,
    });
    const payload = response.data && typeof response.data === 'object'
      ? response.data
      : {};
    const rawReadinessStatus =
      Object.prototype.hasOwnProperty.call(payload, 'status')
        ? payload.status
        : payload.ready;
    const readinessStatus = String(rawReadinessStatus ?? '').toLowerCase();
    const ready =
      response.status >= 200 &&
      response.status < 300 &&
      readinessStatus !== 'not_ready' &&
      readinessStatus !== 'false';

    return {
      status: ready ? 'up' : 'down',
      expected: true,
      reachable: response.status >= 200 && response.status < 500,
      url,
      httpStatus: response.status,
      readinessStatus: readinessStatus || null,
      lastCheckedAt: new Date().toISOString(),
      lastError: ready ? null : `core4 /readyz returned ${response.status}`,
      payload: response.data ?? null,
    };
  } catch (error) {
    return {
      status: 'down',
      expected: true,
      reachable: false,
      url,
      httpStatus: null,
      readinessStatus: null,
      lastCheckedAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message : String(error),
    };
  }
}

module.exports = {
  probeCore4Health,
  probeCore4Readiness,
};
