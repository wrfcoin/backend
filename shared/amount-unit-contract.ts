import { WRF_DECIMALS, WRF_UNITS_PER_COIN } from './currency.js';

/** Availability describes the whole recent window; per-entry reward evidence still applies. */
export function stationEarningsUnits(available: boolean) {
  return {
    denomination: 'WRF',
    baseUnitDecimals: WRF_DECIMALS,
    baseUnitsPerUnit: WRF_UNITS_PER_COIN.toString(),
    available,
    fields: {
      'earnings[].amountBaseUnits': 'base_units',
      'earnings[].amountWrf': 'display_units',
      'totals.rewardedBaseUnits': 'base_units',
      'totals.rewardedWrf': 'display_units',
    },
  };
}

/**
 * Public leaderboard per-row earnings (S55, owner ruling 2026-10-03): lifetime
 * contribution_rewards.real_paid read from core4 per address. `available` is true
 * only when every row carries a node-proven amount.
 */
export function leaderboardEarningsUnits(available: boolean) {
  return {
    denomination: 'WRF',
    baseUnitDecimals: WRF_DECIMALS,
    baseUnitsPerUnit: WRF_UNITS_PER_COIN.toString(),
    available,
    fields: {
      'entries[].earningsBaseUnits': 'base_units',
      'entries[].earningsWrf': 'display_units',
    },
  };
}

/** Generic token-address ledger aggregates cannot establish a denomination or scale. */
export function treasuryAmountUnits(fields: string[]) {
  return {
    denomination: null,
    baseUnitDecimals: null,
    baseUnitsPerUnit: null,
    available: false,
    reason: 'treasury_units_not_established',
    fields: Object.fromEntries(fields.map(field => [field, 'unknown'])),
  };
}
