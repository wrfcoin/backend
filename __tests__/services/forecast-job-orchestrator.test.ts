import { ForecastJobOrchestrator } from '../../server/services/forecast/forecast-job-orchestrator.js';

describe('ForecastJobOrchestrator', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('normalizes recipe payloads and completes lifecycle with CID output', async () => {
    const orchestrator = new ForecastJobOrchestrator();

    const created = orchestrator.submitJob({
      recipe: {
        model: 'WRF',
        forecastHours: 12,
        resolutionKm: 9,
        domainBounds: {
          north: 45,
          south: 30,
          west: -120,
          east: -95,
        },
      },
      datasets: ['gfs', 'terrain'],
      computeEnvironment: 'local-wrf',
      validation: 'standard',
    });

    expect(created.status).toBe('queued');
    expect(created.jobId).toMatch(/^forecast_job_/);

    await jest.runAllTimersAsync();

    const completed = orchestrator.getJob(created.jobId);
    expect(completed).not.toBeNull();
    expect(completed?.status).toBe('completed');
    expect(completed?.progress).toBe(100);
    expect(completed?.outputCid).toMatch(/^bafy[a-f0-9]{48}$/);
    expect(completed?.history.map(item => item.status)).toEqual(
      expect.arrayContaining([
        'queued',
        'preparing_inputs',
        'running_wps',
        'running_wrf',
        'postprocessing',
        'completed',
      ])
    );
  });

  it('fails job when WRF execution throws', async () => {
    const orchestrator = new ForecastJobOrchestrator({
      adapters: {
        runWrf: async () => {
          throw new Error('wrf container launch failed');
        },
      },
    });

    const created = orchestrator.submitJob({
      model: 'WRF',
      forecastHours: 6,
      resolutionKm: 10,
      domainBounds: { north: 40, south: 30, west: -110, east: -90 },
    });

    await jest.runAllTimersAsync();

    const failed = orchestrator.getJob(created.jobId);
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toContain('wrf container launch failed');
  });

  it('rejects invalid domain bounds', () => {
    const orchestrator = new ForecastJobOrchestrator();

    expect(() =>
      orchestrator.submitJob({
        model: 'WRF',
        forecastHours: 6,
        resolutionKm: 10,
        domainBounds: {
          north: 20,
          south: 30,
          west: -120,
          east: -90,
        },
      })
    ).toThrow('domainBounds.north must be greater than domainBounds.south');
  });

  it('rejects out-of-range latitude/longitude', () => {
    const orchestrator = new ForecastJobOrchestrator();

    expect(() =>
      orchestrator.submitJob({
        model: 'WRF',
        forecastHours: 6,
        resolutionKm: 10,
        domainBounds: {
          north: 100,
          south: 30,
          west: -200,
          east: -90,
        },
      })
    ).toThrow('domainBounds latitude values must be between -90 and 90');
  });
});
