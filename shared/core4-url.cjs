'use strict';

const DEFAULT_CORE4_API_URL = 'http://localhost:8556';
const LEGACY_VARS = ['BLOCKCHAIN_NODE_URL', 'BLOCKCHAIN_SERVICE_URL', 'RUST_BLOCKCHAIN_URL'];
let _warned = false;

function getCore4ApiUrl() {
  if (process.env.CORE4_API_URL) return process.env.CORE4_API_URL;
  for (const name of LEGACY_VARS) {
    if (process.env[name]) {
      if (!_warned) {
        console.warn(`[core4] env var ${name} is deprecated — set CORE4_API_URL instead (default: ${DEFAULT_CORE4_API_URL})`);
        _warned = true;
      }
      return process.env[name];
    }
  }
  return DEFAULT_CORE4_API_URL;
}

function isCore4ApiConfigured() {
  return !!(process.env.CORE4_API_URL || LEGACY_VARS.some(n => process.env[n]));
}

module.exports = { getCore4ApiUrl, isCore4ApiConfigured };
