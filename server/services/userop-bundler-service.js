const DEFAULT_ENTRY_POINT_ADDRESS = '0x5FF137D4b0FDCD49Dca30c7CF57E578a026d2789';

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function getBundlerRpcUrl() {
  const configured =
    process.env.BUNDLER_RPC_URL || process.env.USEROP_BUNDLER_RPC_URL || '';
  const trimmed = configured.trim();
  return trimmed ? trimTrailingSlash(trimmed) : null;
}

function getEntryPointAddress(userOp = {}) {
  const configured =
    process.env.BUNDLER_ENTRY_POINT_ADDRESS ||
    process.env.ENTRY_POINT_ADDRESS ||
    userOp.entryPoint ||
    userOp.entrypoint ||
    DEFAULT_ENTRY_POINT_ADDRESS;

  if (typeof configured !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(configured)) {
    const error = new Error('Invalid entry point address');
    error.code = 'INVALID_ENTRY_POINT';
    throw error;
  }

  return configured;
}

function compactUserOperation(userOp) {
  return Object.fromEntries(
    Object.entries(userOp ?? {}).filter(([, value]) => value !== undefined),
  );
}

function buildJsonRpcPayload(method, params) {
  return {
    jsonrpc: '2.0',
    id: `userop-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`,
    method,
    params,
  };
}

async function relayUserOperationToBundler(userOp, { fetchImpl = globalThis.fetch } = {}) {
  const bundlerRpcUrl = getBundlerRpcUrl();
  if (!bundlerRpcUrl) {
    const error = new Error('BUNDLER_RPC_URL is required');
    error.code = 'BUNDLER_RPC_URL_MISSING';
    throw error;
  }

  if (typeof fetchImpl !== 'function') {
    const error = new Error('fetch is not available');
    error.code = 'FETCH_UNAVAILABLE';
    throw error;
  }

  const entryPoint = getEntryPointAddress(userOp);
  const payload = buildJsonRpcPayload('eth_sendUserOperation', [
    compactUserOperation(userOp),
    entryPoint,
  ]);

  try {
    const response = await fetchImpl(bundlerRpcUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const text = await response.text();

    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!response.ok) {
      const error = new Error(
        (parsed && typeof parsed === 'object' && parsed.error && parsed.error.message) ||
          (parsed && typeof parsed === 'object' && parsed.message) ||
          `Bundler request failed with status ${response.status}`,
      );
      error.code = 'BUNDLER_RELAY_FAILED';
      error.status = response.status;
      error.response = parsed;
      throw error;
    }

    if (parsed && typeof parsed === 'object' && parsed.error) {
      const error = new Error(
        parsed.error.message || 'Bundler rejected the user operation',
      );
      error.code = 'BUNDLER_RELAY_FAILED';
      error.response = parsed;
      throw error;
    }

    const userOpHash =
      typeof parsed === 'string'
        ? parsed
        : parsed && typeof parsed.result === 'string'
          ? parsed.result
          : null;

    if (!userOpHash || !userOpHash.startsWith('0x')) {
      const error = new Error('Bundler response did not include a userOpHash');
      error.code = 'BUNDLER_INVALID_RESPONSE';
      error.response = parsed;
      throw error;
    }

    return {
      userOpHash,
      entryPoint,
      bundlerRpcUrl,
      response: parsed,
    };
  } catch (error) {
    if (error && typeof error === 'object' && !error.code) {
      error.code = 'BUNDLER_RELAY_FAILED';
    }
    throw error;
  }
}

module.exports = {
  DEFAULT_ENTRY_POINT_ADDRESS,
  getBundlerRpcUrl,
  getEntryPointAddress,
  relayUserOperationToBundler,
};
