const { z } = require('zod');
const { core4TraceHeaders } = require('./core4-reader-credential');
const { securityLogger } = require('./logger');

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const id = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/);
const integer = z.number().int().nonnegative().safe();
const schemas = {
  WRFCOIN_ADMIN_NFT_MINT_CONFIG: z.object({ id, owner: address, metadata: z.unknown().optional(), price: integer.optional() }).strict(),
  WRFCOIN_ADMIN_NFT_TRANSFER_CONFIG: z.object({ id, to: address }).strict(),
  WRFCOIN_ADMIN_STEALTH_CONFIG: z.object({
    spend_key: z.string().regex(/^[0-9a-fA-F]{64}$/), view_key: z.string().regex(/^[0-9a-fA-F]{64}$/),
    payment_id: z.string().regex(/^[0-9a-fA-F]{16}$/).optional(),
  }).strict(),
  WRFCOIN_ADMIN_GOVERNANCE_PROPOSAL_CONFIG: z.object({
    proposal_id: id, parameter: z.string().min(1).max(128), value: z.string().min(1).max(8192),
    voting_deadline: integer.optional(), deposit: integer.optional(),
  }).strict(),
};
// Admin-SUPPLIED bodies (#1329 item 2): strict, allow-listed and bounded. Only NFT
// mint/transfer and governance proposals accept one; the mining reward address,
// stealth keys and proposer address stay config-fixed. An empty body still means
// "use the configured payload".
const MAX_METADATA_BYTES = 8192;
const metadata = z.unknown().refine((v) => {
  if (v === undefined) return true;
  try { const text = JSON.stringify(v); return text !== undefined && Buffer.byteLength(text) <= MAX_METADATA_BYTES; } catch { return false; }
}, 'metadata too large');
const bodySchemas = {
  WRFCOIN_ADMIN_NFT_MINT_CONFIG: z.object({ id, owner: address, metadata: metadata.optional(), price: integer.optional() }).strict(),
  WRFCOIN_ADMIN_NFT_TRANSFER_CONFIG: z.object({ to: address }).strict(),
  WRFCOIN_ADMIN_GOVERNANCE_PROPOSAL_CONFIG: schemas.WRFCOIN_ADMIN_GOVERNANCE_PROPOSAL_CONFIG,
};
function isEmptyBody(body) {
  return body === undefined || (body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0);
}
function policyError(status, code, message) { return Object.assign(new Error(message), { status, code, adminPolicy: true }); }
function unavailable() { return policyError(503, 'CORE4_ADMIN_CONFIG_UNAVAILABLE', 'This admin operation requires valid server configuration'); }
function requireEmptyAdminBody(body) {
  if (body !== undefined && (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)) {
    throw policyError(400, 'ADMIN_PARAMETERS_FIXED', 'Admin operation parameters are fixed in server configuration; send an empty object');
  }
}
function configuredAddress(name) {
  const parsed = address.safeParse(process.env[name]?.trim());
  if (!parsed.success) throw unavailable();
  return parsed.data;
}
function configuredAdminPayload(name) {
  try {
    const raw = process.env[name];
    if (!raw || raw.length > 65536 || !schemas[name]) throw unavailable();
    return schemas[name].parse(JSON.parse(raw));
  } catch { throw unavailable(); } // Never disclose raw JSON or validation values.
}
// Use only behind requireAdmin. Caller credentials and identity headers cannot
// select a server role or impersonate an on-chain account.
function core4OperatorHeaders(requestHeaders = {}) {
  const token = process.env.WRFCOIN_OPERATOR_TOKEN?.trim();
  if (!token) throw policyError(503, 'CORE4_OPERATOR_CREDENTIAL_UNCONFIGURED', 'This admin operation requires the backend core4 Operator credential');
  return { authorization: `Bearer ${token}`, ...core4TraceHeaders(requestHeaders) };
}
function sendAdminPolicyError(res, error) {
  if (!error?.adminPolicy) return false;
  res.status(error.status).json({ success: false, error: { code: error.code, message: error.message } });
  return true;
}
function requireConfiguredNft(id, configuredId) {
  if (id !== configuredId) throw policyError(400, 'ADMIN_PARAMETERS_FIXED', 'The NFT must match server configuration');
}
/**
 * Returns { payload, source: 'body' | 'config' }. An empty body falls back to the
 * configured payload (existing behaviour); a non-empty body must satisfy the strict
 * allow-list schema for `name`. Errors never echo submitted values.
 */
function adminBodyOrConfig(name, body) {
  const schema = bodySchemas[name];
  if (!schema) { requireEmptyAdminBody(body); return { payload: configuredAdminPayload(name), source: 'config' }; }
  if (isEmptyBody(body)) return { payload: configuredAdminPayload(name), source: 'config' };
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(body)'))].slice(0, 8).join(', ');
    throw policyError(400, 'ADMIN_BODY_INVALID', `Invalid admin request body; check field(s): ${fields}`);
  }
  return { payload: parsed.data, source: 'body' };
}
function requireValidNftId(value) {
  if (!id.safeParse(value).success) throw policyError(400, 'ADMIN_BODY_INVALID', 'Invalid NFT id');
}
/** One audit line per admin core4 write. Identifiers only: never keys, metadata, tokens or headers. */
function auditAdminCall(req, action, outcome, detail = {}) {
  securityLogger.info('admin_core4_write', {
    action, outcome, actor: req?.user?.userId ?? req?.user?.id ?? null, sessionId: req?.user?.sessionId ?? null,
    method: req?.method, path: req?.originalUrl?.split('?')[0], ...detail,
  });
}
/**
 * A safe, closed classification of a transport failure: never the exception message, which can
 * carry URLs, tokens or coordinates. `indeterminate` marks failures where the request may already
 * have reached core4 (timeout, reset), so the write's outcome is unknown.
 */
function classifyTransportError(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const name = typeof error?.name === 'string' ? error.name : '';
  if (name === 'AbortError' || name === 'TimeoutError' || code === 'ETIMEDOUT' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') {
    return { errorClass: 'timeout', indeterminate: true };
  }
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'UND_ERR_SOCKET') return { errorClass: 'connection_reset', indeterminate: true };
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EHOSTUNREACH') return { errorClass: 'unreachable', indeterminate: false };
  return { errorClass: 'transport', indeterminate: true };
}
/**
 * Runs one admin core4 write with a complete audit trail: `attempt` before, then exactly one
 * terminal record: `ok`/`refused` for an HTTP answer, `error` (with a safe classification) when
 * the transport throws. The exception is rethrown unchanged for the route's own handling.
 */
async function auditedAdminWrite(req, action, audit, run) {
  auditAdminCall(req, action, 'attempt', audit);
  let response;
  try {
    response = await run();
  } catch (error) {
    auditAdminCall(req, action, 'error', { ...audit, ...classifyTransportError(error) });
    throw error;
  }
  auditAdminCall(req, action, response.ok ? 'ok' : 'refused', { ...audit, status: response.status });
  return response;
}
module.exports = { adminBodyOrConfig, requireValidNftId, auditAdminCall, auditedAdminWrite, core4OperatorHeaders, configuredAddress, configuredAdminPayload, requireEmptyAdminBody, requireConfiguredNft, sendAdminPolicyError };
