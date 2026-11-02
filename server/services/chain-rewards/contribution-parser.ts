/**
 * Who had a real weather contribution settle in a block, read from the same `/chain/block/{h}` envelope
 * as the reward index. A settlement in `attester_settlements` names only a decision id; the address
 * comes from the `reward_entries` record `contribution:<id>` in that block. Pending decisions repeat in
 * `reward_entries` every block, so an entry with no settlement here is not evidence of anything.
 *
 * TOLERANT like forecast-parser.ts: an uninterpretable record yields no payee and never fails the pass,
 * so a streak can come out short but producer/attester receipt indexing cannot halt. Amounts are not
 * kept: metadata amounts are nominal, and paid totals come from the node.
 */
import { losslessJson } from './parser.js';
import { baseUnits, forecasterAddress } from './forecast-parser.js';

export interface ContributionBlock {
  /** Distinct `0x` + 40 lowercase hex addresses, sorted. */
  payees: string[];
}

export function parseContributionBlock(raw: string, expectedHeight: number): ContributionBlock {
  const payees = new Set<string>();
  try {
    const b = losslessJson(raw)?.data;
    if (b?.height !== BigInt(expectedHeight)) return { payees: [] };
    const { attester_settlements: settlements, reward_entries: entries } = b.metadata ?? {};
    if (typeof settlements !== 'string' || typeof entries !== 'string') return { payees: [] };
    const settled = losslessJson(settlements);
    const records = losslessJson(entries);
    if (!Array.isArray(settled) || !Array.isArray(records)) return { payees: [] };
    const decisions = new Set(settled.map((s: any) => s?.decision_id));
    for (const r of records) {
      if (typeof r?.reason !== 'string' || !r.reason.startsWith('contribution:')) continue;
      if (!decisions.has(r.reason.slice('contribution:'.length)) || r.provenance_class !== 'real') continue;
      const amount = baseUnits(r.amount);
      const address = forecasterAddress(r.address);
      if (address && amount !== null && BigInt(amount) > 0n) payees.add(address);
    }
  } catch { return { payees: [] }; }
  return { payees: [...payees].sort() };
}
