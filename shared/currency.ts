/**
 * WRF currency conversion helpers.
 *
 * Matches core4 constant: WRF_UNITS_PER_COIN = 100_000_000 (10^8).
 * All internal calculations should use bigint base units.
 * Convert to/from display strings only at API boundaries.
 */

export const WRF_DECIMALS = 8;
export const WRF_UNITS_PER_COIN = 100_000_000n;

// Largest accepted magnitude (exclusive): 10^21. JS renders numbers at or above this
// in scientific notation, and no real WRF amount is this large.
const MAX_WHOLE_DIGITS = 21;

/** Expand a finite JS number's shortest round-trip form to a plain decimal string. */
function numberToDecimalString(value: number): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(String(value));
  if (!match) throw new RangeError(`Invalid WRF amount: ${value}`);
  const [, sign, whole, frac = '', exp = '0'] = match;
  const shift = Number(exp);
  const digits = whole + frac;
  const point = whole.length + shift; // position of the decimal point within digits
  let out: string;
  if (point <= 0) out = `0.${'0'.repeat(-point)}${digits}`;
  else if (point >= digits.length) out = digits + '0'.repeat(point - digits.length);
  else out = `${digits.slice(0, point)}.${digits.slice(point)}`;
  return sign + out;
}

/**
 * Convert a WRF display amount to integer base units, exactly.
 *
 * - A string is parsed as a plain decimal (`-?digits[.digits]`); it never goes via Number.
 * - A number is expanded from its shortest round-trip form, so 1e-8 is 1 base unit
 *   (JS prints it in scientific notation; this is handled, not thrown as SyntaxError).
 * - Refuses with RangeError, never truncates or rounds: non-finite or non-numeric
 *   input, magnitudes of 10^21 or more, and more than 8 fractional digits
 *   (trailing zeros beyond the 8th are harmless and ignored).
 * Negatives are allowed and returned negative; callers must reject them where needed.
 */
export function wrfToBaseUnits(displayAmount: number | string): bigint {
  let text: string;
  if (typeof displayAmount === 'number') {
    if (!Number.isFinite(displayAmount)) {
      throw new RangeError(`Invalid WRF amount: ${displayAmount}`);
    }
    text = numberToDecimalString(displayAmount);
  } else if (typeof displayAmount === 'string') {
    text = displayAmount;
  } else {
    throw new RangeError('Invalid WRF amount: expected a number or a decimal string');
  }
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new RangeError('Invalid WRF amount: not a plain decimal');
  const [, sign, wholeRaw, fracRaw = ''] = match;
  const whole = wholeRaw.replace(/^0+(?=\d)/, '');
  const frac = fracRaw.replace(/0+$/, '');
  if (whole.length > MAX_WHOLE_DIGITS) {
    throw new RangeError('Invalid WRF amount: magnitude too large');
  }
  if (frac.length > WRF_DECIMALS) {
    throw new RangeError(`Invalid WRF amount: more than ${WRF_DECIMALS} decimal places`);
  }
  const units = BigInt(whole) * WRF_UNITS_PER_COIN + BigInt(frac.padEnd(WRF_DECIMALS, '0'));
  return sign === '-' && units !== 0n ? -units : units;
}

/**
 * Convert integer base units to a WRF display string (trailing zeros stripped).
 * e.g. 100_000_000n → "1", 50_000_000n → "0.5", 1n → "0.00000001"
 */
export function baseUnitsToWrf(baseUnits: bigint): string {
  const negative = baseUnits < 0n;
  const abs = negative ? -baseUnits : baseUnits;
  const whole = abs / WRF_UNITS_PER_COIN;
  const frac = (abs % WRF_UNITS_PER_COIN).toString().padStart(WRF_DECIMALS, '0');
  const result = `${whole}.${frac}`.replace(/\.?0+$/, '');
  return negative ? `-${result}` : result;
}
