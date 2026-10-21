/**
 * core4 gamification-payout client (#215 on-chain rewire).
 *
 * Wraps `POST /rewards/payout` on the core4 launch API (port 8556, Operator role).
 * The endpoint mints an on-chain WRF payout for a claimed achievement reward and
 * is the SINGLE dedup source of truth via `claim_id` — re-POSTing the same
 * `claim_id` is always safe (consensus-level idempotency), which is what makes
 * the async pending→settled reconciliation robust.
 *
 * Contract (core4 PR #2081):
 *   Request:  { address, amount_base_units, claim_id }
 *   Success (LawBook envelope { ok, data, error, meta }):
 *     202 data.status = "accepted"          — new payout tx enqueued (tx_hash)
 *     202 data.status = "pending"           — same claim_id already pending (tx_hash)
 *     200 data.status = "already_processed"  — applied on-chain; nothing minted
 *   Errors (error.code): 401 UNAUTHORIZED · 403 FORBIDDEN · 400 BAD_REQUEST ·
 *     422 UNPROCESSABLE_ENTITY · 422 AMOUNT_TOO_LARGE ·
 *     422 AMOUNT_EXCEEDS_BLOCK_EMISSION · 422 OVER_SUPPLY · 503 PARTITION_READ_ONLY
 */

import {
  fetchCore4Json,
  extractCore4Data,
  getCore4ErrorMessage,
} from '../../shared/core4-route-client.js';

import { signedPayoutEnabled, verifyPayoutAuthorization } from './achievement-payout-authorization.js';

/** 1 WRF = 10^8 base units (mirrors shared/currency.ts + core4). */
export const WRF_UNITS_PER_COIN = 100_000_000n;
/** Per-payout ceiling: MAX_BLOCK_EMISSION = 200 WRF (20_000_000_000 base units). */
export const MAX_BLOCK_EMISSION_BASE_UNITS = 20_000_000_000n;
/** claim_id contract bound. */
export const MAX_CLAIM_ID_BYTES = 128;

export interface PayoutRequestArgs {
  address: string;
  amountBaseUnits: bigint;
  claimId: string;
  achievementId?: string;
  authorization?: unknown;
}

export type PayoutStatus = 'accepted' | 'pending' | 'already_processed';

export interface PayoutSuccess {
  kind: 'success';
  status: PayoutStatus;
  claimId: string;
  address: string;
  amountBaseUnits: bigint;
  /** Present for accepted/pending; absent for already_processed. */
  txHash: string | null;
  requestId?: string | null;
}

/**
 * Transient/deferred failures where the claim_id was NOT consumed and the caller
 * should retry later WITHOUT losing the claim (surface a "reward pending" state).
 */
export interface PayoutRetryable {
  kind: 'retryable';
  reason: 'over_supply' | 'partition_read_only' | 'network';
  code: string;
  message: string;
  httpStatus: number | null;
}

/** Hard, non-retryable failures (bad input / auth). */
export interface PayoutError {
  kind: 'error';
  code: string;
  message: string;
  httpStatus: number | null;
  /**
   * TRUE only for deterministic input-validation failures raised BEFORE the
   * network call — the arguments themselves are invalid, so re-submitting the
   * identical claim can never succeed. Settlement must go TERMINAL rather than
   * back to `pending` (#890 HIGH-2).
   *
   * Deliberately NOT set for `UNAUTHORIZED`: a missing operator token is
   * environmental, and the same claim succeeds once it is configured. Also not
   * set for hard errors returned BY core4, which can reflect transient
   * server-side state or version skew rather than a permanently bad claim.
   * Both stay retryable and are bounded by the attempt counter instead.
   */
  validation?: boolean;
}

export type PayoutResult = PayoutSuccess | PayoutRetryable | PayoutError;

/** Injectable seam for tests (default = real core4 client + env token). */
export interface PayoutClientDeps {
  fetchJson: typeof fetchCore4Json;
  getOperatorToken: () => string | undefined;
}

const defaultDeps: PayoutClientDeps = {
  fetchJson: fetchCore4Json,
  getOperatorToken: () => process.env.WRFCOIN_OPERATOR_TOKEN,
};

/** Ethereum-style 20-byte hex address, with or without 0x. */
export function isValidPayoutAddress(address: unknown): address is string {
  return typeof address === 'string' && /^(0x)?[0-9a-fA-F]{40}$/.test(address.trim());
}

/**
 * Serialize a u128 base-unit amount for JSON. Numbers are exact below 2^53; a
 * valid payout is capped at MAX_BLOCK_EMISSION (< 2^53) so a Number is safe, but
 * fall back to a decimal string for anything larger to avoid precision loss.
 */
export function serializeBaseUnits(amount: bigint): number | string {
  return amount <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(amount) : amount.toString();
}

export interface AmountValidation {
  ok: boolean;
  code: string;
  message: string;
}

/** Validate the amount against the contract's bounds before hitting the network. */
export function validatePayoutAmount(amountBaseUnits: bigint): AmountValidation {
  if (amountBaseUnits <= 0n) {
    return { ok: false, code: 'UNPROCESSABLE_ENTITY', message: 'amount must be > 0' };
  }
  if (amountBaseUnits > MAX_BLOCK_EMISSION_BASE_UNITS) {
    return {
      ok: false,
      code: 'AMOUNT_EXCEEDS_BLOCK_EMISSION',
      message: `amount ${amountBaseUnits} exceeds per-payout cap ${MAX_BLOCK_EMISSION_BASE_UNITS}`,
    };
  }
  return { ok: true, code: '', message: '' };
}

