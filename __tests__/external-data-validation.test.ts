/**
 * External Data Validation Job Tests
 *
 * backend#185: Integrate OpenAQ & PurpleAir Data Sources for Validation
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import {
  ExternalDataValidationJob,
  computeDeviation,
  computeReferenceValue,
  classifyDeviation,
  deviationToDataQualityScore,
} from '../server/jobs/external-data-validation.js';
import type { OpenAQService } from '../server/services/external-data/openaq.js';
import type { PurpleAirService } from '../server/services/external-data/purpleair.js';

// Suppress logger output
jest.mock('../server/utils/logger', () => ({
  weatherLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock route-durable-store
const mockRecords: Record<string, any> = {};
jest.mock('../shared/route-durable-store', () => ({
  routeDurableStore: {
    read: jest.fn((fn: any) =>
      fn({
        weather: { records: mockRecords },
      }),
    ),
  },
}));

function createMockOpenAQ(overrides: Partial<OpenAQService> = {}): OpenAQService {
  return {
    enabled: false,
    getPM25ForArea: jest.fn<any>().mockResolvedValue(null),
    findNearbyLocations: jest.fn<any>().mockResolvedValue([]),
    getLatestMeasurements: jest.fn<any>().mockResolvedValue([]),
    getHealthStatus: jest.fn<any>().mockReturnValue({ status: 'disabled', enabled: false }),
    ...overrides,
  } as unknown as OpenAQService;
}

function createMockPurpleAir(overrides: Partial<PurpleAirService> = {}): PurpleAirService {
  return {
    enabled: false,
    getPM25ForArea: jest.fn<any>().mockResolvedValue(null),
    getSensorsInBounds: jest.fn<any>().mockResolvedValue([]),
    getSensorsForGeohash: jest.fn<any>().mockResolvedValue([]),
    getHealthStatus: jest.fn<any>().mockReturnValue({ status: 'disabled', enabled: false }),
    ...overrides,
  } as unknown as PurpleAirService;
}

// ============================================================================
// Pure function tests
// ============================================================================

describe('computeDeviation', () => {
  it('returns 0% for exact match', () => {
    const result = computeDeviation(25, 25);
    expect(result.deviationPercent).toBe(0);
    expect(result.confidence).toBe(1.0);
  });

  it('returns 100% for double the reference', () => {
    const result = computeDeviation(50, 25);
    expect(result.deviationPercent).toBe(100);
  });

  it('returns 50% for half deviation', () => {
    const result = computeDeviation(37.5, 25);
    expect(result.deviationPercent).toBe(50);
  });

  it('handles zero reference', () => {
    const result = computeDeviation(10, 0);
    expect(result.deviationPercent).toBe(100);
    expect(result.confidence).toBe(0.5);
  });

  it('handles both zero', () => {
    const result = computeDeviation(0, 0);
    expect(result.deviationPercent).toBe(0);
  });
});

describe('computeReferenceValue', () => {
  it('weights OpenAQ 70% and PurpleAir 30% when both available', () => {
    const result = computeReferenceValue(20, 30);
    // 0.7 * 20 + 0.3 * 30 = 14 + 9 = 23
    expect(result.value).toBe(23);
    expect(result.source).toBe('average');
  });

  it('returns OpenAQ value alone', () => {
    const result = computeReferenceValue(20, null);
    expect(result.value).toBe(20);
    expect(result.source).toBe('openaq');
  });

  it('returns PurpleAir value alone', () => {
    const result = computeReferenceValue(null, 30);
    expect(result.value).toBe(30);
    expect(result.source).toBe('purpleair');
  });

  it('returns null when neither available', () => {
    const result = computeReferenceValue(null, null);
    expect(result.value).toBeNull();
    expect(result.source).toBeNull();
  });
});

describe('classifyDeviation', () => {
  it('classifies <10% as excellent', () => {
    expect(classifyDeviation(5)).toBe('excellent');
    expect(classifyDeviation(9.9)).toBe('excellent');
  });

  it('classifies 10-25% as acceptable', () => {
    expect(classifyDeviation(10)).toBe('acceptable');
    expect(classifyDeviation(24.9)).toBe('acceptable');
  });

  it('classifies 25-50% as warning', () => {
    expect(classifyDeviation(25)).toBe('warning');
    expect(classifyDeviation(49.9)).toBe('warning');
  });

  it('classifies >50% as anomaly', () => {
    expect(classifyDeviation(50)).toBe('anomaly');
    expect(classifyDeviation(200)).toBe('anomaly');
  });
});

describe('deviationToDataQualityScore', () => {
  it('returns 95 for excellent', () => {
    expect(deviationToDataQualityScore('excellent')).toBe(95);
  });

  it('returns 10 for anomaly', () => {
    expect(deviationToDataQualityScore('anomaly')).toBe(10);
  });
});

// ============================================================================
// Job tests
// ============================================================================

describe('ExternalDataValidationJob', () => {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

  beforeEach(() => {
    // Clear mock records
    Object.keys(mockRecords).forEach(k => delete mockRecords[k]);
  });

  describe('when both services disabled', () => {
    it('skips all records and returns early', async () => {
      mockRecords['rec-1'] = {
        stationId: 'station-a',
        timestamp: now.toISOString(),
        airQuality: 25,
        latitude: 44.97,
        longitude: -93.26,
      };

      const job = new ExternalDataValidationJob(
        createMockOpenAQ(),
        createMockPurpleAir(),
      );

      const result = await job.runValidation(oneHourAgo, now);
      expect(result.recordsScanned).toBe(0);
      expect(result.recordsValidated).toBe(0);
    });
  });

  describe('with OpenAQ enabled', () => {
    it('validates records with airQuality against reference data', async () => {
      mockRecords['rec-1'] = {
        stationId: 'station-a',
        timestamp: now.toISOString(),
        airQuality: 12,
        latitude: 44.97,
        longitude: -93.26,
      };

      const openaq = createMockOpenAQ({
        enabled: true,
        getPM25ForArea: jest.fn<any>().mockResolvedValue({
          pm25: 12.5,
          stationId: 42,
          stationName: 'Test Station',
          distanceMeters: 1500,
          measuredAt: now.toISOString(),
        }),
      });

      const job = new ExternalDataValidationJob(openaq, createMockPurpleAir());
      const result = await job.runValidation(oneHourAgo, now);

      expect(result.recordsValidated).toBe(1);
      expect(result.results[0].status).toBe('excellent'); // <10% deviation
      expect(result.results[0].referenceSource).toBe('openaq');
    });

    it('detects anomalies with >50% deviation', async () => {
      mockRecords['rec-2'] = {
        stationId: 'station-b',
        timestamp: now.toISOString(),
        airQuality: 100,
        latitude: 44.97,
        longitude: -93.26,
      };

      const openaq = createMockOpenAQ({
        enabled: true,
        getPM25ForArea: jest.fn<any>().mockResolvedValue({
          pm25: 12.5,
          stationId: 42,
          stationName: 'Test Station',
          distanceMeters: 1500,
          measuredAt: now.toISOString(),
        }),
      });

      const job = new ExternalDataValidationJob(openaq, createMockPurpleAir());
      const result = await job.runValidation(oneHourAgo, now);

      expect(result.deviationsDetected).toBe(1);
      expect(result.results[0].status).toBe('anomaly');
    });
  });

  describe('reputation signal emission', () => {
    it('emits signal on deviation', async () => {
      mockRecords['rec-3'] = {
        stationId: 'station-c',
        timestamp: now.toISOString(),
        airQuality: 80,
        latitude: 44.97,
        longitude: -93.26,
      };

      const openaq = createMockOpenAQ({
        enabled: true,
        getPM25ForArea: jest.fn<any>().mockResolvedValue({
          pm25: 12,
          stationId: 42,
          stationName: 'Test',
          distanceMeters: 1000,
          measuredAt: now.toISOString(),
        }),
      });

      const mockSignal = jest.fn<any>().mockResolvedValue({});
      const job = new ExternalDataValidationJob(openaq, createMockPurpleAir(), mockSignal);
      await job.runValidation(oneHourAgo, now);

      expect(mockSignal).toHaveBeenCalledTimes(1);
      const signal = mockSignal.mock.calls[0][0];
      expect(signal.eventType).toBe('ExternalDataValidation');
      expect(signal.role).toBe('collector');
      expect(signal.address).toBe('station-c');
      expect(signal.details.validationStatus).toBe('anomaly');
    });

    it('emits signal for excellent readings too', async () => {
      mockRecords['rec-4'] = {
        stationId: 'station-d',
        timestamp: now.toISOString(),
        airQuality: 12,
        latitude: 44.97,
        longitude: -93.26,
      };

      const openaq = createMockOpenAQ({
        enabled: true,
        getPM25ForArea: jest.fn<any>().mockResolvedValue({
          pm25: 12.5,
          stationId: 42,
          stationName: 'Test',
          distanceMeters: 1000,
          measuredAt: now.toISOString(),
        }),
      });

      const mockSignal = jest.fn<any>().mockResolvedValue({});
      const job = new ExternalDataValidationJob(openaq, createMockPurpleAir(), mockSignal);
      await job.runValidation(oneHourAgo, now);

      expect(mockSignal).toHaveBeenCalledTimes(1);
      expect(mockSignal.mock.calls[0][0].dataQuality).toBe(95);
    });
  });

  describe('error isolation', () => {
    it('continues processing when API rejects for one record', async () => {
      mockRecords['rec-5'] = {
        stationId: 'station-fail',
        timestamp: now.toISOString(),
        airQuality: 25,
        latitude: 44.97,
        longitude: -93.26,
      };
      mockRecords['rec-6'] = {
        stationId: 'station-ok',
        timestamp: now.toISOString(),
        airQuality: 20,
        latitude: 44.98,
        longitude: -93.25,
      };

      const openaq = createMockOpenAQ({
        enabled: true,
        getPM25ForArea: jest.fn<any>()
          // First record: API rejects → Promise.allSettled absorbs → no_reference
          .mockRejectedValueOnce(new Error('API exploded'))
          // Second record: API succeeds → validated
          .mockResolvedValueOnce({
            pm25: 20,
            stationId: 42,
            stationName: 'Test',
            distanceMeters: 1000,
            measuredAt: now.toISOString(),
          }),
      });

      const job = new ExternalDataValidationJob(openaq, createMockPurpleAir());
      const result = await job.runValidation(oneHourAgo, now);

      // Both records processed (allSettled absorbs API failure gracefully)
      expect(result.recordsValidated).toBe(2);
      expect(result.recordsFailed).toBe(0);

      // First record gets no_reference (API failed), second gets excellent
      const firstResult = result.results.find(r => r.stationId === 'station-fail');
      const secondResult = result.results.find(r => r.stationId === 'station-ok');
      expect(firstResult?.status).toBe('no_reference');
      expect(secondResult?.status).toBe('excellent');
    });
  });

  describe('records without airQuality', () => {
    it('skips records that lack airQuality field', async () => {
      mockRecords['rec-7'] = {
        stationId: 'station-e',
        timestamp: now.toISOString(),
        temperature: 22,
        humidity: 65,
        latitude: 44.97,
        longitude: -93.26,
      };

      const openaq = createMockOpenAQ({ enabled: true });
      const job = new ExternalDataValidationJob(openaq, createMockPurpleAir());
      const result = await job.runValidation(oneHourAgo, now);

      expect(result.recordsSkipped).toBe(1);
      expect(result.recordsValidated).toBe(0);
    });

    it('skips records that lack lat/lon', async () => {
      mockRecords['rec-8'] = {
        stationId: 'station-f',
        timestamp: now.toISOString(),
        airQuality: 25,
        // no lat/lon
      };

      const openaq = createMockOpenAQ({ enabled: true });
      const job = new ExternalDataValidationJob(openaq, createMockPurpleAir());
      const result = await job.runValidation(oneHourAgo, now);

      expect(result.recordsSkipped).toBe(1);
    });
  });

  describe('no_reference status', () => {
    it('reports no_reference when external APIs return nothing', async () => {
      mockRecords['rec-9'] = {
        stationId: 'station-g',
        timestamp: now.toISOString(),
        airQuality: 25,
        latitude: 44.97,
        longitude: -93.26,
      };

      const openaq = createMockOpenAQ({
        enabled: true,
        getPM25ForArea: jest.fn<any>().mockResolvedValue(null),
      });

      const job = new ExternalDataValidationJob(openaq, createMockPurpleAir());
      const result = await job.runValidation(oneHourAgo, now);

      expect(result.recordsValidated).toBe(1);
      expect(result.results[0].status).toBe('no_reference');
    });
  });

  describe('getValidationResults', () => {
    it('returns stored results for a station', async () => {
      mockRecords['rec-10'] = {
        stationId: 'station-h',
        timestamp: now.toISOString(),
        airQuality: 15,
        latitude: 44.97,
        longitude: -93.26,
      };

      const openaq = createMockOpenAQ({
        enabled: true,
        getPM25ForArea: jest.fn<any>().mockResolvedValue({
          pm25: 14,
          stationId: 42,
          stationName: 'Test',
          distanceMeters: 500,
          measuredAt: now.toISOString(),
        }),
      });

      const job = new ExternalDataValidationJob(openaq, createMockPurpleAir());
      await job.runValidation(oneHourAgo, now);

      const results = job.getValidationResults('station-h');
      expect(results).toHaveLength(1);
      expect(results[0].stationId).toBe('station-h');
      expect(results[0].status).toBe('excellent');
    });

    it('returns empty array for unknown station', () => {
      const job = new ExternalDataValidationJob(
        createMockOpenAQ(),
        createMockPurpleAir(),
      );
      const results = job.getValidationResults('nonexistent');
      expect(results).toEqual([]);
    });

    it('filters by status', async () => {
      mockRecords['rec-11'] = {
        stationId: 'station-i',
        timestamp: now.toISOString(),
        airQuality: 15,
        latitude: 44.97,
        longitude: -93.26,
      };

      const openaq = createMockOpenAQ({
        enabled: true,
        getPM25ForArea: jest.fn<any>().mockResolvedValue({
          pm25: 14,
          stationId: 42,
          stationName: 'Test',
          distanceMeters: 500,
          measuredAt: now.toISOString(),
        }),
      });

      const job = new ExternalDataValidationJob(openaq, createMockPurpleAir());
      await job.runValidation(oneHourAgo, now);

      // Should find the excellent result
      const excellent = job.getValidationResults('station-i', 'excellent');
      expect(excellent).toHaveLength(1);

      // Should not find anomaly results
      const anomaly = job.getValidationResults('station-i', 'anomaly');
      expect(anomaly).toHaveLength(0);
    });
  });

  describe('weighted reference with both sources', () => {
    it('uses 70/30 weighting', async () => {
      mockRecords['rec-12'] = {
        stationId: 'station-j',
        timestamp: now.toISOString(),
        airQuality: 23, // matches the weighted reference exactly
        latitude: 44.97,
        longitude: -93.26,
      };

      const openaq = createMockOpenAQ({
        enabled: true,
        getPM25ForArea: jest.fn<any>().mockResolvedValue({
          pm25: 20,
          stationId: 42,
          stationName: 'Ref',
          distanceMeters: 1000,
          measuredAt: now.toISOString(),
        }),
      });

      const purpleair = createMockPurpleAir({
        enabled: true,
        getPM25ForArea: jest.fn<any>().mockResolvedValue({
          pm25: 30,
          sensorCount: 3,
          avgDistanceMeters: 2000,
          measuredAt: now.toISOString(),
        }),
      });

      const job = new ExternalDataValidationJob(openaq, purpleair);
      const result = await job.runValidation(oneHourAgo, now);

      expect(result.results[0].referenceValue).toBe(23); // 0.7*20 + 0.3*30
      expect(result.results[0].referenceSource).toBe('average');
      expect(result.results[0].status).toBe('excellent');
    });
  });
});
