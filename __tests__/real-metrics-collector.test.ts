import * as realMetrics from '../performance/real-metrics-collector.js';
import * as dashboardMetrics from '../performance/dashboard-metrics.js';

describe('real-metrics-collector', () => {
  afterEach(() => {
    realMetrics.stopMetricsCollection();
    realMetrics.resetMetrics();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('uses a 60 second default collection interval', () => {
    jest.useFakeTimers();
    const setIntervalSpy = jest.spyOn(global, 'setInterval');

    realMetrics.startMetricsCollection();

    expect(setIntervalSpy).toHaveBeenCalledWith(
      expect.any(Function),
      realMetrics.DEFAULT_COLLECTION_INTERVAL_MS
    );
  });

  it('keeps the consolidated Task 84 metric surface under the ceiling', async () => {
    await dashboardMetrics.collectDashboardMetrics();

    const metrics = await realMetrics.performanceRegistry.getMetricsAsJSON();
    const names = metrics.map(metric => metric.name);

    expect(names.length).toBeLessThanOrEqual(25);
    expect(names).toContain('wrfcoin_system_memory_usage_percent');
    expect(names).toContain('wrfcoin_tracing_span_duration_seconds');
    expect(names).not.toContain('wrfcoin_security_events_total');
    expect(names).not.toContain('wrfcoin_cross_chain_bridge_transfers_initiated_total');
  });
});
