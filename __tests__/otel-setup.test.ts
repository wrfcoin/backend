const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.mock('../server/utils/logger.js', () => ({
  appLogger: mockLogger,
}));

describe('otel setup', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      OTEL_ENABLED: 'true',
      OTEL_DEBUG: 'false',
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('skips optional instrumentation cleanly when OTel dependencies are absent', async () => {
    const dependencyError = Object.assign(
      new Error("Cannot find package '@opentelemetry/auto-instrumentations-node'"),
      { code: 'ERR_MODULE_NOT_FOUND' }
    );
    const dependencyLoader = jest.fn().mockRejectedValue(dependencyError);
    const otelSetup = require('../server/utils/otel-setup.js');

    otelSetup.__setOTelDependencyLoaderForTests(dependencyLoader);

    await expect(otelSetup.initializeOTel()).resolves.toBeNull();
    await expect(otelSetup.initializeOTel()).resolves.toBeNull();

    expect(dependencyLoader).toHaveBeenCalledTimes(1);
    expect(otelSetup.getOTelInitializationState()).toBe('skipped_missing_dependencies');
    expect(mockLogger.info).toHaveBeenCalledWith(
      'OpenTelemetry dependencies unavailable; skipping instrumentation',
      expect.objectContaining({
        error: expect.stringContaining('@opentelemetry/auto-instrumentations-node'),
      })
    );
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();

    otelSetup.__resetOTelForTests();
  });

  it('initializes once and reuses the same SDK when dependencies are present', async () => {
    const start = jest.fn().mockResolvedValue(undefined);
    const shutdown = jest.fn().mockResolvedValue(undefined);
    const dependencyLoader = jest.fn().mockResolvedValue({
      NodeSDK: class FakeNodeSDK {
        public config: Record<string, unknown>;

        constructor(config: Record<string, unknown>) {
          this.config = config;
        }

        start = start;
        shutdown = shutdown;
      },
      BatchSpanProcessor: class FakeBatchSpanProcessor {
        constructor(public exporter: unknown) {}
      },
      getNodeAutoInstrumentations: jest.fn().mockReturnValue(['instrumentations']),
      OTLPTraceExporter: class FakeTraceExporter {
        constructor(public config: Record<string, unknown>) {}
      },
      OTLPMetricExporter: class FakeMetricExporter {
        constructor(public config: Record<string, unknown>) {}
      },
      PrometheusExporter: class FakePrometheusExporter {
        constructor(public config: Record<string, unknown>) {}
      },
      PeriodicExportingMetricReader: class FakeMetricReader {
        constructor(public config: Record<string, unknown>) {}
      },
      Resource: class FakeResource {
        constructor(public attributes: Record<string, unknown>) {}
      },
      semanticAttributes: {
        SEMRESATTRS_SERVICE_NAME: 'service.name',
        SEMRESATTRS_SERVICE_VERSION: 'service.version',
        SEMRESATTRS_DEPLOYMENT_ENVIRONMENT: 'deployment.environment',
      },
      diag: {
        setLogger: jest.fn(),
      },
      DiagConsoleLogger: class FakeDiagConsoleLogger {},
      DiagLogLevel: {
        DEBUG: 'debug',
      },
    });
    const otelSetup = require('../server/utils/otel-setup.js');

    otelSetup.__setOTelDependencyLoaderForTests(dependencyLoader);

    const [first, second] = await Promise.all([
      otelSetup.initializeOTel(),
      otelSetup.initializeOTel(),
    ]);

    expect(first).toBe(second);
    expect(dependencyLoader).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(otelSetup.getOTelInitializationState()).toBe('initialized');
    expect(mockLogger.info).toHaveBeenCalledWith(
      'OpenTelemetry instrumentation initialized',
      expect.objectContaining({
        serviceName: expect.any(String),
        prometheusPort: expect.any(Number),
      })
    );

    await otelSetup.shutdownOTel();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(otelSetup.getOTelInitializationState()).toBe('idle');

    otelSetup.__resetOTelForTests();
  });
});
