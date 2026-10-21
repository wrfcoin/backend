/** Default-OFF backend authorization boundary; not a consensus feature. */
import { createPublicKey, verify } from 'node:crypto';
import { sql, eq, and } from 'drizzle-orm';
import { contributorRewards } from '../../shared/schema.js';

export const PAYOUT_DOMAIN = 'wrfcoin_achievement_payout_authorization_v1';
const UNIT = 100_000_000n;
export const PILOT_CAPS = Object.freeze({
  claim: 10,
  recipientDay: 25,
  recipientLifetime: 100,
  globalDay: 250,
});
export interface PayoutAuthorization {
  chainId: string;
  nonce: string;
  signature: string;
}
export interface AuthorizedTuple {
  achievementId: string;
  claimId: string;
  address: string;
  amountBaseUnits: bigint;
}
export class PayoutAuthorizationError extends Error {
  constructor() {
    super('Achievement payout authorization refused');
  }
}
function refuse(): never {
  throw new PayoutAuthorizationError();
}

export function signedPayoutEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.ACHIEVEMENT_PAYOUT_SIGNED_ENABLED;
  if (flag === undefined || flag === 'false') return false;
  if (flag !== 'true') refuse();
  return true;
}
export function canonicalRecipient(address: string): string {
  if (typeof address !== 'string' || !/^(?:0x)?[a-fA-F0-9]{40}$/.test(address.trim())) refuse();
  return address.trim().replace(/^0x/, '').toLowerCase();
}
/** Canonical UTF-8 JSON array of strings; achievement IDs are bounded ASCII identifiers. */
export function payoutPreimage(
  tuple: AuthorizedTuple,
  auth: Pick<PayoutAuthorization, 'chainId' | 'nonce'>
): Buffer {
  if (
    typeof tuple.achievementId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(tuple.achievementId) ||
    /[^A-Za-z0-9_.-]/.test(tuple.achievementId) ||
    typeof tuple.claimId !== 'string' ||
    !tuple.claimId ||
    Buffer.byteLength(tuple.claimId) > 128 ||
    !/^[1-9][0-9]{0,19}$/.test(auth.chainId) ||
    !/^[0-9a-f]{64}$/.test(auth.nonce) ||
    typeof tuple.amountBaseUnits !== 'bigint' ||
    tuple.amountBaseUnits <= 0n ||
    tuple.amountBaseUnits % UNIT !== 0n ||
    tuple.amountBaseUnits > BigInt(PILOT_CAPS.claim) * UNIT
  )
    refuse();
  return Buffer.from(
    JSON.stringify([
      PAYOUT_DOMAIN,
      auth.chainId,
      tuple.claimId,
      tuple.achievementId,
      canonicalRecipient(tuple.address),
      tuple.amountBaseUnits.toString(),
      auth.nonce,
    ]),
    'utf8'
  );
}
export function verifyPayoutAuthorization(
  tuple: AuthorizedTuple,
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env
): PayoutAuthorization {
  try {
    if (!raw || typeof raw !== 'object') refuse();
    const auth = raw as PayoutAuthorization;
    if (
      typeof auth.signature !== 'string' ||
      !/^[0-9a-f]{128}$/.test(auth.signature) ||
      typeof auth.chainId !== 'string' ||
      auth.chainId !== env.ACHIEVEMENT_PAYOUT_CHAIN_ID ||
      typeof auth.nonce !== 'string' ||
      !/^[0-9a-f]{64}$/.test(env.ACHIEVEMENT_PAYOUT_PUBLIC_KEY || '')
    )
      refuse();
    const key = createPublicKey({
      key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        Buffer.from(env.ACHIEVEMENT_PAYOUT_PUBLIC_KEY!, 'hex'),
      ]),
      format: 'der',
      type: 'spki',
    });
    if (!verify(null, payoutPreimage(tuple, auth), key, Buffer.from(auth.signature, 'hex')))
      refuse();
    return {
      chainId: auth.chainId,
      nonce: auth.nonce,
      signature: auth.signature,
    };
  } catch {
    return refuse();
  }
}

/** Caller must hold global ACHIEVEMENT_MINT_LOCK_KEY in this same transaction. */
export async function authorizeNewPayout(
  tx: { select: (...args: any[]) => any },
  tuple: AuthorizedTuple,
  raw: unknown
): Promise<PayoutAuthorization> {
  const auth = verifyPayoutAuthorization(tuple, raw);
  const used = await tx
    .select({ id: contributorRewards.id })
    .from(contributorRewards)
    .where(
      and(
        eq(contributorRewards.contributorType, 'achievement'),
        sql`${contributorRewards.metadata}->'payoutAuthorization'->>'nonce' = ${auth.nonce}`
      )
    )
    .limit(1);
  if (used.length) refuse();
  const recipient = canonicalRecipient(tuple.address);
  const since = sql`CURRENT_TIMESTAMP - INTERVAL '24 hours'`;
  const address = sql`lower(regexp_replace(trim(${contributorRewards.metadata}->>'address'), '^0x', '', 'i'))`;
  // Every reserved liability counts, including failed/reversed rows. Backend
  // status cannot prove non-execution on-chain; never release headroom here.
  const [totals] = await tx
    .select({
      recipientDay: sql`COALESCE(SUM(CASE WHEN ${address} = ${recipient} AND ${contributorRewards.createdAt} >= ${since} THEN ${contributorRewards.amount} ELSE 0 END), 0)`,
      recipientLifetime: sql`COALESCE(SUM(CASE WHEN ${address} = ${recipient} THEN ${contributorRewards.amount} ELSE 0 END), 0)`,
      globalDay: sql`COALESCE(SUM(CASE WHEN ${contributorRewards.createdAt} >= ${since} THEN ${contributorRewards.amount} ELSE 0 END), 0)`,
      unknownRecipients: sql`COUNT(*) FILTER (WHERE ${address} IS NULL OR ${address} !~ '^[0-9a-f]{40}$')`,
    })
    .from(contributorRewards)
    .where(eq(contributorRewards.contributorType, 'achievement'));
  // No fabricated zero when an aggregate is unavailable; legacy unknown tuples block activation.
  if (!totals || Number(totals.unknownRecipients) !== 0) refuse();
  const amount = Number(tuple.amountBaseUnits / UNIT);
  for (const field of ['recipientDay', 'recipientLifetime', 'globalDay'] as const) {
    const observed = Number(totals[field]);
    if (
      totals[field] === null ||
      totals[field] === undefined ||
      !Number.isSafeInteger(observed) ||
      observed < 0 ||
      observed + amount > PILOT_CAPS[field]
    )
      refuse();
  }
  return auth;
}
