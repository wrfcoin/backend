/**
 * Public chain explorer summary (mobile explorer epic, story B1).
 *
 * GET /api/explorer/summary is ONE cached, single-flight read for every phone:
 * at most one upstream fan-out per TTL (minimum 10 s) no matter how many callers.
 * It exposes aggregate chain health only: height, tip age, blocks/min over at most
 * the 30 most recent blocks, producing/stalled, peer count and whether the public
 * faucet account holds funds. No addresses, no operator detail, no locations.
 * Oracle quorum is deliberately omitted: /api/oracle/status requires authentication,
 * so it is not publicly exposed.
 *
 * An upstream failure yields a 200 with `state: 'degraded'` (never a 500); the
 * degraded result is cached for the same TTL so a broken node is not hammered.
 */

const express = require('express');
const router = express.Router();
const { logger } = require('../utils/logger');
const { core4PublicReadHeaders } = require('../utils/core4-reader-credential');

// Same threshold as infra/scripts/node-dashboard.py CHAIN_STALL_SECONDS: blocks arrive on a
// ~60 s collector cadence and the dashboard flags STALLED once the tip is older than 180 s.
const CHAIN_STALL_SECONDS = 180;
const RECENT_BLOCK_WINDOW = 30;
const MIN_TTL_MS = 10_000;

function ttlMs() {
  const configured = Number.parseInt(process.env.EXPLORER_SUMMARY_TTL_MS ?? '', 10);
  return Number.isFinite(configured) ? Math.max(configured, MIN_TTL_MS) : MIN_TTL_MS;
}

let core4ClientPromise = null;
function getCore4Client() {
  if (!core4ClientPromise) core4ClientPromise = import('../../shared/core4-route-client.js');
  return core4ClientPromise;
}

/** Block timestamp (ISO string, unix seconds or unix ms) to epoch milliseconds, or null. */
function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string' && value.trim()) {
    if (/^\d+$/.test(value.trim())) return toEpochMs(Number(value.trim()));
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * A non-negative safe integer from a JSON number or a plain decimal-digit string, else null.
 * Number(null) is 0 and Number('0x1f') is 31, so nothing is coerced: null, blank, boolean,
 * hex-looking, fractional and out-of-range values are all unknown. Zero stays a valid count.
 */
function asCount(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value === 'string' && /^[0-9]{1,15}$/.test(value)) return Number(value);
  return null;
}

/** Blocks per minute over the recent blocks (oldest to newest), or null with fewer than 2 usable blocks. */
function blocksPerMinute(blocks) {
  const stamps = blocks
    .map((b) => ({ height: asCount(b?.height), ms: toEpochMs(b?.timestamp) }))
    .filter((b) => b.height !== null && b.ms !== null)
    .sort((a, b) => a.height - b.height)
    .slice(-RECENT_BLOCK_WINDOW);
  if (stamps.length < 2) return null;
  const spanSeconds = (stamps[stamps.length - 1].ms - stamps[0].ms) / 1000;
  if (spanSeconds <= 0) return null;
  return Math.round(((stamps.length - 1) / spanSeconds) * 60 * 100) / 100;
}

async function faucetFunded(client, headers) {
  // The faucet account is public by design; it is only READ here and never returned.
  const address = process.env.EXPLORER_FAUCET_ADDRESS?.trim();
  if (!address) return null; // unknown, not "no"
  const response = await client.fetchCore4Json(`/addresses/${encodeURIComponent(address)}`, { headers });
  if (response.status === 404) return false;
  if (!response.ok) return null;
  const data = client.extractCore4Data(response.payload) || {};
  try {
    const raw = data.spendable_balance ?? data.balance;
    return raw === undefined || raw === null ? null : BigInt(String(raw).split('.')[0]) > 0n;
  } catch {
    return null;
  }
}

/** Carries only the upstream HTTP status, never upstream text. */
class ExplorerUpstreamError extends Error {
  constructor(status) {
    super('explorer upstream not ok');
    this.upstreamStatus = Number.isInteger(status) ? status : null;
  }
}

async function buildSummary(now = Date.now()) {
  const client = await getCore4Client();
  const headers = core4PublicReadHeaders({});
  const [blocksRes, networkRes, funded] = await Promise.all([
    client.fetchCore4Json('/chain/blocks', { query: { limit: RECENT_BLOCK_WINDOW }, headers }),
    client.fetchCore4Json('/network/info', { headers }),
    faucetFunded(client, headers).catch(() => null),
  ]);
  if (!blocksRes.ok) throw new ExplorerUpstreamError(blocksRes.status);

  const payload = client.extractCore4Data(blocksRes.payload) || {};
  const blocks = Array.isArray(payload.blocks) ? payload.blocks : [];
  const stamped = blocks
    .map((b) => ({ height: asCount(b?.height), ms: toEpochMs(b?.timestamp) }))
    .filter((b) => b.height !== null);
  const tip = stamped.sort((a, b) => b.height - a.height)[0];
  const height = asCount(payload.chain_height) ?? (tip ? tip.height : null);
  const tipAgeSeconds = tip && tip.ms !== null ? Math.max(0, Math.round((now - tip.ms) / 1000)) : null;
  const network = networkRes.ok ? client.extractCore4Data(networkRes.payload) || {} : {};

  return {
    state: 'ok',
    status: tipAgeSeconds === null ? 'unknown' : tipAgeSeconds > CHAIN_STALL_SECONDS ? 'stalled' : 'producing',
    height,
    tipAgeSeconds,
    blocksPerMinute: blocksPerMinute(blocks),
    blocksSampled: Math.min(blocks.length, RECENT_BLOCK_WINDOW),
    stallThresholdSeconds: CHAIN_STALL_SECONDS,
    peerCount: networkRes.ok ? asCount(network.peer_count) : null,
    faucetFunded: funded,
    generatedAt: new Date(now).toISOString(),
  };
}

function degraded(now = Date.now()) {
  return {
    state: 'degraded',
    status: 'unknown',
    height: null,
    tipAgeSeconds: null,
    blocksPerMinute: null,
    blocksSampled: 0,
    stallThresholdSeconds: CHAIN_STALL_SECONDS,
    peerCount: null,
    faucetFunded: null,
    generatedAt: new Date(now).toISOString(),
  };
}

let cached = null; // { value, expiresAt }
let inflight = null;

async function getSummary() {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;
  if (inflight) return inflight; // single flight: concurrent callers share one fan-out
  inflight = (async () => {
    let value;
    try {
      value = await buildSummary();
    } catch (error) {
      // Stable code and status only: upstream exception text can carry coordinates or
      // operator markers, so it is never logged.
      logger.warn('Explorer summary upstream failure', {
        code: error instanceof ExplorerUpstreamError ? 'EXPLORER_UPSTREAM_STATUS' : 'EXPLORER_UPSTREAM_ERROR',
        upstreamStatus: error instanceof ExplorerUpstreamError ? error.upstreamStatus : null,
      });
      value = degraded();
    }
    cached = { value, expiresAt: Date.now() + ttlMs() };
    return value;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

router.get('/summary', async (_req, res) => {
  const value = await getSummary();
  res.set?.('Cache-Control', `public, max-age=${Math.floor(ttlMs() / 1000)}`);
  res.json(value);
});

function resetExplorerSummaryCacheForTests() {
  cached = null;
  inflight = null;
}

module.exports = router;
module.exports.resetExplorerSummaryCacheForTests = resetExplorerSummaryCacheForTests;
module.exports.CHAIN_STALL_SECONDS = CHAIN_STALL_SECONDS;
