/**
 * backend#1241: the iotex controller stored a sha256 prefix as the device
 * "geohash". It now returns a real geohash from the geo-fence encoder. The pairs
 * below are the standard published geohash examples plus synthetic points.
 */
import { describe, expect, it, jest } from '@jest/globals';

jest.mock('../server/integrations/iotex/w3bstream-adapter', () => ({}), { virtual: false });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const controller = require('../server/integrations/iotex/controller');
const { encodeGeoFenceGrid } = require('../shared/iot-gateway-geofence-service');

describe('iotex calculateGeohash returns a real geohash (backend#1241)', () => {
  it.each([
    [57.64911, 10.40744, 11, 'u4pruydqqvj'], // published example (Jutland)
    [42.605, -5.603, 5, 'ezs42'], // published example (Leon)
    [0.0, 0.0, 6, 's00000'],
    [10.0, 20.0, 5, 's3y0z'], // synthetic point; vector computed with an independent Python encoder
  ])('(%d, %d) at precision %d → %s', async (lat, lon, precision, expected) => {
    expect(await controller.calculateGeohash(lat, lon, precision)).toBe(expected);
  });

  it('default precision is 9 characters of the geohash alphabet, consistent with the geo-fence grid', async () => {
    const hash = await controller.calculateGeohash(10.0, 20.0);
    expect(hash).toMatch(/^[0-9b-hjkmnp-z]{9}$/);
    expect(hash!.startsWith(encodeGeoFenceGrid({ lat: 10.0, lon: 20.0 }, 6))).toBe(true);
  });

  it('is deterministic and location-sensitive (a sha256 prefix would also be, so nearby points must share a prefix)', async () => {
    const a = await controller.calculateGeohash(10.0, 20.0, 7);
    const b = await controller.calculateGeohash(10.0001, 20.0001, 7);
    const far = await controller.calculateGeohash(-40.0, 150.0, 7);
    expect(a!.slice(0, 4)).toBe(b!.slice(0, 4));
    expect(a!.slice(0, 2)).not.toBe(far!.slice(0, 2));
  });

  it.each([
    [NaN, 0], [0, NaN], [91, 0], [-91, 0], [0, 181], [0, -181], [null, 0], [undefined, 0], ['abc', 0],
  ])('invalid coordinates (%p, %p) → null, never a fabricated value', async (lat, lon) => {
    expect(await controller.calculateGeohash(lat as any, lon as any)).toBeNull();
  });

  it('invalid precision → null', async () => {
    expect(await controller.calculateGeohash(10, 20, 0)).toBeNull();
    expect(await controller.calculateGeohash(10, 20, 13)).toBeNull();
  });
});
