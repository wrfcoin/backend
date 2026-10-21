const MILESTONES = [7, 30, 90, 365] as const;
const MIN_TZ_OFFSET = -12 * 60;
const MAX_TZ_OFFSET = 14 * 60;

type DbExecutor = {
  execute: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

type StreakSummary = {
  currentStreak: number;
  longestStreak: number;
  nextMilestone: number | null;
  milestoneReached: boolean;
};

let sharedDefaultExecutor: DbExecutor | null = null;
const schemaReadyExecutors = new WeakSet<DbExecutor>();
const schemaInitializationByExecutor = new WeakMap<DbExecutor, Promise<void>>();

function defaultDb(): DbExecutor {
  if (sharedDefaultExecutor) {
    return sharedDefaultExecutor;
  }

  const { executeQuery } = require('../../database/db');
  sharedDefaultExecutor = {
    execute: (sql: string, params?: unknown[]) => executeQuery(sql, params),
  };
  return sharedDefaultExecutor;
}

function formatDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  const cloned = new Date(date.getTime());
  cloned.setUTCDate(cloned.getUTCDate() + days);
  return cloned;
}

export function resolveDateKey(nowMs: number, tzOffsetMinutes: number): string {
  const shifted = new Date(nowMs + tzOffsetMinutes * 60_000);
  return formatDateOnly(shifted);
}

export function computeStreaksFromDateKeys(keys: string[], todayKey: string): { currentStreak: number; longestStreak: number } {
  if (!keys.length) {
    return { currentStreak: 0, longestStreak: 0 };
  }

  const unique = Array.from(new Set(keys)).sort();
  const set = new Set(unique);

  let currentStreak = 0;
  let cursor = todayKey;
  while (set.has(cursor)) {
    currentStreak += 1;
    cursor = formatDateOnly(addDays(new Date(`${cursor}T00:00:00.000Z`), -1));
  }

  let longestStreak = 0;
  let run = 0;
  let prev: string | null = null;
  for (const key of unique) {
    if (!prev) {
      run = 1;
    } else {
      const prevPlusOne = formatDateOnly(addDays(new Date(`${prev}T00:00:00.000Z`), 1));
      run = prevPlusOne === key ? run + 1 : 1;
    }
    if (run > longestStreak) {
      longestStreak = run;
    }
    prev = key;
  }

  return { currentStreak, longestStreak };
}

function validateTzOffset(tzOffsetMinutes: number): number {
  if (!Number.isInteger(tzOffsetMinutes)) {
    throw new Error('tzOffsetMinutes must be an integer');
  }
  if (tzOffsetMinutes < MIN_TZ_OFFSET || tzOffsetMinutes > MAX_TZ_OFFSET) {
    throw new Error('tzOffsetMinutes out of range');
  }
  return tzOffsetMinutes;
}

async function ensureSchema(executor: DbExecutor) {
  if (schemaReadyExecutors.has(executor)) {
    return;
  }

  const inFlightInitialization = schemaInitializationByExecutor.get(executor);
  if (inFlightInitialization) {
    await inFlightInitialization;
    return;
  }

  const initializationPromise = (async () => {
    await executor.execute(
      `CREATE TABLE IF NOT EXISTS streak_checkins (
        user_id integer NOT NULL,
        date_key date NOT NULL,
        tz_offset_minutes integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, date_key)
      )`
    );
    await executor.execute(
      `CREATE TABLE IF NOT EXISTS streak_badge_claims (
        user_id integer NOT NULL,
        milestone_days integer NOT NULL,
        claimed_at timestamptz NOT NULL DEFAULT NOW(),
        tx_hash text,
        nft_contract text,
        token_id text,
        PRIMARY KEY (user_id, milestone_days)
      )`
    );
    schemaReadyExecutors.add(executor);
  })();

  schemaInitializationByExecutor.set(executor, initializationPromise);
  try {
    await initializationPromise;
  } finally {
    schemaInitializationByExecutor.delete(executor);
  }
}

export async function initializeStreakSchema(db?: DbExecutor): Promise<void> {
  await ensureSchema(db ?? defaultDb());
}

async function listDateKeys(executor: DbExecutor, userId: number): Promise<string[]> {
  const rows = await executor.execute(
    `SELECT date_key::text AS date_key FROM streak_checkins WHERE user_id = $1 ORDER BY date_key ASC`,
    [userId]
  );
  return rows.rows.map((r) => String(r.date_key));
}

async function listClaimedMilestones(executor: DbExecutor, userId: number): Promise<Set<number>> {
  const rows = await executor.execute(
    `SELECT milestone_days FROM streak_badge_claims WHERE user_id = $1`,
    [userId]
  );
  return new Set(rows.rows.map((r) => Number(r.milestone_days)));
}

