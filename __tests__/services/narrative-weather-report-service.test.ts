import {
  NarrativeWeatherReportService,
} from '../../server/services/weather/narrative-weather-report-service.js';

describe('NarrativeWeatherReportService', () => {
  it('generates deterministic report with required sections', async () => {
    const service = new NarrativeWeatherReportService({
      weatherProvider: {
        getCurrentConditions: async () => ({
          stationId: 'KSEA',
          observedAt: '2026-03-05T12:00:00Z',
          temperatureF: 58,
          humidity: 68,
          windMph: 9,
          conditionText: 'light rain',
        }),
      },
      forecastProvider: {
        getShortTermOutlook: async () => ({
          periodHours: 24,
          expectedHighF: 62,
          expectedLowF: 49,
          precipitationChance: 0.7,
          dominantConditions: 'Showers',
        }),
      },
      alertsProvider: {
        getActiveAlerts: async () => [
          {
            id: 'ALERT1',
            event: 'Flood Watch',
            type: 'flood',
            severityClass: 'watch',
          },
        ] as any,
      },
      nowFn: () => new Date('2026-03-05T12:00:00Z'),
    });

    const report = await service.generateReport({
      stationId: 'KSEA',
      style: 'standard',
    });

    expect(report.metadata.deterministic).toBe(true);
    expect(report.report.currentConditions).toContain('KSEA');
    expect(report.report.shortTermOutlook).toContain('24 hours');
    expect(report.report.activeAlertHighlights).toContain('active alert');
    expect(report.report.fullText.length).toBeGreaterThan(50);
  });

  it('supports optional llm enhancement when enhancer exists', async () => {
    const service = new NarrativeWeatherReportService({
      llmEnhancer: {
        enhance: async ({ text }) => `${text} [enhanced]`,
      },
      nowFn: () => new Date('2026-03-05T12:00:00Z'),
    });

    const report = await service.generateReport({
      stationId: 'KSFO',
      style: 'brief',
      enhanceWithLlm: true,
    });

    expect(report.metadata.llmEnhanced).toBe(true);
    expect(report.report.fullText).toContain('[enhanced]');
  });

  it('rejects requests without station or region', async () => {
    const service = new NarrativeWeatherReportService();

    await expect(
      service.generateReport({
        style: 'brief',
      })
    ).rejects.toThrow('Either stationId or regionBounds is required');
  });
});
