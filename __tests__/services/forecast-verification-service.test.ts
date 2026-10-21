import {
  ForecastVerificationRequest,
  ForecastVerificationService,
} from '../../server/services/forecast/forecast-verification-service.js';

function baseRequest(): ForecastVerificationRequest {
  return {
    forecastRef: {
      cid: 'bafyforecast',
      model: 'WRF',
      runId: 'run_49',
    },
    validTimeRange: {
      start: '2026-03-05T12:00:00Z',
      end: '2026-03-05T13:00:00Z',
    },
    domainBounds: {
      north: 41,
      south: 39,
      west: -106,
      east: -104,
    },
    grid: {
      temperature: {
        latitudes: [40, 39.5],
        longitudes: [-105, -104.5],
        values: [
          [21, 19],
          [20, 18],
        ],
      },
      windSpeed: {
        latitudes: [40, 39.5],
        longitudes: [-105, -104.5],
        values: [
          [6, 8],
          [5, 7],
        ],
      },
      precipitation: {
        latitudes: [40, 39.5],
        longitudes: [-105, -104.5],
        values: [
          [0.0, 0.2],
          [0.0, 0.4],
        ],
      },
    },
  };
}

describe('ForecastVerificationService', () => {
  it('computes verification metrics and includes core4-compatible skill inputs', async () => {
    const service = new ForecastVerificationService({
      observationProvider: {
        fetchObservations: async () => [
          {
            stationId: 'STATION_A',
            latitude: 40.0,
            longitude: -105.0,
            timestamp: '2026-03-05T12:00:00Z',
            temperature: 20,
            windSpeed: 5,
            precipitation: 0.0,
          },
          {
            stationId: 'STATION_B',
            latitude: 39.5,
            longitude: -104.5,
            timestamp: '2026-03-05T12:10:00Z',
            temperature: 18,
            windSpeed: 7,
            precipitation: 0.3,
          },
        ],
      },
    });

    const report = await service.verifyForecast(baseRequest());

    expect(report.stationCount).toBe(2);
    expect(report.continuous.temperature.mae).toBeGreaterThan(0);
    expect(report.continuous.windSpeed.rmse).toBeGreaterThan(0);
    expect(report.categorical.precipitation).toHaveLength(3);
    expect(report.skillInputs.brier_score).toBeGreaterThanOrEqual(0);
    expect(report.skillInputs.brier_score).toBeLessThanOrEqual(1);
    expect(report.skillInputs.crps_score).toBeGreaterThanOrEqual(0);
    expect(report.skillInputs.crps_score).toBeLessThanOrEqual(1);
    expect(report.brier_score).toBe(report.skillInputs.brier_score);
    expect(report.crps_score).toBe(report.skillInputs.crps_score);
    expect(report.reportHash).toMatch(/^[a-f0-9]{64}$/);
    expect(report.reportId).toBe(`fvr_${report.reportHash.slice(0, 16)}`);
  });

  it('is deterministic for hash/id on identical inputs', async () => {
    const provider = {
      fetchObservations: async () => [
        {
          stationId: 'STATION_A',
          latitude: 40.0,
          longitude: -105.0,
          timestamp: '2026-03-05T12:00:00Z',
          temperature: 20,
          windSpeed: 5,
          precipitation: 0.2,
        },
      ],
    };

    const service = new ForecastVerificationService({ observationProvider: provider });
    const request = baseRequest();

    const first = await service.verifyForecast(request);
    const second = await service.verifyForecast(request);

    expect(first.reportHash).toBe(second.reportHash);
    expect(first.reportId).toBe(second.reportId);
  });

  it('rejects invalid grid dimensions', async () => {
    const service = new ForecastVerificationService({
      observationProvider: {
        fetchObservations: async () => [
          {
            stationId: 'STATION_A',
            latitude: 40.0,
            longitude: -105.0,
            timestamp: '2026-03-05T12:00:00Z',
            temperature: 20,
            windSpeed: 5,
            precipitation: 0.0,
          },
        ],
      },
    });

    const request = baseRequest();
    request.grid.temperature.values = [[21]];

    await expect(service.verifyForecast(request)).rejects.toThrow(
      'grid.temperature.values row count must match latitudes length'
    );
  });

  it('filters out-of-window/out-of-domain observations and dedupes by station+timestamp', async () => {
    const service = new ForecastVerificationService({
      observationProvider: {
        fetchObservations: async () => [
          {
            stationId: 'GOOD',
            latitude: 40.0,
            longitude: -105.0,
            timestamp: '2026-03-05T12:00:00Z',
            temperature: 20,
            windSpeed: 5,
            precipitation: 0.1,
          },
          {
            stationId: 'GOOD',
            latitude: 40.0,
            longitude: -105.0,
            timestamp: '2026-03-05T12:00:00Z',
            temperature: 20,
            windSpeed: 5,
            precipitation: 0.1,
          },
          {
            stationId: 'OLD',
            latitude: 40.0,
            longitude: -105.0,
            timestamp: '2026-03-04T00:00:00Z',
            temperature: 21,
            windSpeed: 6,
            precipitation: 0.0,
          },
          {
            stationId: 'OOB',
            latitude: 50.0,
            longitude: -105.0,
            timestamp: '2026-03-05T12:05:00Z',
            temperature: 21,
            windSpeed: 6,
            precipitation: 0.0,
          },
        ],
      },
    });

    const report = await service.verifyForecast(baseRequest());

    expect(report.stationCount).toBe(1);
    expect(report.qualityControl.rawObservationCount).toBe(4);
    expect(report.qualityControl.qcRejectedCount).toBe(3);
    expect(report.qualityControl.uniqueStationCount).toBe(1);
  });

  it('rejects caller-provided observation overrides by default', async () => {
    const service = new ForecastVerificationService({
      observationProvider: {
        fetchObservations: async () => [],
      },
    });

    const request = baseRequest();
    request.observations = [
      {
        stationId: 'OVERRIDE',
        latitude: 40.0,
        longitude: -105.0,
        timestamp: '2026-03-05T12:00:00Z',
        temperature: 20,
        windSpeed: 5,
        precipitation: 0,
      },
    ];

    await expect(service.verifyForecast(request)).rejects.toThrow(
      'observations override is not allowed'
    );
  });

  it('classifies empty provider results as upstream unavailability', async () => {
    const service = new ForecastVerificationService({
      observationProvider: {
        fetchObservations: async () => [],
      },
    });

    await expect(service.verifyForecast(baseRequest())).rejects.toThrow(
      'No usable NOAA observations found'
    );
  });
});
