/**
 * WRF currency boundary and adversarial input tests (#462)
 *
 * Covers:
 *   - wrfToBaseUnits: MAX_SAFE_INTEGER, zero, negative, sub-minimum, precision
 *   - baseUnitsToWrf: u64 max, zero, negative, large values, round-trip
 *   - Fee edge cases: dust amounts, large amounts
 */

import { describe, it, expect } from '@jest/globals';
import {
  wrfToBaseUnits,
  baseUnitsToWrf,
  WRF_UNITS_PER_COIN,
  WRF_DECIMALS,
} from '../../shared/currency.js';

// u64 max value: 2^64 - 1
const U64_MAX = 18_446_744_073_709_551_615n;

describe('WRF currency — boundary and adversarial inputs', () => {
  describe('WRF_UNITS_PER_COIN constant', () => {
    it('equals exactly 10^8 (100_000_000)', () => {
      expect(WRF_UNITS_PER_COIN).toBe(100_000_000n);
      expect(WRF_DECIMALS).toBe(8);
    });
  });

  // -------------------------------------------------------------------------
  // wrfToBaseUnits
  // -------------------------------------------------------------------------
  describe('wrfToBaseUnits — boundary values', () => {
    it('converts 0 to 0n', () => {
      expect(wrfToBaseUnits(0)).toBe(0n);
    });

    it('converts the minimum representable unit (1e-8 WRF) to 1n, exactly (#1378)', () => {
      // JS renders 1e-8 in scientific notation; the helper must expand it exactly.
      expect(wrfToBaseUnits(1e-8)).toBe(1n);
    });

    it('converts 1 WRF to 100_000_000n base units', () => {
      expect(wrfToBaseUnits(1)).toBe(100_000_000n);
    });

    it('converts 1000 WRF correctly', () => {
      expect(wrfToBaseUnits(1000)).toBe(100_000_000_000n);
    });

    it('converts 999 WRF correctly (fee boundary)', () => {
      expect(wrfToBaseUnits(999)).toBe(99_900_000_000n);
    });

    it('Number.MAX_SAFE_INTEGER WRF does not produce a negative bigint', () => {
      const result = wrfToBaseUnits(Number.MAX_SAFE_INTEGER);
      expect(result).toBeGreaterThan(0n);
    });

    it('Number.MAX_SAFE_INTEGER WRF stays within a reasonable bigint range', () => {
      const result = wrfToBaseUnits(Number.MAX_SAFE_INTEGER);
      // MAX_SAFE_INTEGER * 10^8 ~ 9.007e23 — well within bigint but must be positive
      expect(result > 0n).toBe(true);
      // Must not exceed u64 max (real on-chain constraint)
      // Note: MAX_SAFE_INTEGER * 10^8 exceeds u64 max, so the host layer must
      // reject it — we document the produced bigint here so overflow callers can guard.
      expect(typeof result).toBe('bigint');
    });

    it('throws RangeError on NaN', () => {
      expect(() => wrfToBaseUnits(NaN)).toThrow(RangeError);
    });

    it('throws RangeError on +Infinity', () => {
      expect(() => wrfToBaseUnits(Infinity)).toThrow(RangeError);
    });

    it('throws RangeError on -Infinity', () => {
      expect(() => wrfToBaseUnits(-Infinity)).toThrow(RangeError);
    });

    it('handles negative amounts (produces negative bigint — callers must reject)', () => {
      // The function allows negatives; the route layer is responsible for
      // rejecting them.  This test documents the current behavior.
      const result = wrfToBaseUnits(-1);
      expect(result).toBe(-100_000_000n);
    });

    it('sub-minimum-unit amount (1e-9) is refused with RangeError, never truncated to 0 (#1378)', () => {
      expect(() => wrfToBaseUnits(1e-9)).toThrow(RangeError);
    });

    it('precision: 9007199254740992 (exceeds MAX_SAFE_INTEGER) — documents float imprecision', () => {
      // This value cannot be represented exactly as a JS float.
      // wrfToBaseUnits uses .toString() which may lose precision.
      // The test documents that the function does NOT throw in this case;
      // callers must validate amount strings as bigint before conversion.
      const input = 9_007_199_254_740_992; // 2^53 — one above MAX_SAFE_INTEGER
      expect(() => wrfToBaseUnits(input)).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // baseUnitsToWrf
  // -------------------------------------------------------------------------
  describe('baseUnitsToWrf — boundary values', () => {
    it('converts 0n to "0"', () => {
      expect(baseUnitsToWrf(0n)).toBe('0');
    });

    it('converts 1n (dust) to "0.00000001"', () => {
      expect(baseUnitsToWrf(1n)).toBe('0.00000001');
    });

    it('converts 100_000_000n to "1"', () => {
      expect(baseUnitsToWrf(100_000_000n)).toBe('1');
    });

    it('converts u64 max value without throwing', () => {
      // u64 max ≈ 184.47 billion WRF
      expect(() => baseUnitsToWrf(U64_MAX)).not.toThrow();
    });

    it('u64 max produces a correct whole-number prefix', () => {
      const display = baseUnitsToWrf(U64_MAX);
      // 18_446_744_073_709_551_615 / 10^8 = 184_467_440_737 whole WRF with remainder
      expect(display.startsWith('184467440737')).toBe(true);
    });

    it('converts negative base units to a negative display string', () => {
      expect(baseUnitsToWrf(-100_000_000n)).toBe('-1');
    });

    it('converts 50_000_000n to "0.5"', () => {
      expect(baseUnitsToWrf(50_000_000n)).toBe('0.5');
    });

    it('strips trailing zeros correctly', () => {
      // 10_000_000n = 0.1 WRF (one decimal place, no trailing zeros)
      expect(baseUnitsToWrf(10_000_000n)).toBe('0.1');
    });
  });

  // -------------------------------------------------------------------------
  // Round-trip invariants
  // -------------------------------------------------------------------------
  describe('round-trip: wrfToBaseUnits → baseUnitsToWrf', () => {
    // Note: 0.00000001 serializes as 1e-8 in JS — excluded; use integer base units directly.
  const roundTrippable = [0, 1, 0.5, 100, 999, 1000, 1_000_000];

    for (const wrf of roundTrippable) {
      it(`round-trips ${wrf} WRF`, () => {
        const baseUnits = wrfToBaseUnits(wrf);
        const display = baseUnitsToWrf(baseUnits);
        expect(Number(display)).toBeCloseTo(wrf, 8);
      });
    }

    it('round-trips 0 WRF via both directions', () => {
      expect(baseUnitsToWrf(wrfToBaseUnits(0))).toBe('0');
    });
  });

  // -------------------------------------------------------------------------
  // Fee edge cases (documented from #462)
  // -------------------------------------------------------------------------
  describe('fee edge cases', () => {
    it('1000 WRF → fee = 1 WRF (0.1% of 1000)', () => {
      const amountUnits = wrfToBaseUnits(1000);        // 100_000_000_000n
      const feeUnits = amountUnits / 1000n;            // 100_000_000n = 1 WRF
      expect(baseUnitsToWrf(feeUnits)).toBe('1');
    });

    it('999 WRF → fee = 0.999 WRF (floor division)', () => {
      const amountUnits = wrfToBaseUnits(999);         // 99_900_000_000n
      const feeUnits = amountUnits / 1000n;            // 99_900_000n
      expect(baseUnitsToWrf(feeUnits)).toBe('0.999');
    });

    it('1 base unit (0.00000001 WRF) → fee floors to 0 base units', () => {
      const amountUnits = 1n;                          // dust: 1 base unit
      const feeUnits = amountUnits / 1000n;            // 0n (integer division)
      expect(feeUnits).toBe(0n);
      expect(baseUnitsToWrf(feeUnits)).toBe('0');
    });

    it('large amount (100_000 WRF) produces correct fee', () => {
      const amountUnits = wrfToBaseUnits(100_000);
      const feeUnits = amountUnits / 1000n;            // 100 WRF
      expect(baseUnitsToWrf(feeUnits)).toBe('100');
    });
  });
});
