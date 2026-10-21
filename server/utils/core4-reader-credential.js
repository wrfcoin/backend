// Reader-backed routes lend a server credential only after their caller policy
// passes. No caller bearer, API key or cookie is copied to core4 (#1284).
const READER_UNCONFIGURED = 'CORE4_READER_CREDENTIAL_UNCONFIGURED';
const READER_MESSAGE = 'Chain reads are unavailable: the backend core4 Reader credential is not configured';

function core4TraceHeaders(requestHeaders = {}) {
  const headers = {};
  for (const name of ['x-request-id', 'x-correlation-id']) {
    const value = requestHeaders[name];
    if (typeof value === 'string' && value.length > 0) headers[name] = value;
  }
  return headers;
}

function core4ReaderHeaders(requestHeaders = {}) {
  const token = process.env.WRFCOIN_READER_TOKEN?.trim();
  if (!token) throw Object.assign(new Error(READER_MESSAGE), { code: READER_UNCONFIGURED });
  return { authorization: `Bearer ${token}`, ...core4TraceHeaders(requestHeaders) };
}

// Existing public node reads remain available without a Reader. A missing
// server credential must never cause fallback to caller credentials.
function core4PublicReadHeaders(requestHeaders = {}) {
  const token = process.env.WRFCOIN_READER_TOKEN?.trim();
  return { ...(token ? { authorization: `Bearer ${token}` } : {}), ...core4TraceHeaders(requestHeaders) };
}

function sendReaderCredentialUnavailable(res) {
  return res.status(503).json({
    success: false,
    error: { code: READER_UNCONFIGURED, message: READER_MESSAGE },
    timestamp: new Date().toISOString(),
  });
}

module.exports = { core4ReaderHeaders, core4PublicReadHeaders, core4TraceHeaders, sendReaderCredentialUnavailable, READER_UNCONFIGURED };
