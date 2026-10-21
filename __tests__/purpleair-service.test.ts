/**
 * PurpleAir Service Tests
 *
 * backend#185: Integrate OpenAQ & PurpleAir Data Sources for Validation
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import {
  PurpleAirService,
  decodeGeohashBounds,
} from '../server/services/external-data/purpleair.js';
import {
  encodeGeoFenceGrid,
} from '../shared/iot-gateway-geofence-service.js';

// Mock global fetch
const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
(global as any).fetch = mockFetch;

// Suppress logger output in tests
jest.mock('../server/utils/logger', () => ({
  weatherLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

function mockJsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(data),
    headers: new Headers(),
    redirected: false,
    type: 'basic',
    url: '',
    body: null,
    bodyUsed: false,
    clone: () => ({} as Response),
    text: () => Promise.resolve(''),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    blob: () => Promise.resolve(new Blob()),
    formData: () => Promise.resolve(new FormData()),
  } as Response;
}

const SAMPLE_SENSORS_RESPONSE = {
  fields: ['sensor_index', 'name', 'latitude', 'longitude', 'pm2.5', 'humidity', 'temperature', 'pressure', 'last_seen'],
  data: [
    [1001, 'Backyard Sensor', 44.98, -93.27, 15.2, 65, 72, 1013.2, Math.floor(Date.now() / 1000) - 300],
    [1002, 'Rooftop Unit', 44.97, -93.25, 18.7, 60, 68, 1012.8, Math.floor(Date.now() / 1000) - 600],
    [1003, 'Park Station', 44.96, -93.28, 12.1, 70, 75, 1013.5, Math.floor(Date.now() / 1000) - 900],
  ],
};

describe('PurpleAirService', () => {
  let service: PurpleAirService;

  beforeEach(() => {
    mockFetch.mockReset();
    service = new PurpleAirService({
      apiKey: 'test-key',
      enabled: true,
      requestsPerMinute: 10, // relaxed for tests
      requestTimeoutMs: 5000,
      baseUrl: 'https://api.purpleair.com',
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // Disabled service
  // --------------------------------------------------------------------------

  describe('when disabled', () => {
    it('returns null from getPM25ForArea immediately', async () => {
      const disabled = new PurpleAirService({ enabled: false });
      const result = await disabled.getPM25ForArea(44.97, -93.26);
      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns empty array from getSensorsInBounds', async () => {
      const disabled = new PurpleAirService({ enabled: false });
      const result = await disabled.getSensorsInBounds(45, -94, 44, -93);
      expect(result).toEqual([]);
    });

    it('reports disabled health status', () => {
      const disabled = new PurpleAirService({ enabled: false });
      const health = disabled.getHealthStatus();
      expect(health.status).toBe('disabled');
      expect(health.enabled).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Rate limiting
  // --------------------------------------------------------------------------

  describe('rate limiting', () => {
    it('enforces 1 req/min for free tier', async () => {
      const strict = new PurpleAirService({
        enabled: true,
        requestsPerMinute: 1,
        apiKey: 'test',
        baseUrl: 'https://api.purpleair.com',
        requestTimeoutMs: 5000,
      });

      mockFetch.mockResolvedValue(mockJsonResponse({ fields: [], data: [] }));

      // First request should call fetch
      await strict.getSensorsInBounds(45, -94, 44, -93);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Second request should NOT call fetch (rate limiter blocks before fetch)
      const result = await strict.getSensorsInBounds(45, -94, 44, -93);
      expect(result).toEqual([]);
      expect(mockFetch).toHaveBeenCalledTimes(1); // still 1

      // Health should reflect rate limit error
      const health = strict.getHealthStatus();
      expect(health.status).toBe('unhealthy');
      expect(health.error).toMatch(/rate limit exceeded/);
    });
  });

  // --------------------------------------------------------------------------
  // getSensorsInBounds
  // --------------------------------------------------------------------------

  describe('getSensorsInBounds', () => {
    it('builds correct query params', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ fields: [], data: [] }));
      await service.getSensorsInBounds(45.0, -94.0, 44.0, -93.0);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('nwlng=-94');
      expect(url).toContain('nwlat=45');
      expect(url).toContain('selng=-93');
      expect(url).toContain('selat=44');
      expect(url).toContain('fields=');
    });

    it('parses sensor data correctly', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse(SAMPLE_SENSORS_RESPONSE));
      const sensors = await service.getSensorsInBounds(45, -94, 44, -93);

      expect(sensors).toHaveLength(3);
      expect(sensors[0]).toEqual(
        expect.objectContaining({
          sensorIndex: 1001,
          name: 'Backyard Sensor',
          pm25: 15.2,
        }),
      );
    });

    it('converts temperature from Fahrenheit to Celsius', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse(SAMPLE_SENSORS_RESPONSE));
      const sensors = await service.getSensorsInBounds(45, -94, 44, -93);

      // 72°F = 22.22°C
      expect(sensors[0].temperatureC).toBeCloseTo(22.22, 1);
      // 68°F = 20°C
      expect(sensors[1].temperatureC).toBeCloseTo(20, 1);
    });
  });

  // --------------------------------------------------------------------------
  // getPM25ForArea
  // --------------------------------------------------------------------------

  describe('getPM25ForArea', () => {
    it('averages PM2.5 across multiple sensors', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse(SAMPLE_SENSORS_RESPONSE));
      const result = await service.getPM25ForArea(44.97, -93.26);

      expect(result).not.toBeNull();
      // Average of 15.2, 18.7, 12.1 = 15.33
      expect(result!.pm25).toBeCloseTo(15.33, 1);
      expect(result!.sensorCount).toBe(3);
    });

    it('returns null when no sensors found', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ fields: [], data: [] }));
      const result = await service.getPM25ForArea(44.97, -93.26);
      expect(result).toBeNull();
    });

    it('filters out stale sensors (>2h old)', async () => {
      const staleResponse = {
        fields: SAMPLE_SENSORS_RESPONSE.fields,
        data: [
          [1001, 'Fresh', 44.98, -93.27, 15.0, 65, 72, 1013.2, Math.floor(Date.now() / 1000) - 300],
          [1002, 'Stale', 44.97, -93.25, 99.9, 60, 68, 1012.8, Math.floor(Date.now() / 1000) - 8000],
        ],
      };
      mockFetch.mockResolvedValueOnce(mockJsonResponse(staleResponse));
      const result = await service.getPM25ForArea(44.97, -93.26);

      expect(result).not.toBeNull();
      expect(result!.pm25).toBe(15.0);
      expect(result!.sensorCount).toBe(1);
    });

    it('returns null when all sensors are stale', async () => {
      const allStale = {
        fields: SAMPLE_SENSORS_RESPONSE.fields,
        data: [
          [1001, 'Old', 44.98, -93.27, 15.0, 65, 72, 1013.2, Math.floor(Date.now() / 1000) - 10000],
        ],
      };
      mockFetch.mockResolvedValueOnce(mockJsonResponse(allStale));
      const result = await service.getPM25ForArea(44.97, -93.26);
      expect(result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Health status
  // --------------------------------------------------------------------------

  describe('getHealthStatus', () => {
    it('returns healthy when enabled and no errors', () => {
      const health = service.getHealthStatus();
      expect(health.status).toBe('healthy');
      expect(health.enabled).toBe(true);
    });

    it('returns unhealthy after API error', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({}, 500));
      await service.getSensorsInBounds(45, -94, 44, -93);

      const health = service.getHealthStatus();
      expect(health.status).toBe('unhealthy');
      expect(health.error).toBeDefined();
    });
  });
});

// ============================================================================
// Geohash decoding tests
// ============================================================================

describe('decodeGeohashBounds', () => {
  it('round-trips with encodeGeoFenceGrid', () => {
    const testCases = [
      { lat: 44.977, lon: -93.265 },   // Minneapolis
      { lat: 40.7128, lon: -74.006 },   // New York
      { lat: 51.5074, lon: -0.1278 },   // London
      { lat: -33.8688, lon: 151.2093 }, // Sydney
      { lat: 0, lon: 0 },               // Null Island
    ];

    for (const { lat, lon } of testCases) {
      const hash = encodeGeoFenceGrid({ lat, lon }, 6);
      const bounds = decodeGeohashBounds(hash);

      // The original point should be inside the decoded bounding box
      expect(lat).toBeGreaterThanOrEqual(bounds.seLat);
      expect(lat).toBeLessThanOrEqual(bounds.nwLat);
      expect(lon).toBeGreaterThanOrEqual(bounds.nwLng);
      expect(lon).toBeLessThanOrEqual(bounds.seLng);

      // Center should be close to the original point (within ~1km for precision 6)
      expect(Math.abs(bounds.centerLat - lat)).toBeLessThan(0.01);
      expect(Math.abs(bounds.centerLng - lon)).toBeLessThan(0.02);
    }
  });

  it('throws on invalid geohash characters', () => {
    expect(() => decodeGeohashBounds('abc!xy')).toThrow(/Invalid geohash character/);
  });

  it('higher precision gives tighter bounds', () => {
    const coarse = decodeGeohashBounds('9zvb');
    const fine = decodeGeohashBounds('9zvbp6');

    const coarseArea = (coarse.nwLat - coarse.seLat) * (coarse.seLng - coarse.nwLng);
    const fineArea = (fine.nwLat - fine.seLat) * (fine.seLng - fine.nwLng);

    expect(fineArea).toBeLessThan(coarseArea);
  });
});
