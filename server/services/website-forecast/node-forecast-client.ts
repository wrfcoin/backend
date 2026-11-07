/**
 * The ONE place the website forecast relay talks to the node (website forecast design 2026-11-05, §3).
 *
 * NODE DEPENDENCY: core4 #127 (aa415d31b, merged) "forecast routes accept a key-bound relayed submission"; it
 * reaches the live nodes with the next node release. Before that, the node takes
 * POST /transactions/forecast/commit and /reveal only from a Contributor bearer whose wallet claim equals
 * the forecaster (or an Operator bearer). The relay holds one shared Contributor token, so on today's node
 * every relayed forecast is refused (401/403). The core4 change accepts a commit on any Contributor bearer
 * when `forecaster == Address::from_public_key(auth_pubkey)` and the commit id re-derives, and a reveal only
 * when it carries the commit's own auth_pubkey/auth_signature pair. The bodies below are core4's
 * `ForecastCommitRequest` / `ForecastRevealRequest` after #127; if they change, change them here only.
 * Refusals: 403 FORECASTER_BEARER_UNBOUND / FORECASTER_NOT_BOUND_TO_BEARER (key is not the forecaster),
 * 422 INVALID_FORECAST_AUTHORIZATION (bad or missing signature), 422 reveal payload / commit_hash mismatch.
 *
 * Bearers: commit and reveal use the backend Contributor credential (WRFCOIN_CONTRIBUTOR_TOKEN), status
 * reads the Reader credential (WRFCOIN_READER_TOKEN). No caller header is forwarded. Nothing here logs.
 */
import type { Core4Get, Core4Response } from '../forecast-commit-record.js';

export interface ForecastManifest {
  schema_version: 1;
  model_id: string;
  input_hash: string;
  output_hash: string;
  produced_at: number;
  region: string;
  horizon_hours: number;
  input_variables: string[];
  output_variables: string[];
}

export interface NodeCommitRequest {
  forecaster: string;
  station_id: string;
  commit_hash: string;
  auth_pubkey: string;
  auth_signature: string;
}

export interface NodeRevealRequest {
  forecaster: string;
  station_id: string;
  /** The forecast data object; the node re-serializes it (serde_json) and must reproduce commit_hash. */
  payload: Record<string, unknown>;
  nonce: string;
  commit_hash: string;
  timestamp: number;
  manifest: ForecastManifest;
  /** The commit's own authorization pair (core4 #127: a relayed reveal must carry it). */
  auth_pubkey: string;
  auth_signature: string;
}

export type NodeSubmitResult =
  | { kind: 'accepted'; txHash: string | null }
  /** The node refused the forecast on its merits (4xx other than auth/rate limit). Not retried. */
  | { kind: 'refused'; status: number; code: string | null; message: string | null }
  /** Auth, rate limit, 5xx or network: may be retried. */
  | { kind: 'unavailable'; status: number | null };

export type Core4Post = (path: string, body: unknown) => Promise<Core4Response>;

export const NODE_COMMIT_PATH = '/transactions/forecast/commit';
export const NODE_REVEAL_PATH = '/transactions/forecast/reveal';
export const nodeCommitStatusPath = (commitId: string) => `/transactions/commit/${commitId}/status`;

const CALL_TIMEOUT_MS = 8_000;

function unwrap(payload: any): Record<string, any> | null {
  const data = payload && typeof payload === 'object' && payload.ok === true && 'data' in payload ? payload.data : payload;
  return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
}

const TX_HASH_RE = /^(0x)?[0-9a-fA-F]{16,128}$/;
const CODE_RE = /^[A-Z0-9_]{1,64}$/;
/** core4 #127 refusals: the signing key does not match the forecaster. */
const FORECASTER_BINDING_CODES = new Set(['FORECASTER_BEARER_UNBOUND', 'FORECASTER_NOT_BOUND_TO_BEARER']);