function normalizeStatus(raw: unknown): PayoutStatus | null {
  if (raw === 'accepted' || raw === 'pending' || raw === 'already_processed') {
    return raw;
  }
  return null;
}

/**
 * Submit (or idempotently re-submit) a payout. Never throws for an HTTP/parse
 * failure — network errors map to a `retryable` result so the caller keeps the
 * claim and retries. Only genuine programming misuse would throw.
 */
export async function submitPayout(
  args: PayoutRequestArgs,
  deps: Partial<PayoutClientDeps> = {}
): Promise<PayoutResult> {
  const { fetchJson, getOperatorToken } = { ...defaultDeps, ...deps };

  // The three checks below run BEFORE any network call and depend only on the
  // arguments. They are marked `validation: true` so settlement can take them
  // straight to terminal instead of re-sweeping an unfixable claim forever.
  if (!isValidPayoutAddress(args.address)) {
    return {
      kind: 'error',
      code: 'BAD_REQUEST',
      message: 'invalid payout address',
      httpStatus: 400,
      validation: true,
    };
  }
  if (!args.claimId || Buffer.byteLength(args.claimId, 'utf8') > MAX_CLAIM_ID_BYTES) {
    return {
      kind: 'error',
      code: 'UNPROCESSABLE_ENTITY',
      message: 'claim_id must be non-empty and <= 128 bytes',
      httpStatus: 422,
      validation: true,
    };
  }
  const amountCheck = validatePayoutAmount(args.amountBaseUnits);
  if (!amountCheck.ok) {
    return {
      kind: 'error',
      code: amountCheck.code,
      message: amountCheck.message,
      httpStatus: 422,
      validation: true,
    };
  }

  try {
    if (signedPayoutEnabled()) {
      verifyPayoutAuthorization({
        achievementId: args.achievementId || '', claimId: args.claimId,
        address: args.address, amountBaseUnits: args.amountBaseUnits,
      }, args.authorization);
    }
  } catch {
    return {
      kind: 'error', code: 'PAYOUT_AUTHORIZATION_REQUIRED',
      message: 'Achievement payout authorization refused', httpStatus: 403, validation: true,
    };
  }

  const token = getOperatorToken();
  if (!token) {
    return {
      kind: 'error',
      code: 'UNAUTHORIZED',
      message: 'WRFCOIN_OPERATOR_TOKEN is not configured',
      httpStatus: 401,
    };
  }

  let response;
  try {
    response = await fetchJson('/rewards/payout', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: {
        address: args.address,
        amount_base_units: serializeBaseUnits(args.amountBaseUnits),
        claim_id: args.claimId,
      },
    });
  } catch (error) {
    return {
      kind: 'retryable',
      reason: 'network',
      code: 'NETWORK',
      message: error instanceof Error ? error.message : String(error),
      httpStatus: null,
    };
  }

  const data = (extractCore4Data(response.payload) || {}) as Record<string, unknown>;
  const requestId =
    typeof (response.payload as { meta?: { request_id?: unknown } })?.meta?.request_id === 'string'
      ? ((response.payload as { meta: { request_id: string } }).meta.request_id)
      : null;

  if (response.ok) {
    const status = normalizeStatus(data.status);
    if (status) {
      return {
        kind: 'success',
        status,
        claimId: args.claimId,
        address: args.address,
        amountBaseUnits: args.amountBaseUnits,
        txHash: typeof data.tx_hash === 'string' ? data.tx_hash : null,
        requestId,
      };
    }
    // 2xx but unrecognized status — treat as retryable rather than silently "paid".
    return {
      kind: 'retryable',
      reason: 'network',
      code: 'UNKNOWN_STATUS',
      message: `core4 payout returned unrecognized status: ${JSON.stringify(data.status)}`,
      httpStatus: response.status,
    };
  }

  // Error envelope: pull the code from error.code (LawBook), else infer from HTTP.
  const errObj =
    response.payload && typeof response.payload === 'object'
      ? ((response.payload as { error?: unknown }).error as Record<string, unknown> | undefined)
      : undefined;
  const code =
    (errObj && typeof errObj.code === 'string' && errObj.code) ||
    inferCodeFromStatus(response.status);
  const message = getCore4ErrorMessage(response.payload, `core4 payout failed (${response.status})`);

  if (code === 'OVER_SUPPLY') {
    return { kind: 'retryable', reason: 'over_supply', code, message, httpStatus: response.status };
  }
  if (code === 'PARTITION_READ_ONLY' || response.status === 503) {
    return {
      kind: 'retryable',
      reason: 'partition_read_only',
      code: code || 'PARTITION_READ_ONLY',
      message,
      httpStatus: response.status,
    };
  }
  return { kind: 'error', code, message, httpStatus: response.status };
}

function inferCodeFromStatus(status: number): string {
  switch (status) {
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 400:
      return 'BAD_REQUEST';
    case 422:
      return 'UNPROCESSABLE_ENTITY';
    case 503:
      return 'PARTITION_READ_ONLY';
    default:
      return 'CORE4_ERROR';
  }
}
