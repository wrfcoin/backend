/**
 * OpenAQ Service Tests
 *
 * backend#185: Integrate OpenAQ & PurpleAir Data Sources for Validation
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { OpenAQService } from '../server/services/external-data/openaq.js';

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

const SAMPLE_LOCATIONS_RESPONSE = {
  results: [
    {
      id: 42,
      name: 'Minneapolis AQ Monitor',
      coordinates: { latitude: 44.977, longitude: -93.265 },
      country: { code: 'US' },
      parameters: [
        { id: 2, name: 'pm25', unit: 'µg/m³', lastValue: 12.5, lastUpdated: '2026-03-15T10:00:00Z' },
        { id: 3, name: 'pm10', unit: 'µg/m³', lastValue: 25.0, lastUpdated: '2026-03-15T10:00:00Z' },
      ],
      lastUpdated: '2026-03-15T10:00:00Z',
      distance: 1500,
    },
    {
      id: 99,
      name: 'St Paul Monitor',
      coordinates: { latitude: 44.95, longitude: -93.09 },
      country: { code: 'US' },
      parameters: [
        { id: 2, name: 'pm25', unit: 'µg/m³', lastValue: 8.3, lastUpdated: '2026-03-15T09:30:00Z' },
      ],
      lastUpdated: '2026-03-15T09:30:00Z',
      distance: 5000,
    },
  ],
};

describe('OpenAQService', () => {
  let service: OpenAQService;

  beforeEach(() => {
    mockFetch.mockReset();
    service = new OpenAQService({
      apiKey: 'test-key',
      enabled: true,
      requestsPerMinute: 120,
      requestTimeoutMs: 5000,
      searchRadiusMeters: 25000,
      baseUrl: 'https://api.openaq.org/v3',
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
      const disabled = new OpenAQService({ enabled: false });
      const result = await disabled.getPM25ForArea(44.97, -93.26);
      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns empty array from findNearbyLocations', async () => {
      const disabled = new OpenAQService({ enabled: false });
      const result = await disabled.findNearbyLocations(44.97, -93.26);
      expect(result).toEqual([]);
    });

    it('reports disabled health status', () => {
      const disabled = new OpenAQService({ enabled: false });
      const health = disabled.getHealthStatus();
      expect(health.status).toBe('disabled');
      expect(health.enabled).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Rate limiting
  // --------------------------------------------------------------------------

  describe('rate limiting', () => {
    it('blocks fetch calls when rate limit exceeded', async () => {
      const strict = new OpenAQService({
        enabled: true,
        requestsPerMinute: 3,
        apiKey: 'test',
        baseUrl: 'https://api.openaq.org/v3',
        requestTimeoutMs: 5000,
        searchRadiusMeters: 25000,
      });

      mockFetch.mockResolvedValue(mockJsonResponse({ results: [] }));

      // First 3 requests should call fetch
      await strict.findNearbyLocations(44, -93);
      await strict.findNearbyLocations(44, -93);
      await strict.findNearbyLocations(44, -93);
      expect(mockFetch).toHaveBeenCalledTimes(3);

      // 4th request should NOT call fetch (rate limiter fires before fetch)
      // and should return empty array (graceful degradation)
      const result = await strict.findNearbyLocations(44, -93);
      expect(result).toEqual([]);
      expect(mockFetch).toHaveBeenCalledTimes(3); // still 3, no new fetch

      // Health should reflect the rate limit error
      const health = strict.getHealthStatus();
      expect(health.status).toBe('unhealthy');
      expect(health.error).toMatch(/rate limit exceeded/);
    });
  });

  // --------------------------------------------------------------------------
  // API response parsing
  // --------------------------------------------------------------------------

  describe('findNearbyLocations', () => {
    it('parses API response correctly', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse(SAMPLE_LOCATIONS_RESPONSE));

      const locations = await service.findNearbyLocations(44.977, -93.265);

      expect(locations).toHaveLength(2);
      expect(locations[0]).toEqual(
        expect.objectContaining({
          id: 42,
          name: 'Minneapolis AQ Monitor',
          distance: 1500,
        }),
      );
      expect(locations[0].parameters[0]).toEqual(
        expect.objectContaining({
          name: 'pm25',
          lastValue: 12.5,
        }),
      );
    });

    it('returns empty array on 404', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({}, 404));

      const locations = await service.findNearbyLocations(44.977, -93.265);
      expect(locations).toEqual([]);
    });

    it('returns empty array on 500', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({}, 500));

      const locations = await service.findNearbyLocations(44.977, -93.265);
      expect(locations).toEqual([]);
    });

    it('returns empty array on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const locations = await service.findNearbyLocations(44.977, -93.265);
      expect(locations).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // getPM25ForArea
  // --------------------------------------------------------------------------

  describe('getPM25ForArea', () => {
    it('returns closest station PM2.5 reading', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse(SAMPLE_LOCATIONS_RESPONSE));

      const result = await service.getPM25ForArea(44.977, -93.265);

      expect(result).not.toBeNull();
      expect(result!.pm25).toBe(12.5);
      expect(result!.stationId).toBe(42);
      expect(result!.stationName).toBe('Minneapolis AQ Monitor');
      expect(result!.distanceMeters).toBe(1500);
    });

    it('returns null when no PM2.5 stations nearby', async () => {
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          results: [
            {
              id: 1,
              name: 'NO2 Only Station',
              coordinates: { latitude: 44.97, longitude: -93.26 },
              country: { code: 'US' },
              parameters: [
                { id: 5, name: 'no2', unit: 'ppm', lastValue: 0.02, lastUpdated: '2026-03-15T10:00:00Z' },
              ],
              distance: 100,
            },
          ],
        }),
      );

      const result = await service.getPM25ForArea(44.977, -93.265);
      expect(result).toBeNull();
    });

    it('returns null when API returns no results', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ results: [] }));

      const result = await service.getPM25ForArea(44.977, -93.265);
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
      expect(health.requestsThisMinute).toBe(0);
    });

    it('returns unhealthy after API error', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({}, 500));
      await service.findNearbyLocations(44, -93);

      const health = service.getHealthStatus();
      expect(health.status).toBe('unhealthy');
      expect(health.error).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Timeout handling
  // --------------------------------------------------------------------------

  describe('timeout', () => {
    it('handles AbortController timeout', async () => {
      const fastTimeout = new OpenAQService({
        enabled: true,
        apiKey: 'test',
        requestTimeoutMs: 1, // 1ms timeout
        requestsPerMinute: 120,
        searchRadiusMeters: 25000,
        baseUrl: 'https://api.openaq.org/v3',
      });

      // Simulate a slow response
      mockFetch.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve(mockJsonResponse({ results: [] })), 5000);
          }),
      );

      const result = await fastTimeout.findNearbyLocations(44, -93);
      // Should gracefully return empty array (caught in try/catch)
      expect(result).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // Request headers
  // --------------------------------------------------------------------------

  describe('request headers', () => {
    it('sends X-API-Key header when configured', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ results: [] }));
      await service.findNearbyLocations(44, -93);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      const options = callArgs[1] as RequestInit;
      const headers = options.headers as Record<string, string>;
      expect(headers['X-API-Key']).toBe('test-key');
    });
  });
});
