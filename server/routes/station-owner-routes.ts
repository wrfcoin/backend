/**
 * Station owner-action relay and ownership read (station theft protection, core4#3345/#3347,
 * infra#1095; spec: docs/plans/overnight-2026-09-24/r23/station-owner-actions-spec.md, PROVISIONAL
 * until core4#3433 and the owner-tx-routes PR merge). Node contracts used: POST
 * /transactions/station/owner-actions (spec 6.3) and GET /transactions/station/registrations/{id}/owner-ledger (spec 7.2).
 *
 *   POST /api/stations/:stationId/owner-actions   body {kind, payload}: relay one signed owner payload
 *   GET  /api/stations/:stationId/ownership       ownership state (nonce, frozen, pending recovery)
 *
 * The backend NEVER signs and NEVER alters a tx. The phone builds and signs it; this route checks
 * its shape and size, authenticates the caller per kind, and forwards the EXACT text of the signed payload as
 * {chain_id, network_id, payloads:[{kind, payload_json}]} to core4 `POST /transactions/station/owner-actions`
 * (the node builds the transaction envelope). A 201 means "accepted, pending confirmation", NOT "applied":
 * post-mining refusals are silent no-ops on chain, so clients confirm by polling the read route.
 */
import { createHash } from 'node:crypto';
import express from 'express';
import { fetchCore4Json as defaultFetchCore4Json } from '../../shared/core4-route-client.js';
import { peekWalletSubject } from '../middleware/authMiddleware.js';
import { hasOperatorOrReaderToken } from '../middleware/operator-token-auth.js';
import { core4ContributorHeaders } from '../utils/core4-contributor-credential.js';
import { core4ReaderHeaders } from '../utils/core4-reader-credential.js';
import { isStationAlias, resolveStationAlias, stationAlias } from '../utils/station-alias.js';
import { shortAddress } from '../utils/contributor-alias.js';
import { createWindowCounter, rateLimitKey } from '../utils/rate-limit-key.js';

