import { wrfToBaseUnits, baseUnitsToWrf, WRF_UNITS_PER_COIN } from '../../shared/currency.js';

describe('WRF currency helpers', () => {
  describe('WRF_UNITS_PER_COIN', () => {
    test('equals 10^8', () => {
      expect(WRF_UNITS_PER_COIN).toBe(100_000_000n);
    });
  });

  describe('wrfToBaseUnits', () => {
    test('1.0 WRF → 100_000_000', () => {
      expect(wrfToBaseUnits(1.0)).toBe(100_000_000n);
    });

    test('0.5 WRF → 50_000_000', () => {
      expect(wrfToBaseUnits(0.5)).toBe(50_000_000n);
    });

    test('0.00000001 WRF → 1 (minimum unit)', () => {
      expect(wrfToBaseUnits(0.00000001)).toBe(1n);
    });

    test('123456.789 WRF → 12_345_678_900_000', () => {
      expect(wrfToBaseUnits(123456.789)).toBe(12_345_678_900_000n);
    });

    test('0 WRF → 0', () => {
      expect(wrfToBaseUnits(0)).toBe(0n);
    });

    test('throws on NaN', () => {
      expect(() => wrfToBaseUnits(NaN)).toThrow(RangeError);
    });

    test('throws on Infinity', () => {
      expect(() => wrfToBaseUnits(Infinity)).toThrow(RangeError);
    });

    // backend#1378: JS renders numbers below 1e-6 and at or above 1e21 in
    // scientific notation; the conversion must be exact or refuse, never
    // throw a SyntaxError from BigInt() and never silently truncate.
    describe('exact parsing (#1378)', () => {
      test.each([
        [1e-8, 1n],
        [1e-7, 10n],
        [5e-7, 50n],
        [0.000001, 100n],
        [1.5e-7, 15n],
        [0.1, 10_000_000n],
        [0.3, 30_000_000n],
        [-1e-8, -1n],
      ])('number %p → %p', (input, expected) => {
        expect(wrfToBaseUnits(input as number)).toBe(expected);
      });

      test.each([
        ['1', 100_000_000n],
        ['0.00000001', 1n],
        ['0.5', 50_000_000n],
        ['12345678901234567.12345678', 1_234_567_890_123_456_712_345_678n],
        ['1.500000000', 150_000_000n],
        ['-2.5', -250_000_000n],
        ['0', 0n],
      ])('string %p → %p (exact, never via Number)', (input, expected) => {
        expect(wrfToBaseUnits(input)).toBe(expected);
      });

      test.each([1e21, 1.5e21, 1e300, -1e21])('refuses number %p (>= 1e21) with RangeError', input => {
        expect(() => wrfToBaseUnits(input)).toThrow(RangeError);
      });

      test.each([1e-9, 1.23456789e-7, 0.30000000000000004, 1.000000019])(
        'refuses number %p (more than 8 fractional digits) instead of truncating',
        input => {
          expect(() => wrfToBaseUnits(input)).toThrow(RangeError);
        },
      );

      test.each(['', ' ', '1e-8', '1e21', '0x10', '1,5', '1.', '.5', '+1', '1.123456789', 'abc', '1 ', '1'.repeat(30), '--1'])(
        'refuses string %p with RangeError',
        input => {
          expect(() => wrfToBaseUnits(input)).toThrow(RangeError);
        },
      );

      test('non-number, non-string input is refused', () => {
        expect(() => wrfToBaseUnits(undefined as unknown as number)).toThrow(RangeError);
        expect(() => wrfToBaseUnits(null as unknown as number)).toThrow(RangeError);
        expect(() => wrfToBaseUnits(10n as unknown as number)).toThrow(RangeError);
      });
    });
  });

  describe('baseUnitsToWrf', () => {
    test('100_000_000 → "1"', () => {
      expect(baseUnitsToWrf(100_000_000n)).toBe('1');
    });

    test('50_000_000 → "0.5"', () => {
      expect(baseUnitsToWrf(50_000_000n)).toBe('0.5');
    });

    test('1 → "0.00000001"', () => {
      expect(baseUnitsToWrf(1n)).toBe('0.00000001');
    });

    test('0 → "0"', () => {
      expect(baseUnitsToWrf(0n)).toBe('0');
    });

    test('round-trips: wrfToBaseUnits → baseUnitsToWrf', () => {
      const cases = [1.0, 0.5, 0.05, 100.0, 0.00000001];
      for (const wrf of cases) {
        const units = wrfToBaseUnits(wrf);
        const display = baseUnitsToWrf(units);
        expect(Number(display)).toBeCloseTo(wrf, 8);
      }
    });
  });
});