/** Map a node reply to accepted / refused / unavailable. Exported for tests. */
export function classifyNodeReply(reply: Core4Response): NodeSubmitResult {
  if (reply.ok) {
    const data = unwrap(reply.payload) ?? {};
    const hash = [data.tx_id, data.tx_hash, data.hash, data.transaction_hash].find((v) => typeof v === 'string' && TX_HASH_RE.test(v));
    return { kind: 'accepted', txHash: (hash as string | undefined) ?? null };
  }
  const body = reply.payload && typeof reply.payload === 'object' ? reply.payload : {};
  const err = (body as any).error && typeof (body as any).error === 'object' ? (body as any).error : body;
  const code = typeof err.code === 'string' && CODE_RE.test(err.code) ? err.code : null;
  // A 403 naming the forecaster binding is a refusal of this forecast (key is not the forecaster), not an outage.
  const bindingRefusal = reply.status === 403 && code !== null && FORECASTER_BINDING_CODES.has(code);
  const retryable = !bindingRefusal && ([401, 403, 408, 429].includes(reply.status) || reply.status >= 500);
  if (retryable) return { kind: 'unavailable', status: reply.status };
  // Node refusal text is ours (envelope_error literals) but is capped and reduced to printable ASCII.
  const message = typeof err.message === 'string' ? err.message.replace(/[^\x20-\x7e]/g, ' ').slice(0, 200) : null;
  return { kind: 'refused', status: reply.status, code, message };
}

export interface NodeForecastClient {
  submitCommit(request: NodeCommitRequest): Promise<NodeSubmitResult>;
  submitReveal(request: NodeRevealRequest): Promise<NodeSubmitResult>;
  /** Bare commit status record, `null` when the node does not know the commit (404), throws when unreadable. */
  readStatus(commitId: string): Promise<Record<string, any> | null>;
}

export function createNodeForecastClient(deps: { post: Core4Post; get: Core4Get }): NodeForecastClient {
  const submit = async (path: string, body: unknown): Promise<NodeSubmitResult> => {
    let reply: Core4Response;
    try { reply = await deps.post(path, body); } catch { return { kind: 'unavailable', status: null }; }
    return classifyNodeReply(reply);
  };
  return {
    submitCommit: (r) => submit(NODE_COMMIT_PATH, {
      forecaster: r.forecaster, station_id: r.station_id, commit_hash: r.commit_hash,
      auth_pubkey: r.auth_pubkey, auth_signature: r.auth_signature,
    }),
    submitReveal: (r) => submit(NODE_REVEAL_PATH, {
      forecaster: r.forecaster, station_id: r.station_id, payload: r.payload, nonce: r.nonce,
      commit_hash: r.commit_hash, timestamp: r.timestamp, manifest: r.manifest,
      auth_pubkey: r.auth_pubkey, auth_signature: r.auth_signature,
    }),
    readStatus: async (commitId) => {
      const reply = await deps.get(nodeCommitStatusPath(commitId));
      if (reply.status === 404) return null;
      const status = reply.ok ? unwrap(reply.payload) : null;
      if (!status || status.commit_id !== commitId) throw new Error('commit status unreadable');
      return status;
    },
  };
}

/** Production client: Contributor bearer for submissions, Reader bearer for status reads. */
export async function defaultNodeForecastClient(): Promise<NodeForecastClient> {
  const { fetchCore4Json } = await import('../../../shared/core4-route-client.js');
  const bearer = (name: 'WRFCOIN_CONTRIBUTOR_TOKEN' | 'WRFCOIN_READER_TOKEN') => {
    const token = process.env[name]?.trim();
    if (!token) throw new Error('node credential unset');
    return { authorization: `Bearer ${token}`, accept: 'application/json' };
  };
  return createNodeForecastClient({
    post: (path, body) => fetchCore4Json(path, { method: 'POST', headers: bearer('WRFCOIN_CONTRIBUTOR_TOKEN'), body, timeoutMs: CALL_TIMEOUT_MS }) as Promise<Core4Response>,
    get: (path) => fetchCore4Json(path, { headers: bearer('WRFCOIN_READER_TOKEN'), timeoutMs: CALL_TIMEOUT_MS }) as Promise<Core4Response>,
  });
}