type Core4Result = { ok: boolean; status: number; payload: any };
type Core4Fetch = (path: string, options?: Record<string, unknown>) => Promise<Core4Result>;
type DbExecutor = { execute: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

/** Largest relayed body. The biggest legitimate tx (a transfer) is well under 3 KB. */
export const OWNER_ACTION_MAX_BODY_BYTES = 8 * 1024;
/** Mirrors the node's admission window (core4 station.rs: half of the 300 s window). */
export const OWNER_ACTION_TIMESTAMP_WINDOW_MS = 150_000;
/** The recovery notice window (core4 STATION_OWNER_RECOVERY_NOTICE_BLOCKS). */
export const RECOVERY_NOTICE_BLOCKS = 34_000;

const NODE_OWNER_ACTIONS_PATH = '/transactions/station/owner-actions';

export type OwnerKind = 'transfer' | 'action' | 'recovery_file' | 'recovery_cancel' | 'recovery_execute';

const ADDRESS = /^(0x|wrf)[0-9a-fA-F]{40}$/;
const PUBKEY = /^[0-9a-fA-F]{64}$/;
const SIGNATURE = /^[0-9a-fA-F]{128}$/;
type FieldKind = 'station' | 'address' | 'pubkey' | 'signature' | 'u64' | 'action';

const KIND_SPECS: Record<string, { kind: OwnerKind; fields: Record<string, FieldKind> }> = {
  station_owner_transfer_v1: {
    kind: 'transfer',
    fields: {
      station_id: 'station', from_owner_address: 'address', from_owner_pubkey: 'pubkey',
      to_owner_address: 'address', to_owner_pubkey: 'pubkey', transfer_nonce: 'u64',
      expires_at_height: 'u64', from_owner_signature: 'signature', to_owner_signature: 'signature',
    },
  },
  station_owner_action_v1: {
    kind: 'action',
    fields: {
      station_id: 'station', owner_address: 'address', owner_pubkey: 'pubkey', action: 'action',
      action_nonce: 'u64', expires_at_height: 'u64', owner_signature: 'signature',
    },
  },
  station_owner_recovery_file_v1: {
    kind: 'recovery_file',
    fields: {
      station_id: 'station', from_owner_address: 'address', to_owner_address: 'address',
      to_owner_pubkey: 'pubkey', recovery_nonce: 'u64', to_owner_signature: 'signature',
      auth_pubkey: 'pubkey', auth_signature: 'signature',
    },
  },
  station_owner_recovery_cancel_v1: {
    kind: 'recovery_cancel',
    fields: {
      station_id: 'station', owner_address: 'address', owner_pubkey: 'pubkey',
      recovery_nonce: 'u64', owner_signature: 'signature',
    },
  },
  station_owner_recovery_execute_v1: {
    kind: 'recovery_execute',
    fields: { station_id: 'station', recovery_nonce: 'u64' },
  },
};
/** The phone's `kind` for each payload tx_kind. There is no standalone recovery-accept tx: the new owner's
 *  countersignature rides inside the (governance-signed) recovery file, so `recovery_accept` is unsupported. */
const CLIENT_KINDS: Record<string, OwnerKind> = {
  transfer: 'transfer',
  owner_action: 'action',
  recovery_cancel: 'recovery_cancel',
  recovery_execute: 'recovery_execute',
  recovery_file: 'recovery_file',
};
const ACTIONS = new Set(['report_stolen', 'unfreeze', 'deactivate', 'reactivate']);

/**
 * Kinds a caller with no wallet login may submit (the claimant has typically lost the owner key).
 * recovery_file is deliberately NOT here or anywhere on this route: the spec (section 6.3) makes it a
 * governance-signed operator artifact that "the backend relay must not offer to ordinary users".
 */
const SIGNATURE_ONLY: ReadonlySet<OwnerKind> = new Set(['recovery_execute']);
const NOT_OFFERED: ReadonlySet<OwnerKind> = new Set(['recovery_file']);

/** `express.json({ verify })` hook: keep the caller's exact bytes so the relay forwards them unaltered. */
export function captureOwnerActionRawBody(req: any, _res: unknown, buf: Buffer): void {
  if (typeof req.url === 'string' && /\/stations\/[^/]+\/owner-actions(?:\?|$)/.test(req.url)) {
    req.rawBody = Buffer.from(buf);
  }
}

/**
 * Fixed client messages for the node's refusal codes (spec 6.3: switch on `error.code`, never on `message`).
 * The node code is passed through as error.code; node text is never echoed.
 */
const REFUSALS: Record<string, string> = {
  UNPROCESSABLE_ENTITY: 'the node rejected the request body',
  CHAIN_IDENTITY_MISMATCH: 'chain_id/network_id are not this network\'s: fetch them from the node and re-sign',
  OWNER_TX_NOT_OWNER_TX: 'not a station owner transaction',
  OWNER_TX_FEATURE_NOT_ACTIVE: 'station owner actions are not active on this network yet',
  OWNER_TX_MALFORMED: 'the owner transaction payload is malformed',
  OWNER_TX_SAME_OWNER: 'the new owner is the same as the current owner',
  OWNER_TX_FROM_KEY_NOT_BOUND: 'the current owner key does not match the owner address',
  OWNER_TX_TO_KEY_NOT_BOUND: 'the new owner key does not match the new owner address',
  OWNER_TX_OWNER_KEY_NOT_BOUND: 'the owner key does not match the owner address',
  OWNER_TX_BAD_OWNER_SIGNATURE: 'the owner signature is missing or invalid',
  OWNER_TX_BAD_COUNTERSIGNATURE: 'the new owner countersignature is missing or invalid',
  OWNER_TX_NOT_GOVERNANCE: 'the governance key is not authorised',
  OWNER_TX_BAD_GOVERNANCE_SIGNATURE: 'the governance signature is invalid',
  OWNER_TX_EXPIRED: 'expires_at_height has passed: re-sign with a later height',
  OWNER_TX_VALIDITY_TOO_LONG: 'expires_at_height is too far ahead: sign tip + 5000',
  OWNER_TX_UNKNOWN_STATION: 'the station is not registered on chain',
  OWNER_TX_NOT_REGISTERED_OWNER: 'the signer is not the registered owner',
  OWNER_TX_NONCE_MISMATCH: 'the nonce is stale: re-read the ownership state and sign again',
  OWNER_TX_NONCE_EXHAUSTED: 'the station nonce is exhausted',
  OWNER_TX_STATION_FROZEN: 'the station is frozen',
  OWNER_TX_NOT_FROZEN: 'the station is not frozen',
  OWNER_TX_ALREADY_DEACTIVATED: 'the station is already deactivated',
  OWNER_TX_NOT_DEACTIVATED: 'the station is not deactivated',
  OWNER_TX_RECOVERY_ALREADY_PENDING: 'a recovery is already pending',
  OWNER_TX_NO_PENDING_RECOVERY: 'no recovery is pending (a live owner step may have voided it)',
  OWNER_TX_NOTICE_WINDOW_ELAPSED: 'the recovery notice window has elapsed',
  OWNER_TX_NOTICE_WINDOW_NOT_ELAPSED: 'the recovery notice window has not elapsed yet',
  OWNER_TX_DUPLICATE_STATION_IN_BATCH: 'one owner transaction per station per request',
  OWNER_TX_STALE_TIMESTAMP: 'the transaction timestamp is outside the accepted window: re-stamp and re-sign',
  OWNER_TX_ID_MISMATCH: 'the transaction id does not match its content',
  OWNER_TX_ID_MISSING: 'the transaction id is missing',
  OWNER_TX_EXECUTE_ALREADY_PENDING: 'an execute for this station is already waiting to be mined',
  OWNER_TX_ENVELOPE_NONCANONICAL: 'the transaction envelope is not the canonical one',
  OWNER_TX_BODY_EMPTY: 'nothing to submit',
  OWNER_TX_BODY_FORM: 'the request form is not accepted by the node',
  OWNER_TX_KIND_MISMATCH: 'the kind does not match the payload',
  MEMPOOL_REJECTED: 'the node mempool refused the transaction (duplicate or full)',
};


type Problem = { status: number; code: string; message: string };
const problem = (status: number, code: string, message: string): Problem => ({ status, code, message });

function addressBytes(value: unknown): string | null {
  if (typeof value !== 'string' || !ADDRESS.test(value)) return null;
  return value.slice(value.startsWith('wrf') ? 3 : 2).toLowerCase();
}
const sameAddress = (a: unknown, b: unknown): boolean => {
  const x = addressBytes(a);
  return x !== null && x === addressBytes(b);
};

export type ValidatedOwnerTx = {
  kind: OwnerKind;
  clientKind: string;
  txKind: string;
  payload: Record<string, unknown>;
};

/**
 * Locate the exact source text of a top-level member of a JSON object. Returns null when the key is absent
 * or appears more than once (the parsed value would then differ from the first occurrence).
 */
export function rawTopLevelValue(text: string, key: string): string | null {
  let i = 0;
  const ws = () => { while (i < text.length && ' \t\r\n'.includes(text[i])) i += 1; };
  const str = (): string | null => {
    if (text[i] !== '"') return null;
    const start = i;
    i += 1;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    if (i >= text.length) return null;
    i += 1;
    try { return JSON.parse(text.slice(start, i)) as string; } catch { return null; }
  };
  const value = (): void => {
    if (text[i] === '"') { str(); return; }
    if (text[i] === '{' || text[i] === '[') {
      let depth = 0;
      while (i < text.length) {
        const ch = text[i];
        if (ch === '"') { str(); continue; }
        if (ch === '{' || ch === '[') depth += 1;
        if (ch === '}' || ch === ']') { depth -= 1; if (depth === 0) { i += 1; return; } }
        i += 1;
      }
      return;
    }
    while (i < text.length && !',} \t\r\n'.includes(text[i])) i += 1;
  };
  ws();
  if (text[i] !== '{') return null;
  i += 1;
  let found: string | null = null;
  for (;;) {
    ws();
    if (text[i] === '}') return found;
    const k = str();
    if (k === null) return null;
    ws();
    if (text[i] !== ':') return null;
    i += 1;
    ws();
    const start = i;
    value();
    if (k === key) {
      if (found !== null) return null;
      found = text.slice(start, i);
    }
    ws();
    if (text[i] === ',') { i += 1; continue; }
    if (text[i] === '}') return found;
    return null;
  }
}

/** Stateless shape validation of {kind, payload}. The payload text is forwarded verbatim; it is never rewritten. */
export function validateOwnerActionBody(body: unknown, stationId: string): ValidatedOwnerTx | Problem {
  const bad = (message: string) => problem(422, 'INVALID_OWNER_ACTION', message);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('the body must be a JSON object');
  const env = body as Record<string, unknown>;
  if (Object.keys(env).some((k) => !['kind', 'payload'].includes(k))) return bad('the body is exactly {kind, payload}');
  if (typeof env.kind !== 'string') return bad('kind is required');
  if (env.kind === 'recovery_accept') {
    return problem(422, 'UNSUPPORTED_KIND', 'there is no standalone recovery accept: the new owner countersignature is part of the governance-signed recovery filing');
  }
  const wantKind = CLIENT_KINDS[env.kind];
  if (!wantKind) return bad('kind must be transfer, owner_action, recovery_cancel or recovery_execute');
  const payload = env.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return bad('payload must be the signed payload JSON object');
  const p = payload as Record<string, unknown>;
  const spec = typeof p.tx_kind === 'string' ? KIND_SPECS[p.tx_kind] : undefined;
  if (!spec) return bad('tx_kind is not a station owner action');
  if (spec.kind !== wantKind) return bad('kind does not match the payload tx_kind');
  const allowed = new Set(['tx_kind', ...Object.keys(spec.fields)]);
  if (Object.keys(p).some((k) => !allowed.has(k))) return bad('unexpected payload fields');
  for (const [field, type] of Object.entries(spec.fields)) {
    const v = p[field];
    const ok =
      type === 'station' ? typeof v === 'string' && v === stationId
      : type === 'address' ? typeof v === 'string' && ADDRESS.test(v)
      : type === 'pubkey' ? typeof v === 'string' && PUBKEY.test(v)
      : type === 'signature' ? typeof v === 'string' && SIGNATURE.test(v)
      : type === 'action' ? typeof v === 'string' && ACTIONS.has(v)
      : typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
    if (!ok) return bad(type === 'station' ? 'station_id does not match the station in the path' : `${field} is missing or malformed`);
  }
  return { kind: spec.kind, clientKind: env.kind, txKind: p.tx_kind as string, payload: p };
}

/** The 20 raw address bytes as lowercase hex (no prefix) from a `0x...` or `wrf...`/`WRF...` address; null when unparseable. */
export function addressRawHex(address: unknown): string | null {
  if (typeof address !== 'string') return null;
  const m = /^(?:0x|wrf)([0-9a-f]{40})$/i.exec(address);
  return m ? m[1].toLowerCase() : null;
}

/**
 * A per-station salted commitment to an owner address, shown to ALL viewers so a transfer receiver who holds a guess of
 * the current owner's address can confirm it (non-owners only see a short address). Salted by the station, so it does
 * not link a person across stations; it only confirms a guess the caller already holds.
 * v1 = sha256("wrfcoin-owner-commit-v1:" + station_id + ":" + lowercase hex of the 20 raw address bytes, no prefix),
 * lowercase hex. The `0x` and `wrf` spellings of the same bytes give the SAME commitment. station_id is the RAW id
 * (the offer body carries it). Returns null for an unparseable address: never an empty or garbage commitment.
 */
export function ownerCommitment(stationId: string, address: unknown): string | null {
  const raw = addressRawHex(address);
  return raw === null ? null : createHash('sha256').update(`wrfcoin-owner-commit-v1:${stationId}:${raw}`).digest('hex');
}

/** Who may submit this kind. `null` = allowed. */
function callerProblem(kind: OwnerKind, payload: Record<string, unknown>, wallet: string | null): Problem | null {
  if (SIGNATURE_ONLY.has(kind)) return null; // the claimant has typically lost the owner key: signature-only
  if (!wallet) return problem(401, 'WALLET_LOGIN_REQUIRED', 'sign in with the wallet that signed this transaction');
  // transfer: the sender signs, passes the text to the NEW owner, who countersigns and submits. So the login may be the
  // current OR the new owner named in the body; both signatures are required and verified by the node, so the login is
  // only an anti-abuse gate.
  const parties = kind === 'transfer' ? [payload.from_owner_address, payload.to_owner_address] : [payload.owner_address];
  return parties.some((a) => sameAddress(a, wallet)) ? null : problem(403, 'NOT_THE_SIGNER', 'the logged-in wallet is not a signer of this transaction');
}

export function createStationOwnerRouter(deps: {
  db?: DbExecutor;
  fetchCore4Json?: Core4Fetch;
  now?: () => number;
  /** Verified wallet login of the caller, lowercased; defaults to the JWT subject. */
  walletOf?: (req: express.Request) => string | null;
  /** The node's signing identity for the envelope; defaults to the WRFCOIN_CHAIN_ID / WRFCOIN_NETWORK_ID convention. */
  chainIdentity?: () => { chainId: string; networkId: string };
  /** Operator/reader bearer: may address a station by raw id on the READ route only. */
  isOperator?: (req: express.Request) => boolean;
  limits?: { relayPerIp?: number; signatureOnlyPerIp?: number; readPerIp?: number; windowMs?: number; maxKeys?: number };
} = {}): express.Router {
  const router = express.Router();
  const fetchCore4Json = deps.fetchCore4Json ?? (defaultFetchCore4Json as Core4Fetch);
  const now = deps.now ?? Date.now;
  const chainIdentity = deps.chainIdentity ?? (() => ({
    chainId: process.env.WRFCOIN_CHAIN_ID?.trim() || '777',
    networkId: process.env.WRFCOIN_NETWORK_ID?.trim() || 'testnet',
  }));
  const walletOf = deps.walletOf ?? ((req: express.Request) => peekWalletSubject(req));
  const isOperator = deps.isOperator ?? ((req: express.Request) => hasOperatorOrReaderToken(req));
  const db: DbExecutor = deps.db ?? {
    execute: async (sql, params) => (await import('../../database/index.js')).executeQuery(sql, params),
  };
  const windowMs = deps.limits?.windowMs ?? 15 * 60 * 1000;
  const relayPerIp = createWindowCounter(deps.limits?.relayPerIp ?? 30, windowMs, now, deps.limits?.maxKeys);
  // Signature-only kinds carry no login, so they are rate-limited hard per IP. There is deliberately NO per-station
  // budget: execute is unsigned and idempotent at the node (which refuses it with no pending or ripe recovery), so a
  // per-station cap would protect nothing and let anyone burn it to lock the real executor out (rev-1 blocker).
  const sigOnlyPerIp = createWindowCounter(deps.limits?.signatureOnlyPerIp ?? 5, 60 * 60 * 1000, now, deps.limits?.maxKeys);
  const readPerIp = createWindowCounter(deps.limits?.readPerIp ?? 120, windowMs, now, deps.limits?.maxKeys);

  const send = (res: express.Response, p: Problem, extra: Record<string, unknown> = {}) =>
    res.status(p.status).json({ success: false, error: { code: p.code, message: p.message, ...extra } });

  // Anonymous callers address a station by its public alias; the resolved id is internal-only.
  router.param('stationId', async (req, res, next, raw: string) => {
    try {
      if (isStationAlias(raw)) {
        const resolved = await resolveStationAlias(
          async (sql: string, params: unknown[]) => (await db.execute(sql, params)).rows,
          raw,
        );
        if (resolved.status === 'found') { res.locals.stationId = resolved.stationId; return next(); }
        return send(res, problem(404, 'STATION_NOT_FOUND', 'unknown station'));
      }
      if (req.method === 'GET' && isOperator(req)) { res.locals.stationId = raw; return next(); }
      return send(res, problem(404, 'STATION_NOT_FOUND', 'unknown station'));
    } catch {
      return send(res, problem(503, 'STATION_LOOKUP_UNAVAILABLE', 'station lookup unavailable'));
    }
  });
  const stationIdOf = (res: express.Response): string => String(res.locals.stationId);

  router.post('/stations/:stationId/owner-actions', async (req, res) => {
    try {
      const ip = rateLimitKey(String(req.ip ?? 'unknown'));
      if (!relayPerIp(ip)) return send(res, problem(429, 'RATE_LIMITED', 'too many requests, try again later'));
      const raw: Buffer | undefined = (req as any).rawBody;
      if (!raw) return send(res, problem(415, 'JSON_BODY_REQUIRED', 'send application/json'));
      if (raw.length > OWNER_ACTION_MAX_BODY_BYTES) {
        return send(res, problem(413, 'BODY_TOO_LARGE', `the body must be at most ${OWNER_ACTION_MAX_BODY_BYTES} bytes`));
      }
      const stationId = stationIdOf(res);
      const validated = validateOwnerActionBody(req.body, stationId);
      if ('status' in validated) return send(res, validated);
      // The exact source text of the signed payload: forwarded byte for byte, never re-serialised.
      const payloadJson = rawTopLevelValue(raw.toString('utf8'), 'payload');
      if (payloadJson === null) return send(res, problem(422, 'INVALID_OWNER_ACTION', 'payload must appear exactly once'));

      if (NOT_OFFERED.has(validated.kind)) {
        return send(res, problem(403, 'RECOVERY_FILE_NOT_OFFERED', 'recovery filing is a governance operation and is not relayed for users'));
      }
      const denied = callerProblem(validated.kind, validated.payload, walletOf(req));
      if (denied) return send(res, denied);
      if (SIGNATURE_ONLY.has(validated.kind) && !sigOnlyPerIp(ip)) {
        return send(res, problem(429, 'RATE_LIMITED', 'too many unauthenticated recovery requests from this address, try again later'));
      }

      let headers: Record<string, string>;
      try {
        headers = core4ContributorHeaders(req.headers) as Record<string, string>;
      } catch {
        return send(res, problem(503, 'RELAY_UNAVAILABLE', 'owner actions are unavailable: the backend core4 credential is not configured'));
      }
      let upstream: Core4Result;
      try {
        // The payload text is passed through untouched (the node builds and checks the transaction); only the
        // node envelope around it is the backend's.
        const identity = chainIdentity();
        upstream = await fetchCore4Json(NODE_OWNER_ACTIONS_PATH, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            chain_id: identity.chainId,
            network_id: identity.networkId,
            // The node requires payloads[].kind to equal the payload's own tx_kind (core4 #3482), not the phone's `kind`.
            payloads: [{ kind: validated.txKind, payload_json: payloadJson }],
          }),
        });
      } catch {
        return send(res, problem(503, 'NODE_UNAVAILABLE', 'the blockchain node is unavailable, retry shortly'), { retryable: true });
      }
      if (upstream.ok) {
        const data = upstream.payload?.data ?? upstream.payload ?? {};
        const ids: unknown = data.transaction_ids ?? data.transactionIds;
        const transactionIds = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string' && x.length <= 128) : [];
        return res.status(201).json({
          success: true,
          status: 'accepted_pending_confirmation',
          applied: false,
          message: 'accepted, pending confirmation: NOT applied yet. The node can still refuse this at mining time, so poll the ownership state to confirm.',
          kind: validated.txKind,
          stationAlias: stationAlias(stationId),
          transactionIds,
          admissionHeight: Number.isSafeInteger(data.admission_height) ? data.admission_height : null,
          confirmWith: `/api/stations/${stationAlias(stationId)}/ownership`,
        });
      }
      // Node refusals (spec 6.3: switch on `error.code`, never on `message`): the node's stable code is passed
      // through as error.code with 422; the message is ours and never echoes node text.
      const nodeCode = upstream.payload?.error?.code;
      if (typeof nodeCode === 'string' && /^[A-Z0-9_]{1,64}$/.test(nodeCode) && upstream.status >= 400 && upstream.status < 500
        && upstream.status !== 401 && upstream.status !== 403 && upstream.status !== 404 && upstream.status !== 405 && upstream.status !== 429) {
        return send(res, problem(422, nodeCode, REFUSALS[nodeCode] ?? 'the node rejected the transaction'));
      }
      if (upstream.status === 429) return send(res, problem(503, 'NODE_BUSY', 'the node is busy, retry shortly'), { retryable: true });
      if (upstream.status >= 500 || upstream.status === 401 || upstream.status === 403 || upstream.status === 404 || upstream.status === 405) {
        // 401/403: our own credential; 404/405: a node without the route yet. Never a client fault.
        return send(res, problem(503, 'NODE_UNAVAILABLE', 'the blockchain node cannot take owner actions right now'), { retryable: true });
      }
      return send(res, problem(422, 'NODE_REJECTED', 'the node rejected the transaction'));
    } catch {
      if (!res.headersSent) send(res, problem(503, 'OWNER_ACTION_UNAVAILABLE', 'owner actions are temporarily unavailable'));
    }
  });

  router.get('/stations/:stationId/ownership', async (req, res) => {
    try {
      if (!readPerIp(rateLimitKey(String(req.ip ?? 'unknown')))) return send(res, problem(429, 'RATE_LIMITED', 'too many requests, try again later'));
      const stationId = stationIdOf(res);
      let headers: Record<string, string>;
      try {
        headers = core4ReaderHeaders(req.headers) as Record<string, string>;
      } catch {
        return send(res, problem(503, 'OWNERSHIP_STATE_UNAVAILABLE', 'ownership state is unavailable'));
      }
      let upstream: Core4Result;
      try {
        upstream = await fetchCore4Json(`/transactions/station/registrations/${encodeURIComponent(stationId)}/owner-ledger`, { headers });
      } catch {
        return send(res, problem(503, 'OWNERSHIP_STATE_UNAVAILABLE', 'ownership state is unavailable'), { retryable: true });
      }
      if (upstream.status === 404) return send(res, problem(404, 'STATION_NOT_REGISTERED', 'the station is not registered on chain'));
      if (!upstream.ok) return send(res, problem(503, 'OWNERSHIP_STATE_UNAVAILABLE', 'ownership state is unavailable'), { retryable: true });
      const data = upstream.payload?.data ?? upstream.payload;
      const ledger = data?.owner_ledger;
      // Never default to "not frozen": EVERY expected key must be PRESENT with the right type. null is accepted only
      // where the node schema allows it (frozen, pending_recovery) and only when the key is present; a node that omits
      // a key is a contract mismatch, not a 200 that reads as "not frozen".
      const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
      const has = (o: any, k: string): boolean => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
      const features = data?.features;
      const mismatch = !data || typeof data !== 'object' || typeof data.owner_address !== 'string'
        || !ledger || typeof ledger !== 'object' || Array.isArray(ledger)
        || !isInt(ledger.owner_nonce) || typeof ledger.owner_deactivated !== 'boolean'
        || !has(ledger, 'frozen') || !has(ledger, 'pending_recovery')
        || typeof data.rewards_suspended !== 'boolean' || typeof data.is_active !== 'boolean'
        || !features || typeof features !== 'object'
        || ['station_owner_consent', 'station_owner_actions', 'station_active_reward_gate'].some((k) => typeof features[k] !== 'boolean')
        || !isInt(data.recovery_notice_blocks) || !isInt(data.observed_at_height) || !isInt(data.settled_height);
      if (mismatch) {
        return send(res, problem(502, 'CORE4_CONTRACT_MISMATCH', 'the node did not report ownership state in the expected shape'));
      }
      const ownerCommit = ownerCommitment(stationId, data.owner_address);
      if (ownerCommit === null) {
        return send(res, problem(502, 'CORE4_CONTRACT_MISMATCH', 'the node did not report ownership state in the expected shape'));
      }
      const wallet = walletOf(req);
      const operator = isOperator(req);
      const show = (address: unknown): string | null =>
        typeof address !== 'string' ? null : operator || sameAddress(address, wallet) ? address : shortAddress(address);
      const isOwner = sameAddress(data.owner_address, wallet);

      const pending = ledger.pending_recovery;
      let pendingRecovery: Record<string, unknown> | null = null;
      if (pending !== null) {
        if (typeof pending !== 'object' || Array.isArray(pending) || !isInt(pending.recovery_nonce) || !isInt(pending.filed_at_height)
          || !isInt(pending.executable_at_height) || typeof pending.from_owner_address !== 'string'
          || typeof pending.to_owner_address !== 'string') {
          return send(res, problem(502, 'CORE4_CONTRACT_MISMATCH', 'the node did not report ownership state in the expected shape'));
        }
        const fromCommit = ownerCommitment(stationId, pending.from_owner_address);
        const toCommit = ownerCommitment(stationId, pending.to_owner_address);
        if (fromCommit === null || toCommit === null) {
          return send(res, problem(502, 'CORE4_CONTRACT_MISMATCH', 'the node did not report ownership state in the expected shape'));
        }
        pendingRecovery = {
          fromOwner: show(pending.from_owner_address),
          toOwner: show(pending.to_owner_address),
          fromOwnerCommitment: fromCommit,
          toOwnerCommitment: toCommit,
          recoveryNonce: pending.recovery_nonce,
          filedAtHeight: pending.filed_at_height,
          executableAtHeight: pending.executable_at_height,
          noticeBlocks: data.recovery_notice_blocks,
        };
      }
      const frozenRaw = ledger.frozen;
      if (frozenRaw !== null && (typeof frozenRaw !== 'object' || Array.isArray(frozenRaw) || !isInt(frozenRaw.since_height))) {
        return send(res, problem(502, 'CORE4_CONTRACT_MISMATCH', 'the node did not report ownership state in the expected shape'));
      }
      const frozen = frozenRaw === null ? null : { sinceHeight: frozenRaw.since_height as number };
      // Explicit allowlist: nothing else from the node (coordinates, raw id, hardware) is passed through.
      return res.json({
        success: true,
        stationAlias: stationAlias(stationId),
        isOwner,
        owner: show(data.owner_address),
        ownerCommitment: ownerCommit,
        ownerNonce: ledger.owner_nonce,
        frozen,
        ownerDeactivated: ledger.owner_deactivated,
        rewardsSuspended: data.rewards_suspended,
        pendingRecovery,
        governanceActive: data.is_active,
        features: {
          stationOwnerConsent: features.station_owner_consent,
          stationOwnerActions: features.station_owner_actions,
          stationActiveRewardGate: features.station_active_reward_gate,
        },
        observedAtHeight: data.observed_at_height,
        settledHeight: data.settled_height,
      });
    } catch {
      if (!res.headersSent) send(res, problem(503, 'OWNERSHIP_STATE_UNAVAILABLE', 'ownership state is unavailable'));
    }
  });

  return router;
}