function summarize(currentStreak: number, claimed: Set<number>): StreakSummary {
  const nextMilestone = MILESTONES.find((m) => !claimed.has(m)) ?? null;
  return {
    currentStreak,
    longestStreak: 0,
    nextMilestone,
    milestoneReached: nextMilestone !== null && currentStreak >= nextMilestone,
  };
}

function createMintArtifact(userId: number, milestone: number) {
  const seed = `${userId}:${milestone}:${Date.now()}`;
  const hash = Buffer.from(seed).toString('hex').slice(0, 64);
  return {
    artifactId: `0x${hash.padEnd(64, '0')}`,
    tokenId: `${userId}-${milestone}-${Date.now()}`,
    contractAddress: process.env.STREAK_NFT_CONTRACT_ADDRESS || null,
    simulated: true,
  };
}

export async function getStreakSummary(userId: number, tzOffsetMinutes = 0, db?: DbExecutor): Promise<StreakSummary> {
  const executor = db ?? defaultDb();
  validateTzOffset(tzOffsetMinutes);
  await ensureSchema(executor);

  const keys = await listDateKeys(executor, userId);
  const todayKey = resolveDateKey(Date.now(), tzOffsetMinutes);
  const { currentStreak, longestStreak } = computeStreaksFromDateKeys(keys, todayKey);
  const claimed = await listClaimedMilestones(executor, userId);
  const base = summarize(currentStreak, claimed);
  return { ...base, longestStreak };
}

export async function checkInUser(
  userId: number,
  tzOffsetMinutes = 0,
  db?: DbExecutor
): Promise<{
  checkedIn: boolean;
  dateKey: string;
  summary: StreakSummary;
  mintedBadge: {
    milestone: number;
    artifactId: string;
    tokenId: string;
    contractAddress: string | null;
    simulated: true;
  } | null;
}> {
  const executor = db ?? defaultDb();
  validateTzOffset(tzOffsetMinutes);
  await ensureSchema(executor);

  const dateKey = resolveDateKey(Date.now(), tzOffsetMinutes);
  const insert = await executor.execute(
    `INSERT INTO streak_checkins (user_id, date_key, tz_offset_minutes)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, date_key) DO NOTHING
     RETURNING user_id`,
    [userId, dateKey, tzOffsetMinutes]
  );

  const checkedIn = insert.rows.length > 0;
  const keys = await listDateKeys(executor, userId);
  const { currentStreak, longestStreak } = computeStreaksFromDateKeys(keys, dateKey);
  const claimed = await listClaimedMilestones(executor, userId);

  let mintedBadge: {
    milestone: number;
    artifactId: string;
    tokenId: string;
    contractAddress: string | null;
    simulated: true;
  } | null = null;
  for (const milestone of MILESTONES) {
    if (currentStreak >= milestone && !claimed.has(milestone)) {
      const mint = createMintArtifact(userId, milestone);
      await executor.execute(
        `INSERT INTO streak_badge_claims
          (user_id, milestone_days, tx_hash, nft_contract, token_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, milestone_days) DO NOTHING`,
        [userId, milestone, mint.artifactId, mint.contractAddress, mint.tokenId]
      );
      mintedBadge = {
        milestone,
        artifactId: mint.artifactId,
        tokenId: mint.tokenId,
        contractAddress: mint.contractAddress,
        simulated: mint.simulated as true,
      };
      break;
    }
  }

  const refreshedClaimed = await listClaimedMilestones(executor, userId);
  const nextMilestone = MILESTONES.find((m) => !refreshedClaimed.has(m)) ?? null;

  return {
    checkedIn,
    dateKey,
    summary: {
      currentStreak,
      longestStreak,
      nextMilestone,
      milestoneReached: nextMilestone !== null && currentStreak >= nextMilestone,
    },
    mintedBadge,
  };
}

export async function getStreakBadges(userId: number, tzOffsetMinutes = 0, db?: DbExecutor) {
  const executor = db ?? defaultDb();
  const summary = await getStreakSummary(userId, tzOffsetMinutes, executor);
  const claimedRows = await executor.execute(
    `SELECT milestone_days, claimed_at, tx_hash, nft_contract, token_id
     FROM streak_badge_claims
     WHERE user_id = $1
     ORDER BY milestone_days ASC`,
    [userId]
  );

  const claimed = claimedRows.rows.map((row) => ({
    milestoneDays: Number(row.milestone_days),
    claimedAt: row.claimed_at,
    txHash: row.tx_hash,
    nftContract: row.nft_contract,
    tokenId: row.token_id,
  }));
  const claimedSet = new Set(claimed.map((c) => c.milestoneDays));

  const claimable = MILESTONES.filter(
    (milestone) => summary.currentStreak >= milestone && !claimedSet.has(milestone)
  );

  return {
    currentStreak: summary.currentStreak,
    claimed,
    claimable,
    milestones: [...MILESTONES],
  };
}
