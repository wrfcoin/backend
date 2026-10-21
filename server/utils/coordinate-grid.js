/**
 * The storage grid for station and device positions (owner ruling 2026-10-01,
 * frontend#437; W21 after backend#1401): no writer persists a position finer
 * than 0.1 degree, matching mobile collect, self-service registration and the
 * anonymous projections (anonymous-projection.js). Callers validate the raw
 * range first, then store, hash or evaluate only the gridded value.
 */

const STORAGE_COORDINATE_DECIMALS = 1;

/**
 * A finite number at 0.1 degree; -0 becomes 0, so a value just below zero is
 * never stored as "-0". Same formula as toRegistrationGrid (backend#1401).
 */
function toStorageGrid(value) {
  const factor = 10 ** STORAGE_COORDINATE_DECIMALS;
  return Math.round(value * factor) / factor + 0;
}

/** A registered mobile cell centre (integer tenths of a degree) in degrees. */
function cellCentreDegrees(tenths) {
  return Number(tenths) / 10 + 0;
}

module.exports = {
  STORAGE_COORDINATE_DECIMALS,
  toStorageGrid,
  cellCentreDegrees,
};
