/**
 * One pace for every backend job that reads the node.
 *
 * The node's read limiter counts the backend as one client, so two jobs that each keep to
 * "20 reads a minute" add up to 40. Jobs that read the node in the background reserve their reads
 * on ONE clock here instead: each reservation takes the next free slot and pushes the clock on by
 * the caller's gap (60 s / its reads-per-minute), so the total across jobs stays at or under the
 * ceiling as long as every job uses the same ceiling.
 *
 * The ceiling is NODE_JOB_READS_PER_MIN (default 20, 1 to 60). A job may be given a lower rate of
 * its own, never a way to exceed the shared clock.
 *
 * Only the timing is shared. What to do after a 429 (stop, stay away, for how long) stays with
 * each job.
 */
export interface NodeReadClock {
  /** Epoch ms of the next free read slot. */
  nextReadAt: number;
}

export const DEFAULT_NODE_JOB_READS_PER_MIN = 20;

/** The process-wide clock. Tests pass their own. */
export const processNodeReadClock: NodeReadClock = { nextReadAt: 0 };

export function nodeJobReadsPerMinute(raw: string | undefined = process.env.NODE_JOB_READS_PER_MIN): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 60 ? n : DEFAULT_NODE_JOB_READS_PER_MIN;
}

export const gapMsFor = (readsPerMin: number) => Math.ceil(60_000 / readsPerMin);

/**
 * Reserve `reads` consecutive read slots and wait for the first. The reservation is made before
 * the wait, so two jobs calling at the same moment get different slots.
 */
export async function reserveNodeReads(
  clock: NodeReadClock,
  reads: number,
  readsPerMin: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const start = Math.max(now(), clock.nextReadAt);
  clock.nextReadAt = start + Math.max(1, reads) * gapMsFor(readsPerMin);
  const wait = start - now();
  if (wait > 0) await sleep(wait);
}
