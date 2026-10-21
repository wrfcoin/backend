/**
 * Retired MCP context provider (backend#1181).
 *
 * No canonical blockchain, weather, governance, or compute source is injected
 * into this module. Keep the legacy API deterministic and explicitly
 * unavailable until a real provider boundary is designed.
 */

const unavailable = Object.freeze({
  success: false,
  unavailable: true,
  reason: 'MCP context is not wired to canonical sources.',
  error: Object.freeze({
    code: 'NOT_IMPLEMENTED',
    capability: 'mcp-context',
    message: 'MCP context is not wired to canonical sources.',
    see: 'wrfcoin/backend#1181',
  }),
});

async function registerProvider() {
  throw new Error('MCP context provider registration is not wired');
}

async function getProvider() {
  return null;
}

async function listProviders() {
  return [];
}

async function getContext() {
  return {
    ...unavailable,
    error: { ...unavailable.error },
  };
}

module.exports = {
  registerProvider,
  getProvider,
  listProviders,
  getContext,
};
